"""Run keys: Servant names each run before it starts it, so it can stop the run
(or make sure it never starts) even when the bridge's "run created" reply is
lost or late.

Pure bookkeeping, no Hermes imports, so it is unit-tested on its own
(server/test_servant_run_keys.py). hermes_bridge.py wires it to the runs API.

States:
  starting     the start request is being handled; no run ID yet
  running      the start returned this run ID
  not_started  the start failed; the key may be used again
  refused      stopped before any run started; a later start with this key is refused
A stop that arrives while a key is starting is remembered: the run is stopped
as soon as its ID is known, and its start is answered as cancelled.
"""
from __future__ import annotations

import re
from collections import OrderedDict

KEY_RE = re.compile(r"^servant_[A-Za-z0-9_-]{1,120}$")
HEADER = "X-Servant-Run-Key"
PREFIX = "servant-key."  # /v1/runs/servant-key.<key> and /v1/runs/servant-key.<key>/stop
# Hermes 0.22 adds "interrupted": the gateway restarted before the run settled.
TERMINAL = frozenset({"completed", "cancelled", "failed", "expired", "interrupted"})


def valid_key(key):
    return isinstance(key, str) and bool(KEY_RE.match(key))


class RunKeys:
    def __init__(self, limit=4096):
        self.limit = limit
        self._entries = OrderedDict()

    def _put(self, key, entry):
        self._entries[key] = entry
        self._entries.move_to_end(key)
        # Forget the oldest keys that hold no run first (refused, not started), then the
        # oldest running ones; a key that's starting is never dropped. Forgetting a
        # running key only loses the lookup: its run still has its ID.
        while len(self._entries) > self.limit:
            old = next((k for k, v in self._entries.items() if v["state"] in ("refused", "not_started")), None)
            if old is None:
                old = next((k for k, v in self._entries.items() if v["state"] == "running"), None)
            if old is None:
                break
            self._entries.pop(old)

    def get(self, key):
        entry = self._entries.get(key)
        return dict(entry) if entry else None

    def begin(self, key):
        """Before a start. Returns (True, None) to go ahead, or (False, entry) when
        the key is refused (stopped earlier) or already has a run or a start."""
        entry = self._entries.get(key)
        if entry and entry["state"] != "not_started":
            return False, dict(entry)
        self._put(key, {"state": "starting", "run_id": None, "cancel": False})
        return True, None

    def started(self, key, run_id):
        """After a start returned run_id. Returns True when a stop arrived meanwhile:
        the caller must stop the run now."""
        entry = self._entries.get(key) or {"cancel": False}
        cancel = bool(entry.get("cancel"))
        self._put(key, {"state": "running", "run_id": run_id, "cancel": cancel})
        return cancel

    def failed(self, key):
        """The start failed: nothing runs. A stop that arrived meanwhile still refuses the key."""
        entry = self._entries.get(key) or {"cancel": False}
        self._put(key, {"state": "refused" if entry.get("cancel") else "not_started", "run_id": None, "cancel": bool(entry.get("cancel"))})

    def cancel(self, key):
        """A stop by key. Returns ("stop", run_id) when the caller must stop that run,
        ("pending", None) when the start is still in progress (it's stopped when it
        returns), or ("refused", None) when no run exists: the key can't start one."""
        entry = self._entries.get(key)
        if entry and entry["state"] == "running":
            entry["cancel"] = True
            return "stop", entry["run_id"]
        if entry and entry["state"] == "starting":
            entry["cancel"] = True
            return "pending", None
        # Unknown here: nothing this bridge started has this key (or the bridge
        # restarted, and its runs ended with it). Refuse it from now on.
        self._put(key, {"state": "refused", "run_id": None, "cancel": True, "unknown": True})
        return "refused", None


def describe(key, entry, run_status=None):
    """The status-by-key reply. `run_status` is the run's own status, or "gone"
    when the bridge no longer holds it. `stopped` is true once nothing can run."""
    state = entry["state"]
    if state == "running" and (run_status in TERMINAL or run_status == "gone"):
        state = "ended"
    return {
        "object": "servant.run_key", "key": key, "state": state, "run_id": entry.get("run_id"),
        "run_status": run_status, "stop_requested": bool(entry.get("cancel")),
        "stopped": state in ("ended", "refused", "not_started"),
        # True when the stop arrived for a key this bridge had never seen.
        "unknown_before_stop": bool(entry.get("unknown")),
    }
