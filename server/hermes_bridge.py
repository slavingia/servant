"""Small, repository-owned extension of Hermes' authenticated API adapter.

Runs keep Hermes' native stop/approval semantics. The extension preserves the
canonical multimodal transcript and resolves owner output media before Hermes
persists run output. Member instances have a deliberately empty tool allowlist.
No vendor source or live profile is modified.
"""
from __future__ import annotations

import base64
import copy
import inspect
import json
import re
import uuid
from contextvars import ContextVar
from pathlib import Path

from aiohttp import web
from gateway.platforms.api_server import APIServerAdapter, _resolve_media_to_data_urls
from gateway.platforms.base import MEDIA_TAG_CLEANUP_RE, validate_media_delivery_path
from servant_run_keys import HEADER as RUN_KEY_HEADER, PREFIX as RUN_KEY_PREFIX, RunKeys, describe as describe_run_key, valid_key

_run_context = ContextVar("servant_run_context", default=None)
POLICY = json.loads(Path(__file__).with_name("member-policy.json").read_text())
# The researcher bridge: web, search, vision, skills and planning, and nothing that can run a shell
# or touch a file, so gh and git are impossible. Anything outside this list fails closed.
RESEARCHER = json.loads(Path(__file__).with_name("researcher-policy.json").read_text())
RESEARCHER_TOOLS = frozenset(RESEARCHER["allowedTools"])


def register_researcher_toolset():
    """Hermes has no per-tool deny list, so give the researcher one toolset with exactly the allowed
    tools (skills can be read but not edited, no shell, no files). Registered when the bridge starts."""
    from toolsets import create_custom_toolset
    create_custom_toolset(RESEARCHER["toolset"], "Servant researcher: web, vision, skills (read-only) and planning",
                          tools=list(RESEARCHER["allowedTools"]))


# Agents usually name a screenshot by its bare path ("Saved to /Users/me/x.png")
# rather than a MEDIA: directive. Mirror Hermes' extract_local_files matcher
# (absolute or ~/ path, no spaces, not inside a URL or code) for images only.
# server/media.mjs BARE_IMAGE_PATH must match the same paths.
_PATH = r"(?:~/|/)(?:[\w.\-]+/)*[\w.\-]+\.(?:png|jpe?g|gif|webp)\b"
# A markdown link or image around the path is replaced whole, so the result
# never nests markup inside a link.
BARE_IMAGE_PATH_RE = re.compile(r"!?\[[^\]\n]*\]\(<?(" + _PATH + r")>?\)|(?<![/:\w.])(" + _PATH + r")", re.IGNORECASE)
_IMAGE_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
_IMAGE_MAX_BYTES = 5 * 1024 * 1024  # Servant's per-file media limit


def resolve_bare_image_paths(text):
    """Inline existing local images named by bare path as markdown data URLs.

    Uses Hermes' own delivery denylist; paths in code, missing files, oversized
    files and non-images are left as written.
    """
    if not text or not BARE_IMAGE_PATH_RE.search(text):
        return text
    code = [m.span() for m in re.finditer(r"```[^\n]*\n.*?```", text, re.DOTALL)]
    code += [m.span() for m in re.finditer(r"`[^`\n]+`", text)]

    def inline(match):
        if any(start <= match.start() < end for start, end in code):
            return match.group(0)
        safe = validate_media_delivery_path(match.group(1) or match.group(2))
        if not safe:
            return match.group(0)
        path = Path(safe)
        mime = _IMAGE_MIME.get(path.suffix.lower())
        try:
            if not mime or not path.is_file() or path.stat().st_size > _IMAGE_MAX_BYTES:
                return match.group(0)
            data = base64.b64encode(path.read_bytes()).decode()
        except OSError:
            return match.group(0)
        name = path.name.replace("]", "").replace("[", "")
        return f"![{name}](data:{mime};base64,{data})"

    return BARE_IMAGE_PATH_RE.sub(inline, text)


def verify_contract():
    """Fail on missing private adapter hooks rather than advertising support."""
    for name in ("_handle_runs", "_handle_get_run", "_handle_run_events", "_handle_run_approval",
                 "_handle_stop_run", "_handle_capabilities", "_conversation_history_for_session",
                 "_create_agent", "_ensure_session_db", "_check_auth"):
        if not callable(getattr(APIServerAdapter, name, None)):
            raise RuntimeError(f"Incompatible Hermes: missing {name}")
    from run_agent import AIAgent
    required = {"enabled_toolsets", "skip_memory", "skip_context_files", "load_soul_identity", "session_db"}
    if not required.issubset(inspect.signature(AIAgent.__init__).parameters):
        raise RuntimeError("Incompatible Hermes: member-isolation constructor controls changed")
    from tools import approval
    if not hasattr(approval, "_lock") or not isinstance(getattr(approval, "_gateway_queues", None), dict):
        raise RuntimeError("Incompatible Hermes: exact approval queue contract changed")


def validate_member_profile(config):
    """Validate the actual loaded config, including Hermes' merged defaults."""
    memory = config.get("memory", {})
    if (memory.get("memory_enabled") is not False
            or memory.get("user_profile_enabled") is not False
            or memory.get("provider", "") != ""):
        raise RuntimeError("Member profile must disable built-in user/memory stores and external memory")
    if config.get("mcp_servers") or config.get("context", {}).get("engine", "compressor") != "compressor":
        raise RuntimeError("Member profile must not configure MCP or an external context engine")
    if config.get("platform_toolsets", {}).get("api_server") != ["no_mcp"]:
        raise RuntimeError("Member profile must use the checked-in api_server tool selection")
    if config.get("toolsets") != []:
        raise RuntimeError("Member profile must have an empty tool allowlist")


def validate_researcher_profile(config):
    """The researcher profile: the checked-in toolsets only, no memory, no MCP, GitHub blocked."""
    memory = config.get("memory", {})
    if (memory.get("memory_enabled") is not False
            or memory.get("user_profile_enabled") is not False
            or memory.get("provider", "") != ""):
        raise RuntimeError("Researcher profile must disable built-in user/memory stores and external memory")
    if config.get("mcp_servers") or config.get("context", {}).get("engine", "compressor") != "compressor":
        raise RuntimeError("Researcher profile must not configure MCP or an external context engine")
    register_researcher_toolset()
    if sorted(config.get("toolsets") or []) != sorted(RESEARCHER["allowedToolsets"]):
        raise RuntimeError("Researcher profile must use exactly the checked-in toolsets")
    if sorted(config.get("platform_toolsets", {}).get("api_server") or []) != sorted(RESEARCHER["allowedToolsets"]):
        raise RuntimeError("Researcher profile must use the checked-in api_server tool selection")
    block = config.get("security", {}).get("website_blocklist", {})
    if block.get("enabled") is not True or not set(RESEARCHER["blockedWebDomains"]).issubset(set(block.get("domains") or [])):
        raise RuntimeError("Researcher profile must block GitHub websites")


def assert_researcher_agent(agent):
    # Check the constructed agent, not just config: any tool beyond the allowlist, or any
    # memory, fails closed before a model call.
    names = set(getattr(agent, "valid_tool_names", None) or [])
    if (not all(hasattr(agent, name) for name in ("tools", "_memory_store", "_memory_manager", "_memory_enabled", "_user_profile_enabled"))
            or not names.issubset(RESEARCHER_TOOLS)
            or getattr(agent, "_memory_store", None) is not None
            or getattr(agent, "_memory_manager", None) is not None
            or getattr(agent, "_memory_enabled", False)
            or getattr(agent, "_user_profile_enabled", False)):
        extra = sorted(names - RESEARCHER_TOOLS)
        raise RuntimeError(f"Restricted researcher agent exposes tools or memory it must not have: {extra}")


def assert_member_agent(agent):
    # Check the constructed surface, not just config. Unknown future tools and
    # automatic provider/plugin injection must fail closed before a model call.
    if (not all(hasattr(agent, name) for name in ("tools", "_memory_store", "_memory_manager", "_memory_enabled", "_user_profile_enabled"))
            or getattr(agent, "tools", None) != []
            or getattr(agent, "valid_tool_names", None)
            or getattr(agent, "_memory_store", None) is not None
            or getattr(agent, "_memory_manager", None) is not None
            or getattr(agent, "_memory_enabled", False)
            or getattr(agent, "_user_profile_enabled", False)):
        raise RuntimeError("Restricted member agent unexpectedly exposes tools or persistent memory")


def make_member_agent(adapter, kwargs):
    from run_agent import AIAgent
    from gateway.run import _resolve_runtime_agent_kwargs, _resolve_gateway_model, _load_gateway_config

    validate_member_profile(_load_gateway_config())

    class MemberAgent(AIAgent):
        # Old supported Hermes does not have skip_background_review. Override
        # its dispatch hook as well so no review can grow an independent toolset.
        def _spawn_background_review(self, *args, **kwargs):
            return None

    runtime = _resolve_runtime_agent_kwargs()
    model = runtime.pop("model", None) or _resolve_gateway_model()
    runtime.pop("_fallback_notice", None)
    params = inspect.signature(AIAgent.__init__).parameters
    selected = {key: value for key, value in kwargs.items() if key in params}
    selected.pop("route", None)
    selected.update(runtime)
    selected.update({
        "model": model, "quiet_mode": True, "verbose_logging": False,
        "enabled_toolsets": [], "skip_memory": True, "skip_context_files": True,
        "load_soul_identity": False, "session_db": adapter._ensure_session_db(),
        "platform": "api_server", "max_iterations": 20,
    })
    if "skip_background_review" in params:
        selected["skip_background_review"] = True
    if "memory_manager" in params:
        selected["memory_manager"] = None
    agent = MemberAgent(**selected)
    assert_member_agent(agent)
    return agent


def make_researcher_agent(adapter, kwargs):
    from run_agent import AIAgent
    from gateway.run import _resolve_runtime_agent_kwargs, _resolve_gateway_model, _load_gateway_config

    validate_researcher_profile(_load_gateway_config())

    class ResearcherAgent(AIAgent):
        # Old supported Hermes does not have skip_background_review. Override
        # its dispatch hook as well so no review can grow an independent toolset.
        def _spawn_background_review(self, *args, **kwargs):
            return None

    runtime = _resolve_runtime_agent_kwargs()
    model = runtime.pop("model", None) or _resolve_gateway_model()
    runtime.pop("_fallback_notice", None)
    params = inspect.signature(AIAgent.__init__).parameters
    selected = {key: value for key, value in kwargs.items() if key in params}
    selected.pop("route", None)
    selected.update(runtime)
    selected.update({
        "model": model, "quiet_mode": True, "verbose_logging": False,
        "enabled_toolsets": list(RESEARCHER["allowedToolsets"]), "skip_memory": True, "skip_context_files": True,
        "load_soul_identity": False, "session_db": adapter._ensure_session_db(),
        "platform": "api_server", "max_iterations": 30,
    })
    if "skip_background_review" in params:
        selected["skip_background_review"] = True
    if "memory_manager" in params:
        selected["memory_manager"] = None
    agent = ResearcherAgent(**selected)
    assert_researcher_agent(agent)
    return agent


class _ObservedRunStreams(dict):
    """Observe this adapter's streams without patching any Hermes globals."""
    def __init__(self, adapter):
        super().__init__()
        self.adapter = adapter

    def __setitem__(self, run_id, stream):
        original = stream.put_nowait

        def put_nowait(event):
            if isinstance(event, dict) and event.get("event") == "approval.request":
                pending = self.adapter._pending_approval(run_id)
                if pending:
                    event = {**event, **pending}
            return original(event)

        stream.put_nowait = put_nowait
        return super().__setitem__(run_id, stream)


class _RunRequest:
    """The same authenticated request, pointed at another run ID, so Hermes' own
    status and stop handlers (with their auth and ownership checks) do the work."""

    def __init__(self, request, run_id):
        self._request = request
        self.match_info = {"run_id": run_id}

    def __getattr__(self, name):
        return getattr(self._request, name)


def _error(status, code, message, **extra):
    return web.json_response({"error": {"code": code, "message": message}, **extra}, status=status)


class ServantAPIServerAdapter(APIServerAdapter):
    def __init__(self, config, *, restricted_member=False, researcher=False):
        # A researcher is a restricted member that is also allowed the web, search, vision and skills.
        self.researcher = researcher
        self.restricted_member = restricted_member or researcher
        super().__init__(config)
        self._run_streams = _ObservedRunStreams(self)
        self._servant_approval_receipts = {}
        # run_id -> agent that received a steer, so its unread leftover can be
        # reported after the run ends (Hermes drops the agent reference).
        self._servant_steer_agents = {}
        # Servant's names for runs, so a run can be stopped even if the reply
        # with its ID was lost (servant_run_keys.py).
        self._servant_run_keys = RunKeys()

    def _pending_approval(self, run_id):
        from tools import approval
        from gateway.run import _redact_approval_command
        from agent.redact import redact_sensitive_text
        session_key = self._run_approval_sessions.get(run_id)
        with approval._lock:
            entries = approval._gateway_queues.get(session_key, [])
            if not entries:
                return None
            entry = entries[0]
            # The id lives on the exact native gate. Parallel requests cannot
            # make a stale response accidentally approve the next FIFO item.
            approval_id = entry.data.setdefault("servant_approval_id", "approval_" + uuid.uuid4().hex)
            return {
                "approval_id": approval_id,
                "command": _redact_approval_command(str(entry.data.get("command", ""))),
                "description": redact_sensitive_text(str(entry.data.get("description") or entry.data.get("reason") or "Approval required"), force=True),
                "choices": ["once", "deny"],
            }

    async def _run_key_status(self, request, key):
        entry = self._servant_run_keys.get(key)
        if entry is None:
            return _error(404, "run_key_unknown", "No run has this key")
        run_status = None
        if entry.get("run_id"):
            response = await super()._handle_get_run(_RunRequest(request, entry["run_id"]))
            if response.status == 200:
                run_status = json.loads(response.text).get("status")
            elif response.status == 404:
                run_status = "gone"
            else:
                return response
        return web.json_response(describe_run_key(key, entry, run_status))

    async def _handle_stop_run(self, request):
        run_id = request.match_info["run_id"]
        if not run_id.startswith(RUN_KEY_PREFIX):
            return await super()._handle_stop_run(request)
        auth_error = self._check_auth(request)
        if auth_error is not None:
            return auth_error
        key = run_id[len(RUN_KEY_PREFIX):]
        if not valid_key(key):
            return _error(400, "invalid_run_key", "Run keys start with servant_")
        action, target = self._servant_run_keys.cancel(key)
        if action == "stop":
            # 404 means Hermes no longer holds it, 409 that it's already ending.
            await super()._handle_stop_run(_RunRequest(request, target))
        return await self._run_key_status(request, key)

    async def _handle_get_run(self, request):
        if request.match_info["run_id"].startswith(RUN_KEY_PREFIX):
            auth_error = self._check_auth(request)
            if auth_error is not None:
                return auth_error
            key = request.match_info["run_id"][len(RUN_KEY_PREFIX):]
            if not valid_key(key):
                return _error(400, "invalid_run_key", "Run keys start with servant_")
            return await self._run_key_status(request, key)
        response = await super()._handle_get_run(request)
        if response.status != 200:
            return response
        data = json.loads(response.text)
        run_id = request.match_info["run_id"]
        data["pending_approval"] = self._pending_approval(run_id)
        agent = self._servant_steer_agents.get(run_id)
        unread = getattr(agent, "_servant_unread_steer", None) if agent is not None else None
        if isinstance(unread, str) and unread:
            data["unread_steer"] = unread
        return web.json_response(data)

    async def _servant_steer(self, run_id, body):
        # Hermes's native steer(): queued into the running agent between tool
        # calls without interrupting it. Text the agent never reached comes
        # back as unread_steer on the run status and Servant runs it next.
        text = body.get("steer")
        if not isinstance(text, str) or not text.strip() or len(text) > 20000:
            return web.json_response({"error": {"code": "invalid_steer", "message": "Steer text is required"}}, status=400)
        agent = self._active_run_agents.get(run_id)
        if agent is None or not hasattr(agent, "steer"):
            return web.json_response({"error": {"code": "run_not_steerable"}}, status=409)
        if not agent.steer(text):
            return web.json_response({"error": {"code": "invalid_steer"}}, status=400)
        self._servant_steer_agents[run_id] = agent
        while len(self._servant_steer_agents) > 256:
            self._servant_steer_agents.pop(next(iter(self._servant_steer_agents)))
        stream = self._run_streams.get(run_id)
        if stream is not None:
            stream.put_nowait({"event": "steer.accepted", "run_id": run_id, "steer_id": body.get("steer_id")})
        return web.json_response({"object": "hermes.run.steer", "run_id": run_id, "accepted": True})

    async def _handle_run_approval(self, request):
        # Preserve native authentication AND run ownership checks, including
        # newer Hermes' scoped run auth, before looking at an approval id.
        status = await super()._handle_get_run(request)
        if status.status != 200:
            return status
        try:
            body = await request.json()
        except (ValueError, TypeError):
            body = None
        if isinstance(body, dict) and "steer" in body and not self.restricted_member:
            return await self._servant_steer(request.match_info["run_id"], body)
        if not isinstance(body, dict) or body.get("choice") not in {"once", "deny"} or not isinstance(body.get("approval_id"), str):
            return web.json_response({"error": {"code": "invalid_approval", "message": "An exact approval_id and once or deny are required"}}, status=400)
        if body.get("all") or body.get("resolve_all"):
            return web.json_response({"error": {"code": "invalid_approval", "message": "Only one exact approval may be answered"}}, status=400)
        run_id, approval_id, choice = request.match_info["run_id"], body["approval_id"], body["choice"]
        receipt_key = (run_id, approval_id)
        receipt = self._servant_approval_receipts.get(receipt_key)
        if receipt is not None:
            if receipt["choice"] == choice:
                return web.json_response(receipt)
            return web.json_response({"error": {"code": "approval_already_answered"}}, status=409)
        from tools import approval
        session_key = self._run_approval_sessions.get(run_id)
        with approval._lock:
            queue = approval._gateway_queues.get(session_key, [])
            entry = next((item for item in queue if item.data.get("servant_approval_id") == approval_id), None)
            if entry is None:
                return web.json_response({"error": {"code": "approval_not_pending"}}, status=409)
            queue.remove(entry)
            if not queue:
                approval._gateway_queues.pop(session_key, None)
            # Match the native resolver's atomic outcome+signal operation. No
            # session or permanent grant is accepted by this bridge.
            entry.result = choice
            entry.event.set()
        receipt = {"object": "hermes.run.approval_response", "run_id": run_id, "approval_id": approval_id, "choice": choice, "resolved": 1}
        self._servant_approval_receipts[receipt_key] = receipt
        if len(self._servant_approval_receipts) > 4096:
            self._servant_approval_receipts.pop(next(iter(self._servant_approval_receipts)))
        self._set_run_status(run_id, "running", last_event="approval.responded")
        stream = self._run_streams.get(run_id)
        if stream is not None:
            stream.put_nowait({"event": "approval.responded", **receipt})
            pending = self._pending_approval(run_id)
            if pending:
                self._set_run_status(run_id, "waiting_for_approval", last_event="approval.request")
                stream.put_nowait({"event": "approval.request", "run_id": run_id, **pending})
        return web.json_response(receipt)

    async def _handle_capabilities(self, request):
        response = await super()._handle_capabilities(request)
        if response.status != 200:
            return response
        data = json.loads(response.text)
        data.setdefault("features", {})["servant_durable_media_runs"] = True
        data["features"]["servant_exact_approvals"] = True
        data["features"]["servant_run_keys"] = True
        data["features"]["servant_steer"] = not self.restricted_member
        data["features"]["servant_member_isolation"] = self.restricted_member and not self.researcher
        data["servant"] = {"bridgeVersion": 1}
        if self.researcher:
            data["features"]["servant_researcher_isolation"] = True
            data["servant"]["researcherPolicy"] = {
                "version": RESEARCHER["version"], "allowedToolsets": list(RESEARCHER["allowedToolsets"]),
                "allowedTools": sorted(RESEARCHER_TOOLS), "terminal": False, "files": False, "github": False,
                "persistentMemory": False, "localContext": False, "localMedia": False,
            }
        elif self.restricted_member:
            data["servant"]["memberPolicy"] = {
                "version": POLICY["version"], "allowedTools": [],
                "persistentMemory": False, "localContext": False, "localMedia": False,
            }
        return web.json_response(data)

    async def _handle_runs(self, request):
        auth_error = self._check_auth(request)
        if auth_error is not None:
            return auth_error
        try:
            body = await request.json()
        except (ValueError, TypeError):
            return await super()._handle_runs(request)
        context = None
        session_id = body.get("session_id") if isinstance(body, dict) else None
        if session_id and isinstance(session_id, str):
            history = self._conversation_history_for_session(session_id)
            if inspect.isawaitable(history):
                history = await history
            context = (session_id, copy.deepcopy(history))
        # asyncio-created run tasks inherit their own context; concurrent users
        # never share one mutable "current transcript" field on the adapter.
        key = request.headers.get(RUN_KEY_HEADER)
        if key is not None and not valid_key(key):
            return _error(400, "invalid_run_key", "Run keys start with servant_")
        if key is not None:
            ok, existing = self._servant_run_keys.begin(key)
            if not ok:
                # Stopped before it started, or already started (Servant adopts that run).
                return _error(409, "run_key_refused" if existing["state"] == "refused" else "run_key_in_use",
                              "This run key can't start a run", run_id=existing.get("run_id"))
        token = _run_context.set(context)
        try:
            response = await super()._handle_runs(request)
        except BaseException:
            if key is not None:
                self._servant_run_keys.failed(key)
            raise
        finally:
            _run_context.reset(token)
        if key is None:
            return response
        run_id = None
        if 200 <= response.status < 300:
            try:
                run_id = json.loads(response.text).get("run_id")
            except (ValueError, TypeError, AttributeError):
                run_id = None
        if not isinstance(run_id, str) or not run_id:
            self._servant_run_keys.failed(key)
            return response
        if self._servant_run_keys.started(key, run_id):
            # Servant stopped this key while Hermes was starting it.
            await super()._handle_stop_run(_RunRequest(request, run_id))
            return _error(409, "run_key_cancelled", "This run was stopped before it started", run_id=run_id)
        return response

    def _create_agent(self, *args, **kwargs):
        if self.restricted_member:
            if args:
                raise RuntimeError("Incompatible Hermes: positional agent creation")
            agent = (make_researcher_agent if self.researcher else make_member_agent)(self, kwargs)
        else:
            agent = super()._create_agent(*args, **kwargs)
        context = _run_context.get()
        original = agent.run_conversation

        def run_conversation(*run_args, **run_kwargs):
            if self.restricted_member:
                (assert_researcher_agent if self.researcher else assert_member_agent)(agent)
            if context is not None and context[0] == kwargs.get("session_id"):
                run_kwargs["conversation_history"] = copy.deepcopy(context[1])
            result = original(*run_args, **run_kwargs)
            if isinstance(result, dict) and isinstance(result.get("pending_steer"), str):
                agent._servant_unread_steer = result["pending_steer"]
            if isinstance(result, dict) and isinstance(result.get("final_response"), str):
                result = dict(result)
                if self.restricted_member:
                    # Even a tool-free model can echo a guessed MEDIA:/path.
                    # Strip directives before any native session-chat resolver.
                    result["final_response"] = MEDIA_TAG_CLEANUP_RE.sub(
                        "[Local files are unavailable to the member agent]", result["final_response"])
                else:
                    result["final_response"] = resolve_bare_image_paths(_resolve_media_to_data_urls(result["final_response"]))
            return result

        agent.run_conversation = run_conversation
        return agent
