"""Give each Servant session's terminal its own environment: its way through the network gate, and its person's
own credentials (docs/agent-egress.md, docs/connections.md).

The sandbox starts the bridge with HTTPS_PROXY pointing at the gate. That address carries no name, so the gate
can only judge such traffic for everyone whose agent is working. Here each session's commands get the same address
with that session's token in it, so the gate knows whose they are.

A person can also connect tools of their own (a GitHub token, a Jira login). Servant hands the bridge that person's
variables at the start of their turn, and they go into that session's shell and nowhere else: never into this
process's environment, never into another session's shell.

Two things in Hermes make this more than setting a variable:
  - every session shares one local shell unless it asks for its own, and that shell re-reads the variables the
    previous command exported, so one session's token would leak into the next session's commands;
  - a shell records its variables once when it starts, so they have to be there before it starts.
So a session with a token or credentials gets its own local shell, created with them already in its environment.
Hermes also takes GH_TOKEN and other well-known secrets out of every command's environment unless they are handed
over under its "force" prefix, which is how a person's own credentials are passed.

This keeps a command honest about whose it is; it is not a wall between sessions. Commands run as the same user on
the same computer, and one that goes looking can read another's environment.
"""
import inspect
import json
import logging
import os
import re
import threading
import urllib.error
import urllib.request

PROXY_NAMES = ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy")
TOKEN_RE = re.compile(r"^[A-Za-z0-9._-]{20,600}$")
NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
HEADER = "X-Servant-Egress-Token"
CONNECTIONS_HEADER = "X-Servant-Connections-Door"
MAX_VARIABLES = 64
FETCH_TIMEOUT = 5

logger = logging.getLogger("servant.bridge")

_lock = threading.Lock()
# session id -> the variables its own shell starts with. Held in memory only, for as long as the session is bound.
_shells = {}
_installed = False
# Never through a proxy: the question goes to this computer, and inside the sandbox the proxy variables point at the gate.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


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


def clean_env(env):
    """Only what can be an environment variable: a plain name, a one-line value. Proxy variables are never taken from here."""
    if not isinstance(env, dict):
        return {}
    clean = {}
    for name, value in env.items():
        if len(clean) >= MAX_VARIABLES:
            break
        if not isinstance(name, str) or not NAME_RE.match(name) or name in PROXY_NAMES or name.upper().startswith(("HERMES_", "_HERMES_", "SERVANT_")):
            continue
        if not isinstance(value, str) or not value or len(value) > 4096 or any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
            continue
        clean[name] = value
    return clean


def force_prefix():
    """Hermes drops GH_TOKEN and its like from a command's environment unless the name carries this prefix. "" on a Hermes without one."""
    try:
        from tools.environments import local
        prefix = getattr(local, "_HERMES_PROVIDER_ENV_FORCE_PREFIX", "")
        return prefix if isinstance(prefix, str) else ""
    except Exception:
        return ""


def fetch_connections(token, door, opener=None):
    """Ask Servant for this turn's person's own variables. None when they could not be fetched; never raises, never logs a value."""
    if not isinstance(token, str) or not TOKEN_RE.match(token) or not str(door).isdigit() or not 0 < int(door) < 65536:
        logger.warning("Servant connections: the turn did not say where to fetch this person's credentials; its commands run without them")
        return None
    body = json.dumps({"token": token}).encode("utf-8")
    request = urllib.request.Request("http://127.0.0.1:%d/connections" % int(door), data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with (opener or _opener).open(request, timeout=FETCH_TIMEOUT) as response:
            answer = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        logger.warning("Servant connections: Servant answered %s; this turn's commands run without the person's own credentials", error.code)
        return None
    except Exception as error:
        # The error's own words could repeat the request; only its kind is logged.
        logger.warning("Servant connections: could not ask Servant (%s); this turn's commands run without the person's own credentials", type(error).__name__)
        return None
    env = answer.get("env") if isinstance(answer, dict) else None
    if not isinstance(env, dict):
        logger.warning("Servant connections: Servant's answer could not be read; this turn's commands run without the person's own credentials")
        return None
    return clean_env(env)


def shell_env(token, port, extra_env):
    """The variables a session's own shell starts with: the named proxy address (with the gate on) and the person's own."""
    env = proxy_env(token, port) if port else {}
    prefix = force_prefix()
    for name, value in clean_env(extra_env).items():
        env[prefix + name] = value
    return env


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
            with _lock:
                env = dict(_shells.get(task_id) or {}) if task_id else {}
            if bound.arguments.get("env_type") == "local" and env:
                return terminal_tool._LocalEnvironment(cwd=bound.arguments.get("cwd") or "", timeout=bound.arguments.get("timeout") or 60, env=env)
            return original(*args, **kwargs)

        terminal_tool._create_environment = create_environment
        _installed = True
        return True


def _close_shell(session_id, terminal_tool):
    """Close a session's running shell, so the next command starts a fresh one. False when it could not be closed."""
    with terminal_tool._env_lock:
        live = terminal_tool._active_environments.get(session_id)
    if live is None:
        return True
    cleanup = getattr(terminal_tool, "cleanup_vm", None)
    if not callable(cleanup):
        return False
    try:
        cleanup(session_id)
    except Exception:
        return False
    return True


def bind(session_id, token, terminal_tool=None, extra_env=None):
    """This session's commands now carry this token to the gate and have these variables. Returns True when it took hold."""
    if not isinstance(session_id, str) or not session_id or not isinstance(token, str) or not TOKEN_RE.match(token):
        return False
    env = shell_env(token, gate_port(), extra_env)
    if terminal_tool is None:
        from tools import terminal_tool
    with _lock:
        previous = _shells.get(session_id)
    if not env:
        # No gate and nothing of the person's own: the session keeps the shared shell. One that had variables before
        # (a connection since removed, or one that could not be fetched this time) must not keep a shell that remembers them.
        if previous is not None:
            forget(session_id)
            if installed_for(terminal_tool):
                _close_shell(session_id, terminal_tool)
        return False
    if not install(terminal_tool):
        return False
    with _lock:
        _shells[session_id] = env
    # Ask for a shell of this session's own (keeping whatever else was registered for it, such as a working directory).
    current = dict(terminal_tool._task_env_overrides.get(session_id) or {})
    if current.get("env_type") != "local":
        current["env_type"] = "local"
        terminal_tool.register_task_env_overrides(session_id, current)
    # A shell keeps the variables it started with. While nothing changes it keeps going. A thread shared by several
    # people gets a new token when someone else asks, and a person may save, replace or remove a credential between
    # turns: the shell that remembers the old ones is closed, and the next command starts a fresh one. A shell made
    # before the session had any is closed for the same reason.
    if previous != env and not _close_shell(session_id, terminal_tool):
        return False
    return True


def installed_for(terminal_tool):
    return all(hasattr(terminal_tool, name) for name in ("_active_environments", "_env_lock"))


def forget(session_id):
    with _lock:
        _shells.pop(session_id, None)
