#!/usr/bin/env python3
"""Exercise the real Hermes HTTP adapter with deterministic, credential-free agents.

Run with Hermes' Python: python scripts/test-hermes-compat.py /path/to/hermes.
No Hermes installation is a failure, never a skipped compatibility check.
"""
import asyncio
import base64
import copy
import json
import os
import socket
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if len(sys.argv) < 2:
    raise SystemExit("Usage: python scripts/test-hermes-compat.py <hermes-source>")
HERMES = Path(sys.argv.pop(1)).resolve()
if not (HERMES / "gateway/platforms/api_server.py").is_file():
    raise SystemExit("Hermes source is required; compatibility checks cannot skip")
PROFILE = tempfile.TemporaryDirectory(prefix="servant-hermes-contract-")
os.environ["HERMES_HOME"] = PROFILE.name
os.environ.pop("HERMES_KANBAN_TASK", None)
CONFIG = json.loads((ROOT / "config/profiles/member.json").read_text())
(Path(PROFILE.name) / "config.yaml").write_text(json.dumps(CONFIG))
sys.path[:0] = [str(ROOT / "server"), str(HERMES)]

from aiohttp import web
from aiohttp import ClientSession
from aiohttp.test_utils import TestClient, TestServer
from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter
from hermes_bridge import ServantAPIServerAdapter, make_member_agent, validate_member_profile, verify_contract

KEY = "servant-contract-test-key-not-a-real-secret"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC0sAAAAASUVORK5CYII=")
DATA_URL = "data:image/png;base64," + base64.b64encode(PNG).decode()


class FakeAgent:
    def __init__(self, *, session_id=None, behavior=None, **kwargs):
        self.session_id = session_id
        self.behavior = behavior
        self.kwargs = kwargs
        self.model = "contract-fixture"
        self.provider = "test"
        self.session_prompt_tokens = self.session_completion_tokens = self.session_total_tokens = 0
        self.interrupted = threading.Event()
        self.steer_event = threading.Event()
        self._memory_manager = None
        self.tools, self.valid_tool_names = [], set()
        self._memory_store = None
        self._memory_enabled = self._user_profile_enabled = False

    def run_conversation(self, **kwargs):
        self.call = kwargs
        if self.behavior:
            return self.behavior(self, kwargs)
        return {"final_response": "done", "messages": []}

    def interrupt(self, *args, **kwargs):
        self.interrupted.set()

    def steer(self, text):
        # Same contract as Hermes AIAgent.steer: accepted text is stashed for
        # the next tool result; leftovers come back as result["pending_steer"].
        if not text or not text.strip():
            return False
        self.steered = (getattr(self, "steered", "") + "\n" + text.strip()).strip()
        self.steer_event.set()
        return True

    def shutdown_memory_provider(self, *args, **kwargs):
        pass


def app_for(adapter):
    app = web.Application()
    for method, path, handler in [
        ("GET", "/v1/capabilities", "_handle_capabilities"),
        ("POST", "/api/sessions", "_handle_create_session"),
        ("GET", "/api/sessions/{session_id}/messages", "_handle_session_messages"),
        ("POST", "/v1/runs", "_handle_runs"),
        ("GET", "/v1/runs/{run_id}", "_handle_get_run"),
        ("GET", "/v1/runs/{run_id}/events", "_handle_run_events"),
        ("POST", "/v1/runs/{run_id}/approval", "_handle_run_approval"),
        ("POST", "/v1/runs/{run_id}/stop", "_handle_stop_run"),
    ]:
        app.router.add_route(method, path, getattr(adapter, handler))
    return app


class HermesContractTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.adapter = ServantAPIServerAdapter(PlatformConfig(enabled=True, extra={"key": KEY}))
        self.client = TestClient(TestServer(app_for(self.adapter)), headers={"Authorization": f"Bearer {KEY}"})
        await self.client.start_server()
        self.agents = []
        self.behavior = None

        def factory(_adapter, *args, **kwargs):
            agent = FakeAgent(behavior=self.behavior, **kwargs)
            self.agents.append(agent)
            return agent

        self.agent_patch = patch.object(APIServerAdapter, "_create_agent", factory)
        self.agent_patch.start()

    async def asyncTearDown(self):
        for agent in self.agents:
            agent.interrupt()
        tasks = list(self.adapter._active_run_tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.agent_patch.stop()
        await self.client.close()

    async def wait_status(self, run_id, statuses=("completed", "failed", "cancelled")):
        for _ in range(300):
            response = await self.client.get(f"/v1/runs/{run_id}")
            self.assertEqual(response.status, 200)
            data = await response.json()
            if data["status"] in statuses:
                return data
            await asyncio.sleep(0.01)
        self.fail("Run never reached expected status")

    async def start(self, **body):
        response = await self.client.post("/v1/runs", json={"input": "hello", **body})
        self.assertEqual(response.status, 202, await response.text())
        return (await response.json())["run_id"]

    async def test_durable_run_preserves_long_flat_text_and_image_text(self):
        text = json.dumps({"payload": "x" * 70000})
        for content in (text, [{"type": "text", "text": text}, {"type": "image_url", "image_url": {"url": DATA_URL}}]):
            with self.subTest(multimodal=isinstance(content, list)):
                run_id = await self.start(input=[{"role": "user", "content": content}])
                data = await self.wait_status(run_id)
                self.assertEqual(data["status"], "completed", data)
                received = self.agents[-1].call["user_message"]
                self.assertEqual(received, content)
                self.assertEqual(json.loads(received if isinstance(received, str) else received[0]["text"]), json.loads(text))

    async def test_capabilities_auth_and_session_resources(self):
        response = await self.client.get("/v1/capabilities")
        data = await response.json()
        for feature in ("run_submission", "run_status", "run_events_sse", "run_stop", "run_approval_response", "servant_durable_media_runs"):
            self.assertIs(data["features"][feature], True, feature)
        unauthorized = await self.client.get("/v1/capabilities", headers={"Authorization": "Bearer incorrect"})
        self.assertEqual(unauthorized.status, 401)
        created = await self.client.post("/api/sessions", json={"id": "servant_contract_session", "title": "Contract"})
        self.assertIn(created.status, (200, 201), await created.text())
        messages = await self.client.get("/api/sessions/servant_contract_session/messages")
        self.assertEqual(messages.status, 200)

    async def test_standalone_startup_registers_bridge_routes(self):
        # The production launcher uses connect(), not the small test app above.
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        adapter = ServantAPIServerAdapter(PlatformConfig(enabled=True, extra={"key": KEY, "host": "127.0.0.1", "port": port}))
        try:
            self.assertTrue(await adapter.connect())
            async with ClientSession(headers={"Authorization": f"Bearer {KEY}"}) as client:
                async with client.get(f"http://127.0.0.1:{port}/v1/capabilities") as response:
                    self.assertEqual(response.status, 200)
                    self.assertIs((await response.json())["features"]["servant_durable_media_runs"], True)
        finally:
            await adapter.disconnect()

    async def test_run_preserves_canonical_image_history_and_resolved_output(self):
        image = Path(PROFILE.name) / "contract-output.png"
        image.write_bytes(PNG)
        history = [{"role": "user", "content": [{"type": "text", "text": "Earlier image"}, {"type": "image_url", "image_url": {"url": DATA_URL}}]}]
        self.behavior = lambda agent, call: {"final_response": f"An image\nMEDIA:{image}", "messages": []}
        # Exercise real HTTP parsing. The bridge must preserve typed image parts
        # even on old Hermes that stringifies explicit conversation_history.
        original_history = self.adapter._conversation_history_for_session
        async def async_history(session_id):
            return copy.deepcopy(history)
        def sync_history(session_id):
            return copy.deepcopy(history)
        import inspect
        with patch.object(self.adapter, "_conversation_history_for_session", async_history if inspect.iscoroutinefunction(original_history) else sync_history):
            run_id = await self.start(session_id="servant_multimodal", input=[{"role": "user", "content": [{"type": "text", "text": "Describe"}, {"type": "image_url", "image_url": {"url": DATA_URL}}]}])
            data = await self.wait_status(run_id)
        self.assertEqual(data["status"], "completed", data)
        self.assertEqual(self.agents[0].call["conversation_history"], history)
        self.assertEqual(self.agents[0].call["user_message"][1]["image_url"]["url"], DATA_URL)
        self.assertIn(DATA_URL, data["output"])
        events = await self.client.get(f"/v1/runs/{run_id}/events")
        body = await events.text()
        self.assertIn("run.completed", body)
        self.assertIn(DATA_URL, body)

    async def test_stop_interrupts_agent_and_status_survives_event_disconnect(self):
        def slow(agent, call):
            agent.interrupted.wait(5)
            return {"final_response": "interrupted", "interrupted": True}
        self.behavior = slow
        run_id = await self.start()
        await self.wait_status(run_id, ("running",))
        response = await self.client.post(f"/v1/runs/{run_id}/stop", json={})
        self.assertEqual(response.status, 200)
        data = await self.wait_status(run_id)
        self.assertEqual(data["status"], "cancelled", data)
        self.assertTrue(self.agents[0].interrupted.is_set())

    async def test_steer_reaches_running_agent_and_unread_text_is_reported(self):
        release = threading.Event()
        def slow(agent, call):
            agent.steer_event.wait(5)
            release.wait(5)
            # The agent finished without reaching a tool boundary: Hermes hands
            # the steer back as pending_steer.
            return {"final_response": "done", "messages": [], "pending_steer": agent.steered}
        self.behavior = slow
        caps = await (await self.client.get("/v1/capabilities")).json()
        self.assertIs(caps["features"]["servant_steer"], True)
        run_id = await self.start()
        await self.wait_status(run_id, ("running",))
        endpoint = f"/v1/runs/{run_id}/approval"
        empty = await self.client.post(endpoint, json={"steer": "  "})
        self.assertEqual(empty.status, 400)
        sent = await self.client.post(endpoint, json={"steer": "Use the blue one", "steer_id": "turn_x"})
        self.assertEqual(sent.status, 200, await sent.text())
        self.assertEqual(self.agents[0].steered, "Use the blue one")
        release.set()
        data = await self.wait_status(run_id)
        self.assertEqual(data["status"], "completed", data)
        self.assertEqual(data["unread_steer"], "Use the blue one")
        late = await self.client.post(endpoint, json={"steer": "Too late"})
        self.assertEqual(late.status, 409)

    async def test_failed_run_and_inactive_approval_are_explicit(self):
        self.behavior = lambda agent, call: {"failed": True, "error": "fixture failure"}
        run_id = await self.start()
        data = await self.wait_status(run_id)
        self.assertEqual(data["status"], "failed")
        response = await self.client.post(f"/v1/runs/{run_id}/approval", json={"choice": "once", "approval_id": "missing"})
        self.assertEqual(response.status, 409)

    async def test_approval_recovers_without_sse_and_retries_cannot_approve_next_action(self):
        from tools import approval

        def gated(agent, call):
            with approval._lock:
                key, notify = next(iter(approval._gateway_notify_cbs.items()))
            outcomes = []
            for step in (1, 2):
                result = approval._await_gateway_decision(key, notify, {
                    "command": f"contract-action-{step}", "description": "Test approval", "pattern_keys": [],
                })
                outcomes.append(result.get("choice"))
            return {"final_response": json.dumps(outcomes)}

        self.behavior = gated
        run_id = await self.start()

        async def pending(exclude=None):
            for _ in range(300):
                status = await (await self.client.get(f"/v1/runs/{run_id}")).json()
                item = status.get("pending_approval")
                if item and item["approval_id"] != exclude:
                    return item
                await asyncio.sleep(0.01)
            self.fail("No recoverable pending approval")

        # Do not connect to SSE at all: status must retain the actual pending gate.
        first = await pending()
        self.assertEqual(first["command"], "contract-action-1")
        self.assertEqual(first["choices"], ["once", "deny"])
        endpoint = f"/v1/runs/{run_id}/approval"
        choice = {"approval_id": first["approval_id"], "choice": "once"}
        answered = await self.client.post(endpoint, json=choice)
        self.assertEqual(answered.status, 200)
        receipt = await answered.json()
        second = await pending(exclude=first["approval_id"])
        self.assertEqual(second["command"], "contract-action-2")
        replay = await self.client.post(endpoint, json=choice)
        self.assertEqual(await replay.json(), receipt)
        still_pending = await pending()
        self.assertEqual(still_pending["approval_id"], second["approval_id"])
        changed = await self.client.post(endpoint, json={**choice, "choice": "deny"})
        self.assertEqual(changed.status, 409)
        wide = await self.client.post(endpoint, json={"approval_id": second["approval_id"], "choice": "always"})
        self.assertEqual(wide.status, 400)
        denied = await self.client.post(endpoint, json={"approval_id": second["approval_id"], "choice": "deny"})
        self.assertEqual(denied.status, 200)
        result = await self.wait_status(run_id)
        self.assertEqual(result["status"], "completed", result)
        self.assertEqual(json.loads(result["output"]), ["once", "deny"])
        self.assertIsNone(result["pending_approval"])
        events = await (await self.client.get(f"/v1/runs/{run_id}/events")).text()
        self.assertIn(first["approval_id"], events)
        self.assertIn(second["approval_id"], events)

    async def test_bare_owner_image_paths_render_inline(self):
        image = Path(PROFILE.name) / "bare-screenshot.png"
        image.write_bytes(PNG)
        reply = (f"Side by side:\n{image}\n\nAlso [this one]({image}). Missing: /no/such/file.png. "
                 f"Code stays: `{image}`")
        self.behavior = lambda agent, call: {"final_response": reply, "messages": []}
        run_id = await self.start()
        data = await self.wait_status(run_id)
        self.assertEqual(data["status"], "completed", data)
        output = data["output"]
        self.assertEqual(output.count(f"![bare-screenshot.png]({DATA_URL})"), 2, output)
        self.assertNotIn("[this one]", output)
        self.assertIn("/no/such/file.png", output)
        self.assertIn(f"`{image}`", output)

    async def test_member_media_directives_never_read_host_files(self):
        self.adapter.restricted_member = True
        image = Path(PROFILE.name) / "private-owner-image.png"
        image.write_bytes(PNG)
        agent = FakeAgent(behavior=lambda agent, call: {"final_response": f"MEDIA:{image}"})
        with patch("hermes_bridge.make_member_agent", return_value=agent):
            run_id = await self.start()
            result = await self.wait_status(run_id)
        self.assertEqual(result["status"], "completed", result)
        self.assertNotIn("data:image", result["output"])
        self.assertNotIn(str(image), result["output"])
        # A bare path stays plain text for members; the file is never read.
        agent.behavior = lambda agent, call: {"final_response": f"See {image}"}
        with patch("hermes_bridge.make_member_agent", return_value=agent):
            result = await self.wait_status(await self.start())
        self.assertEqual(result["output"], f"See {image}")
        data = await (await self.client.get("/v1/capabilities")).json()
        self.assertIs(data["features"]["servant_member_isolation"], True)
        self.assertEqual(data["servant"]["memberPolicy"]["allowedTools"], [])

    async def test_member_cannot_read_shared_memory_or_context(self):
        validate_member_profile(CONFIG)
        sentinel = "another-members-private-memory-sentinel"
        from tools.memory_tool import MemoryStore, get_memory_dir
        memory_directory = get_memory_dir()
        self.assertEqual(memory_directory, Path(PROFILE.name) / "memories")
        memory_directory.mkdir(exist_ok=True)
        for name in ("MEMORY.md", "USER.md"):
            (memory_directory / name).write_text(sentinel)
        for name in ("SOUL.md", "AGENTS.md"):
            (Path(PROFILE.name) / name).write_text(sentinel)
        # Positive control: these are the real Hermes memory paths, and the
        # sentinel would load if the member isolation switches were absent.
        unisolated = MemoryStore()
        unisolated.load_from_disk()
        self.assertIn(sentinel, "\n".join(unisolated.memory_entries))
        self.assertIn(sentinel, "\n".join(unisolated.user_entries))
        # Construct the real AIAgent but never invoke a model. All provider
        # resolution is stubbed to a closed loopback endpoint.
        with patch("gateway.run._resolve_runtime_agent_kwargs", return_value={"provider": "openai", "api_key": "contract-only", "base_url": "http://127.0.0.1:1/v1"}), patch("gateway.run._resolve_gateway_model", return_value="gpt-4o"), patch("gateway.run._load_gateway_config", return_value=CONFIG):
            first = make_member_agent(self.adapter, {"session_id": "member_one", "gateway_session_key": "servant:one"})
            second = make_member_agent(self.adapter, {"session_id": "member_two", "gateway_session_key": "servant:two"})
        for agent in (first, second):
            self.assertEqual(agent.tools, [])
            self.assertIsNone(agent._memory_store)
            self.assertIsNone(agent._memory_manager)
            self.assertNotIn(sentinel, agent._build_system_prompt())
            self.assertIsNone(agent._spawn_background_review([], review_memory=True, review_skills=True))
        for name in ("MEMORY.md", "USER.md"):
            self.assertEqual((memory_directory / name).read_text(), sentinel)


class EgressNamingTest(unittest.TestCase):
    """With the network gate on, each session's commands carry that session's token to the gate (hermes_egress.py)."""

    PROXY = ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy", "SERVANT_EGRESS_PORT", "TERMINAL_ENV")

    def setUp(self):
        import hermes_egress
        from tools import terminal_tool
        self.egress, self.terminal = hermes_egress, terminal_tool
        self.saved = {name: os.environ.get(name) for name in self.PROXY}
        os.environ["TERMINAL_ENV"] = "local"
        os.environ["SERVANT_EGRESS_PORT"] = "8790"
        for name in self.PROXY[:6]:
            os.environ[name] = "http://127.0.0.1:8790"
        self.sessions = []

    def tearDown(self):
        for session in self.sessions:
            self.egress.forget(session)
            try:
                self.terminal.cleanup_vm(session)
            except Exception:
                pass
            self.terminal._task_env_overrides.pop(session, None)
        for name, value in self.saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    def run_in(self, session, command):
        if session not in self.sessions:
            self.sessions.append(session)
        result = json.loads(self.terminal.terminal_tool(command, task_id=session, force=True))
        return (result.get("output") or result.get("error") or "").strip()

    def bind(self, session, token):
        if session not in self.sessions:
            self.sessions.append(session)
        return self.egress.bind(session, token)

    def test_each_session_presents_its_own_token_and_nothing_leaks_between_them(self):
        pat, jo = "pat" + "A" * 24, "jo" + "B" * 24
        self.assertTrue(self.bind("servant_egress_pat", pat))
        self.assertTrue(self.bind("servant_egress_jo", jo))
        for _ in range(2):  # the second command re-reads what the first exported
            self.assertEqual(self.run_in("servant_egress_pat", "echo $HTTPS_PROXY $all_proxy"), "http://%s:@127.0.0.1:8790 http://%s:@127.0.0.1:8790" % (pat, pat))
            self.assertEqual(self.run_in("servant_egress_jo", "echo $HTTPS_PROXY"), "http://%s:@127.0.0.1:8790" % jo)
            self.assertEqual(self.run_in("servant_egress_none", "echo $HTTPS_PROXY"), "http://127.0.0.1:8790", "a session without a token stays unnamed")
        self.run_in("servant_egress_pat", "export SERVANT_EGRESS_PROBE=pat")
        self.assertEqual(self.run_in("servant_egress_jo", "echo [$SERVANT_EGRESS_PROBE]"), "[]", "one session's shell is not another's")
        self.assertEqual(self.run_in("servant_egress_pat", "echo [$SERVANT_EGRESS_PROBE]"), "[pat]", "a session keeps its own shell")

    def test_a_shared_thread_starts_a_fresh_shell_for_the_next_person(self):
        pat, jo = "pat" + "C" * 24, "jo" + "D" * 24
        self.assertTrue(self.bind("servant_egress_thread", pat))
        self.assertEqual(self.run_in("servant_egress_thread", "export SERVANT_EGRESS_PROBE=pat; echo $HTTPS_PROXY"), "http://%s:@127.0.0.1:8790" % pat)
        self.assertTrue(self.bind("servant_egress_thread", pat), "the same person again keeps the shell")
        self.assertEqual(self.run_in("servant_egress_thread", "echo [$SERVANT_EGRESS_PROBE]"), "[pat]")
        self.assertTrue(self.bind("servant_egress_thread", jo))
        self.assertEqual(self.run_in("servant_egress_thread", "echo $HTTPS_PROXY [$SERVANT_EGRESS_PROBE]"), "http://%s:@127.0.0.1:8790 []" % jo, "the last person's token is not remembered")

    def test_a_session_that_already_ran_commands_is_named_from_its_next_command(self):
        self.assertEqual(self.run_in("servant_egress_late", "echo $HTTPS_PROXY"), "http://127.0.0.1:8790")
        token = "late" + "E" * 24
        self.assertTrue(self.bind("servant_egress_late", token))
        self.assertEqual(self.run_in("servant_egress_late", "echo $HTTPS_PROXY"), "http://%s:@127.0.0.1:8790" % token)

    def test_nothing_is_named_without_the_gate_or_with_a_token_that_could_break_the_address(self):
        for bad in ("short", "has space " + "F" * 24, "at@sign" + "F" * 24, "slash/" + "F" * 24, "", None, 7):
            self.assertFalse(self.egress.bind("servant_egress_bad", bad), repr(bad))
        self.assertFalse(self.egress.bind("", "ok" + "G" * 24))
        os.environ.pop("SERVANT_EGRESS_PORT")
        self.assertFalse(self.egress.bind("servant_egress_off", "ok" + "G" * 24), "not started through the sandbox wrapper")
        os.environ["SERVANT_EGRESS_PORT"] = "8790"
        os.environ["HTTPS_PROXY"] = "http://proxy.example.gov:3128"
        self.assertFalse(self.egress.bind("servant_egress_off", "ok" + "G" * 24), "the bridge's own proxy is not the gate")
        self.assertNotIn("servant_egress_off", self.terminal._task_env_overrides, "a session that wasn't named keeps the shared shell")

    def test_the_bridge_binds_the_header_for_the_full_agent_only(self):
        class Request:
            def __init__(self, token):
                self.headers = {"X-Servant-Egress-Token": token} if token else {}
        token = "hdr" + "H" * 24
        full = ServantAPIServerAdapter(PlatformConfig(enabled=True, extra={"host": "127.0.0.1", "port": 0, "key": KEY}))
        member = ServantAPIServerAdapter(PlatformConfig(enabled=True, extra={"host": "127.0.0.1", "port": 0, "key": KEY}), restricted_member=True)
        self.sessions += ["servant_egress_full", "servant_egress_member", "servant_egress_plain"]
        full._servant_bind_egress(Request(token), "servant_egress_full")
        member._servant_bind_egress(Request(token), "servant_egress_member")
        full._servant_bind_egress(Request(None), "servant_egress_plain")
        self.assertEqual(self.run_in("servant_egress_full", "echo $HTTPS_PROXY"), "http://%s:@127.0.0.1:8790" % token)
        self.assertEqual(self.run_in("servant_egress_member", "echo $HTTPS_PROXY"), "http://127.0.0.1:8790")
        self.assertEqual(self.run_in("servant_egress_plain", "echo $HTTPS_PROXY"), "http://127.0.0.1:8790")


class ConnectionsTest(unittest.TestCase):
    """A person's own credentials reach their own session's real shell and nobody else's (hermes_egress.py, docs/connections.md)."""

    PAT = "ghp_" + "p" * 32 + "a1b2"
    JO = "ghp_" + "j" * 32 + "e5f6"

    def setUp(self):
        from http.server import BaseHTTPRequestHandler, HTTPServer
        import hermes_egress
        from tools import terminal_tool
        self.egress, self.terminal = hermes_egress, terminal_tool
        names = EgressNamingTest.PROXY + ("GH_TOKEN", "GITHUB_TOKEN")
        self.saved = {name: os.environ.get(name) for name in names}
        for name in names:
            os.environ.pop(name, None)
        os.environ["TERMINAL_ENV"] = "local"
        answers = self.answers = {
            "turn-token-for-pat-" + "P" * 12: {"env": {"GH_TOKEN": self.PAT, "GITHUB_TOKEN": self.PAT, "JIRA_SITE": "example.atlassian.net"}, "connections": ["github", "jira"]},
            "turn-token-for-jo-" + "J" * 12: {"env": {"GH_TOKEN": self.JO}, "connections": ["github"]},
        }

        class Door(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                answer = answers.get(body.get("token")) if self.path == "/connections" else None
                data = json.dumps(answer or {"error": "no"}).encode()
                self.send_response(200 if answer else 403)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Door)
        self.port = str(self.server.server_address[1])
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.sessions = []

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        for session in self.sessions:
            self.egress.forget(session)
            try:
                self.terminal.cleanup_vm(session)
            except Exception:
                pass
            self.terminal._task_env_overrides.pop(session, None)
        for name, value in self.saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    def run_in(self, session, command):
        if session not in self.sessions:
            self.sessions.append(session)
        result = json.loads(self.terminal.terminal_tool(command, task_id=session, force=True))
        return (result.get("output") or result.get("error") or "").strip()

    # Hermes masks anything shaped like a token in a command's output, so a value is read back a letter at a time.
    SPELL = "printf %%s \"$%s\" | sed 's/./&-/g'"

    def spelled(self, session, name):
        return self.run_in(session, self.SPELL % name).replace("-", "")

    def turn(self, adapter, session, token, door=None):
        class Request:
            headers = {"X-Servant-Egress-Token": token, "X-Servant-Connections-Door": door or self.port}
        if session not in self.sessions:
            self.sessions.append(session)
        env = asyncio.run(adapter._servant_connection_env(Request))
        adapter._servant_bind_egress(Request, session, env)
        return env

    def test_each_persons_credentials_reach_only_their_own_sessions_commands(self):
        full = ServantAPIServerAdapter(PlatformConfig(enabled=True, extra={"host": "127.0.0.1", "port": 0, "key": KEY}))
        member = ServantAPIServerAdapter(PlatformConfig(enabled=True, extra={"host": "127.0.0.1", "port": 0, "key": KEY}), restricted_member=True)
        pat, jo = "turn-token-for-pat-" + "P" * 12, "turn-token-for-jo-" + "J" * 12
        self.turn(full, "servant_conn_pat", pat)
        self.turn(full, "servant_conn_jo", jo)
        # Hermes takes GH_TOKEN out of every command's environment; a person's own is handed over on purpose.
        self.assertEqual([self.spelled("servant_conn_pat", name) for name in ("GH_TOKEN", "GITHUB_TOKEN", "JIRA_SITE")], [self.PAT, self.PAT, "example.atlassian.net"])
        self.assertEqual(self.spelled("servant_conn_jo", "GH_TOKEN"), self.JO)
        self.assertEqual(self.run_in("servant_conn_jo", "echo [$GITHUB_TOKEN] [$JIRA_SITE]"), "[] []", "Jo's commands have Jo's and nothing of Pat's")
        self.assertNotIn(self.PAT, self.run_in("servant_conn_pat", "echo $GH_TOKEN"), "and Hermes itself masks a token a command prints")
        self.assertEqual(self.run_in("servant_conn_none", "echo [$GH_TOKEN] [$JIRA_SITE]"), "[] []", "a session Servant gave nothing has nothing")
        self.assertEqual(self.run_in("servant_conn_pat", "env | grep -c _HERMES_FORCE_ || true"), "0", "the force prefix is Hermes's own business")
        # Never in the bridge's own environment, where every session would inherit it.
        self.assertNotIn("GH_TOKEN", os.environ)
        self.assertNotIn(self.PAT, os.environ.values())
        # A restricted agent is given none, even with a token that would fetch some.
        self.assertIsNone(self.turn(member, "servant_conn_member", pat))
        self.assertEqual(self.run_in("servant_conn_member", "echo [$GH_TOKEN]"), "[]")
        # A token Servant doesn't know, or a door nobody answers at: the turn still starts, without them.
        self.assertIsNone(self.turn(full, "servant_conn_unknown", "turn-token-unknown-" + "U" * 12))
        self.assertIsNone(self.turn(full, "servant_conn_nobody", pat, door="1"))
        self.assertEqual(self.run_in("servant_conn_unknown", "echo [$GH_TOKEN]"), "[]")
        self.assertEqual(self.run_in("servant_conn_nobody", "echo [$GH_TOKEN]"), "[]")

    def test_a_replaced_or_removed_credential_does_not_linger_in_the_sessions_shell(self):
        full = ServantAPIServerAdapter(PlatformConfig(enabled=True, extra={"host": "127.0.0.1", "port": 0, "key": KEY}))
        pat = "turn-token-for-pat-" + "P" * 12
        self.turn(full, "servant_conn_change", pat)
        self.assertEqual(self.spelled("servant_conn_change", "GH_TOKEN"), self.PAT)
        self.run_in("servant_conn_change", "export PROBE=kept")
        self.turn(full, "servant_conn_change", pat)
        self.assertEqual(self.run_in("servant_conn_change", "echo [$PROBE]"), "[kept]", "nothing changed, so the shell keeps going")
        self.answers[pat] = {"env": {"GH_TOKEN": self.JO}, "connections": ["github"]}
        self.turn(full, "servant_conn_change", pat)
        self.assertEqual(self.spelled("servant_conn_change", "GH_TOKEN"), self.JO)
        self.assertEqual(self.run_in("servant_conn_change", "echo [$GITHUB_TOKEN] [$PROBE]"), "[] []", "replaced: a fresh shell with the new one only")
        self.answers[pat] = {"env": {}, "connections": []}
        self.turn(full, "servant_conn_change", pat)
        self.assertEqual(self.run_in("servant_conn_change", "echo [$GH_TOKEN]"), "[]", "removed: no shell remembers it")

    def test_the_bridge_says_it_can_carry_connections_for_the_full_agent_only(self):
        async def features(**kwargs):
            adapter = ServantAPIServerAdapter(PlatformConfig(enabled=True, extra={"host": "127.0.0.1", "port": 0, "key": KEY}), **kwargs)
            app = web.Application()
            app.router.add_get("/v1/capabilities", adapter._handle_capabilities)
            async with TestClient(TestServer(app)) as client:
                response = await client.get("/v1/capabilities", headers={"Authorization": "Bearer " + KEY})
                return (await response.json())["features"]
        self.assertIs(asyncio.run(features())["servant_connections"], True)
        self.assertIs(asyncio.run(features(restricted_member=True))["servant_connections"], False)


class EntitlementCheckTest(unittest.TestCase):
    """Hermes stops a tool call when Servant doesn't allow it (hermes_guard.py), and the bridge says it can."""

    def setUp(self):
        from http.server import BaseHTTPRequestHandler, HTTPServer
        import hermes_guard
        self.guard = hermes_guard
        self.asked = asked = []
        self.verdict = verdict = {"value": {"verdict": "wait", "message": "Jo Park has been asked to allow GitHub write for Pat Tester."}}

        class Door(BaseHTTPRequestHandler):
            def do_POST(self):
                asked.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                data = json.dumps(verdict["value"]).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Door)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.guard._turns.clear()

    def test_a_marked_turn_is_asked_about_and_stopped_until_servant_allows_it(self):
        from hermes_cli.plugins import get_pre_tool_call_block_message
        self.assertTrue(self.guard.bind(["servant_check_session", "servant:usr_pat:cht_1"], "token-for-pat", self.server.server_address[1]))
        self.assertTrue(self.guard.bind(["servant_check_session"], "token-for-pat", self.server.server_address[1]), "registering twice adds no second hook")
        from hermes_cli import plugins
        self.assertEqual(plugins.get_plugin_manager()._hooks["pre_tool_call"].count(self.guard._hook), 1)
        blocked = get_pre_tool_call_block_message("terminal", {"command": "git push origin main"}, session_id="servant_check_session")
        self.assertEqual(blocked, "Jo Park has been asked to allow GitHub write for Pat Tester.")
        self.assertEqual(self.asked, [{"token": "token-for-pat", "needs": ["github-write"], "detail": "Run: git push origin main"}])
        self.assertIsNone(get_pre_tool_call_block_message("todo", {"todos": []}, session_id="servant_check_session"), "tools that touch neither files nor GitHub are not asked about")
        self.assertIsNone(get_pre_tool_call_block_message("terminal", {"command": "git push"}, session_id="not_servants"), "another session is left alone")
        self.verdict["value"] = {"verdict": "allow"}
        self.assertIsNone(get_pre_tool_call_block_message("write_file", {"path": "notes.md", "content": "x"}, task_id="servant_check_session"))
        self.assertEqual(self.asked[-1], {"token": "token-for-pat", "needs": ["fs-write"], "detail": "Write notes.md"})
        self.server.shutdown()
        self.server.server_close()
        refused = get_pre_tool_call_block_message("read_file", {"path": "README.md"}, session_id="servant_check_session")
        self.assertIn("wasn't done", refused, "with Servant unreachable the call is stopped, not let through")

    def test_the_full_bridge_says_it_can_check_and_a_turn_that_must_be_checked_is_bound(self):
        class Request:
            def __init__(self, headers):
                self.headers = headers
        full = ServantAPIServerAdapter(PlatformConfig(enabled=True, extra={"host": "127.0.0.1", "port": 0, "key": KEY}))
        port = str(self.server.server_address[1])
        full._servant_bind_egress(Request({"X-Servant-Egress-Token": "token-for-jo", "X-Servant-Door": port, "X-Hermes-Session-Key": "servant:usr_jo:cht_2"}), "servant_check_other")
        self.assertEqual(self.guard._turns["servant_check_other"], ("token-for-jo", int(port)))
        self.assertEqual(self.guard._turns["servant:usr_jo:cht_2"], ("token-for-jo", int(port)), "a subagent's calls are found by the session key")
        with self.assertRaises(web.HTTPServiceUnavailable):
            full._servant_bind_egress(Request({"X-Servant-Egress-Token": "token-for-jo", "X-Servant-Door": "not-a-port"}), "servant_check_bad")
        member = ServantAPIServerAdapter(PlatformConfig(enabled=True, extra={"host": "127.0.0.1", "port": 0, "key": KEY}), restricted_member=True)
        member._servant_bind_egress(Request({"X-Servant-Egress-Token": "token-for-jo", "X-Servant-Door": port}), "servant_check_member")
        self.assertNotIn("servant_check_member", self.guard._turns, "an agent with no tools has nothing to check")


if __name__ == "__main__":
    verify_contract()
    unittest.main(verbosity=2)
