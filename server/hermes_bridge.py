"""Small, repository-owned extension of Hermes' authenticated API adapter.

Runs keep Hermes' native stop/approval semantics. The extension preserves the
canonical multimodal transcript and resolves owner output media before Hermes
persists run output. Member instances have a deliberately empty tool allowlist.
No vendor source or live profile is modified.
"""
from __future__ import annotations

import copy
import inspect
import json
import uuid
from contextvars import ContextVar
from pathlib import Path

from aiohttp import web
from gateway.platforms.api_server import APIServerAdapter, _resolve_media_to_data_urls
from gateway.platforms.base import MEDIA_TAG_CLEANUP_RE

_run_context = ContextVar("servant_run_context", default=None)
POLICY = json.loads(Path(__file__).with_name("member-policy.json").read_text())


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


class ServantAPIServerAdapter(APIServerAdapter):
    def __init__(self, config, *, restricted_member=False):
        self.restricted_member = restricted_member
        super().__init__(config)
        self._run_streams = _ObservedRunStreams(self)
        self._servant_approval_receipts = {}

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

    async def _handle_get_run(self, request):
        response = await super()._handle_get_run(request)
        if response.status != 200:
            return response
        data = json.loads(response.text)
        data["pending_approval"] = self._pending_approval(request.match_info["run_id"])
        return web.json_response(data)

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
        data["features"]["servant_member_isolation"] = self.restricted_member
        data["servant"] = {"bridgeVersion": 1}
        if self.restricted_member:
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
        token = _run_context.set(context)
        try:
            return await super()._handle_runs(request)
        finally:
            _run_context.reset(token)

    def _create_agent(self, *args, **kwargs):
        if self.restricted_member:
            if args:
                raise RuntimeError("Incompatible Hermes: positional agent creation")
            agent = make_member_agent(self, kwargs)
        else:
            agent = super()._create_agent(*args, **kwargs)
        context = _run_context.get()
        original = agent.run_conversation

        def run_conversation(*run_args, **run_kwargs):
            if self.restricted_member:
                assert_member_agent(agent)
            if context is not None and context[0] == kwargs.get("session_id"):
                run_kwargs["conversation_history"] = copy.deepcopy(context[1])
            result = original(*run_args, **run_kwargs)
            if isinstance(result, dict) and isinstance(result.get("final_response"), str):
                result = dict(result)
                if self.restricted_member:
                    # Even a tool-free model can echo a guessed MEDIA:/path.
                    # Strip directives before any native session-chat resolver.
                    result["final_response"] = MEDIA_TAG_CLEANUP_RE.sub(
                        "[Local files are unavailable to the member agent]", result["final_response"])
                else:
                    result["final_response"] = _resolve_media_to_data_urls(result["final_response"])
            return result

        agent.run_conversation = run_conversation
        return agent
