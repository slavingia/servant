"""Give each Servant session's terminal its own way through the network gate (docs/agent-egress.md).

The sandbox starts the bridge with HTTPS_PROXY pointing at the gate. That address carries no name, so the gate
can only judge such traffic for everyone whose agent is working. Here each session's commands get the same address
with that session's token in it, so the gate knows whose they are.

Two things in Hermes make this more than setting a variable:
  - every session shares one local shell unless it asks for its own, and that shell re-reads the variables the
    previous command exported, so one session's token would leak into the next session's commands;
  - a shell records its variables once when it starts, so the token has to be there before it starts.
So a session with a token gets its own local shell, created with the token already in its environment.

The token keeps a command honest about whose it is; it is not a wall between sessions. Commands run as the same
user on the same computer, and one that goes looking can read another's environment.
"""
import inspect
import os
import re
import threading

PROXY_NAMES = ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy")
TOKEN_RE = re.compile(r"^[A-Za-z0-9._-]{20,600}$")
HEADER = "X-Servant-Egress-Token"

_lock = threading.Lock()
_tokens = {}
_installed = False


def gate_port():
    """The gate's port when this bridge was started through the sandbox wrapper, else None."""
    value = os.environ.get("SERVANT_EGRESS_PORT", "")
    proxy = os.environ.get("HTTPS_PROXY", "")
    if not value.isdigit() or not 0 < int(value) < 65536:
        return None
    # Only when the bridge itself goes through that gate: otherwise there is nothing to name.
    if not re.match(r"^http://127\.0\.0\.1:%s/?$" % value, proxy):
        return None
    return int(value)


def proxy_env(token, port):
    url = "http://%s:@127.0.0.1:%d" % (token, port)
    return {name: url for name in PROXY_NAMES}


def install(terminal_tool=None):
    """Wrap Hermes's environment factory once. Returns False (and changes nothing) when this Hermes doesn't have the pieces."""
    global _installed
    if terminal_tool is None:
        from tools import terminal_tool
    with _lock:
        if _installed:
            return True
        needed = ("_create_environment", "_LocalEnvironment", "register_task_env_overrides", "_task_env_overrides", "_active_environments", "_env_lock")
        if any(not hasattr(terminal_tool, name) for name in needed):
            return False
        original = terminal_tool._create_environment
        try:
            signature = inspect.signature(original)
        except (TypeError, ValueError):
            return False
        if any(name not in signature.parameters for name in ("env_type", "cwd", "timeout", "task_id")):
            return False

        def create_environment(*args, **kwargs):
            bound = signature.bind_partial(*args, **kwargs)
            task_id = bound.arguments.get("task_id")
            port = gate_port()
            with _lock:
                token = _tokens.get(task_id) if task_id else None
            if bound.arguments.get("env_type") == "local" and token and port:
                return terminal_tool._LocalEnvironment(cwd=bound.arguments.get("cwd") or "", timeout=bound.arguments.get("timeout") or 60, env=proxy_env(token, port))
            return original(*args, **kwargs)

        terminal_tool._create_environment = create_environment
        _installed = True
        return True


def bind(session_id, token, terminal_tool=None):
    """This session's commands now carry this token. Returns True when it took hold."""
    if not isinstance(session_id, str) or not session_id or not isinstance(token, str) or not TOKEN_RE.match(token):
        return False
    port = gate_port()
    if port is None:
        return False
    if terminal_tool is None:
        from tools import terminal_tool
    if not install(terminal_tool):
        return False
    with _lock:
        previous = _tokens.get(session_id)
        _tokens[session_id] = token
    # Ask for a shell of this session's own (keeping whatever else was registered for it, such as a working directory).
    current = dict(terminal_tool._task_env_overrides.get(session_id) or {})
    if current.get("env_type") != "local":
        current["env_type"] = "local"
        terminal_tool.register_task_env_overrides(session_id, current)
    # An agent chat's token never changes, so its shell keeps going. A thread shared by several people gets a new
    # token when someone else asks: the shell that remembers the last person's is closed, and the next command starts
    # a fresh one for this person. A shell made before the session had any token is closed for the same reason.
    with terminal_tool._env_lock:
        live = terminal_tool._active_environments.get(session_id)
    if live is not None and previous != token:
        cleanup = getattr(terminal_tool, "cleanup_vm", None)
        if callable(cleanup):
            try:
                cleanup(session_id)
            except Exception:
                return False
        else:
            return False
    return True


def forget(session_id):
    with _lock:
        _tokens.pop(session_id, None)
