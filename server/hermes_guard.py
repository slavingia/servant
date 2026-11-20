"""Ask Servant before a tool call reads or changes files or GitHub (docs/entitlements.md, "Built-in entitlements").

Servant tells the bridge, with each turn, whose turn it is (a token) and where to ask (a port on this computer).
Before a tool call that needs a built-in entitlement, this asks Servant. Servant answers at once when the person
holds it; otherwise it asks their manager and this waits for the answer. Anything but "allow" stops the tool call
and gives the agent Servant's words to pass on.

It fails closed. Hermes ignores a hook that raises, which would let the call through, so nothing here is allowed to
raise: a question that can't be asked or answered is a refusal.
"""
import json
import threading
import urllib.error
import urllib.request

import hermes_capabilities

TOKEN_HEADER = "X-Servant-Egress-Token"
DOOR_HEADER = "X-Servant-Door"
# Longer than Servant ever waits for a manager (15 minutes at most), so Servant's own answer is the one that arrives.
ASK_TIMEOUT = 960

_lock = threading.Lock()
_turns = {}
_installed = False
# Never through a proxy: the question goes to this computer, and inside the sandbox the proxy variables point at the gate.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def bind(keys, token, door):
    """Tool calls made under any of these session ids or keys belong to this token. Returns True when it took hold."""
    if not isinstance(token, str) or not token or not str(door).isdigit() or not 0 < int(door) < 65536:
        return False
    with _lock:
        for key in keys:
            if isinstance(key, str) and key:
                _turns[key] = (token, int(door))
    return install()


def _turn_for(session_id, task_id):
    keys = [session_id, task_id]
    try:
        from tools.approval import get_current_session_key
        keys.append(get_current_session_key())
    except Exception:
        pass
    with _lock:
        for key in keys:
            if isinstance(key, str) and key in _turns:
                return _turns[key]
    return None


def ask(token, door, needs, detail, opener=None, targets=None):
    """Servant's answer as (allowed, message). Any failure to ask or to understand the answer is a refusal."""
    question = {"token": token, "needs": needs, "detail": detail}
    # Where the call points, so a grant for one project doesn't cover a path or repository outside it.
    if isinstance(targets, dict):
        question.update({key: targets[key] for key in ("paths", "repos") if targets.get(key)})
    body = json.dumps(question).encode("utf-8")
    request = urllib.request.Request("http://127.0.0.1:%d/use" % door, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with (opener or _opener).open(request, timeout=ASK_TIMEOUT) as response:
            answer = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            answer = json.loads(error.read().decode("utf-8"))
        except Exception:
            answer = {}
    except Exception:
        return False, "Servant couldn't be asked whether this is allowed, so it wasn't done. Tell the person, and try again in a moment."
    if isinstance(answer, dict) and answer.get("verdict") == "allow":
        return True, ""
    message = answer.get("message") if isinstance(answer, dict) else None
    return False, message if isinstance(message, str) and message else "Servant did not allow this. Tell the person; don't look for another way to do it."


def check(tool_name, args, session_id="", task_id="", opener=None):
    """None to let the tool call go ahead, or the message that stops it."""
    needs = hermes_capabilities.in_order(hermes_capabilities.tool_needs(tool_name, args))
    if not needs:
        return None
    turn = _turn_for(session_id, task_id)
    if turn is None:
        # Not a turn Servant asked to be checked (the checks are off, or this isn't Servant's session).
        return None
    allowed, message = ask(turn[0], turn[1], needs, hermes_capabilities.describe(tool_name, args), opener, hermes_capabilities.targets(tool_name, args))
    return None if allowed else message


def _hook(tool_name="", args=None, session_id="", task_id="", **_ignored):
    try:
        message = check(tool_name, args, session_id=session_id, task_id=task_id)
    except Exception:
        message = "Servant couldn't check whether this is allowed, so it wasn't done. Tell the person, and try again in a moment."
    return {"action": "block", "message": message} if message else None


def install():
    """Register the check with Hermes once. False when this Hermes has no way to stop a tool call from a hook."""
    global _installed
    with _lock:
        if _installed:
            return True
        try:
            from hermes_cli import plugins
            if not hasattr(plugins, "get_pre_tool_call_block_message"):
                return False
            manager = plugins.get_plugin_manager()
            hooks = getattr(manager, "_hooks", None)
            if not isinstance(hooks, dict):
                return False
            hooks.setdefault("pre_tool_call", []).append(_hook)
        except Exception:
            return False
        _installed = True
        return True
