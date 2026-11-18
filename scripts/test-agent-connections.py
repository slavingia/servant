#!/usr/bin/env python3
"""A person's own credentials reach only their own session's shell (server/hermes_egress.py, docs/connections.md).

Run with any Python: python3 scripts/test-agent-connections.py
Hermes's terminal is stood in for here; scripts/test-hermes-compat.py runs the same thing through the real one.
"""
import json
import logging
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import hermes_egress as egress

# Made-up values in the shapes the real ones have, put together here so no file holds one whole.
PAT = "ghp_" + "p" * 32 + "a1b2"
JO = "ghp_" + "j" * 32 + "e5f6"
PAT_TOKEN = "turn-token-for-pat-" + "P" * 12
JO_TOKEN = "turn-token-for-jo-" + "J" * 12
PROXY = ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy", "SERVANT_EGRESS_PORT")


class FakeShell:
    """A local shell as Hermes makes one: it starts with the process's variables plus the ones it was given, and
    remembers what its commands export."""
    made = 0

    def __init__(self, cwd="", timeout=60, env=None):
        FakeShell.made += 1
        self.given = dict(env or {})
        self.exported = {}

    def variable(self, name):
        return self.exported.get(name, self.given.get(name, os.environ.get(name, "")))


class FakeTerminal:
    """The parts of Hermes's tools.terminal_tool that hermes_egress uses."""
    _LocalEnvironment = FakeShell

    def __init__(self):
        self._task_env_overrides = {}
        self._active_environments = {}
        self._env_lock = threading.Lock()
        self.shared = FakeShell()

    def _create_environment(self, env_type, image, cwd, timeout, ssh_config=None, container_config=None, local_config=None, task_id="default", host_cwd=None):
        # Without a shell of its own, a session runs in the one everybody shares.
        return FakeShell(cwd=cwd, timeout=timeout) if env_type == "local" else self.shared

    def register_task_env_overrides(self, task_id, overrides):
        self._task_env_overrides[task_id] = overrides

    def cleanup_vm(self, task_id):
        with self._env_lock:
            self._active_environments.pop(task_id, None)

    def shell(self, task_id):
        """The shell a command in this session runs in, made on first use the way Hermes does."""
        with self._env_lock:
            live = self._active_environments.get(task_id)
        if live is None:
            overrides = self._task_env_overrides.get(task_id) or {}
            live = self._create_environment(overrides.get("env_type", "shared"), "", "", 60, task_id=task_id)
            with self._env_lock:
                self._active_environments[task_id] = live
        return live


class Door(BaseHTTPRequestHandler):
    answers = {}
    asked = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Door.asked.append((self.path, body))
        status, answer = Door.answers.get(body.get("token"), (403, {"error": "Servant doesn't know whose turn this is."}))
        data = answer if isinstance(answer, bytes) else json.dumps(answer).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class Logs(logging.Handler):
    def __init__(self):
        super().__init__()
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())


class SessionShells(unittest.TestCase):
    def setUp(self):
        self.saved = {name: os.environ.get(name) for name in PROXY}
        for name in PROXY:
            os.environ.pop(name, None)
        egress._installed = False
        egress._shells.clear()
        self.terminal = FakeTerminal()

    def tearDown(self):
        for name, value in self.saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    def bind(self, session, token, env=None):
        return egress.bind(session, token, self.terminal, extra_env=env)

    def gate_on(self):
        os.environ["SERVANT_EGRESS_PORT"] = "8790"
        for name in PROXY[:6]:
            os.environ[name] = "http://127.0.0.1:8790"

    def test_each_session_has_its_own_shell_with_its_persons_variables_and_nothing_leaks(self):
        self.assertTrue(self.bind("sess_pat", PAT_TOKEN, {"GH_TOKEN": PAT, "GITHUB_TOKEN": PAT, "JIRA_SITE": "example.atlassian.net"}))
        self.assertTrue(self.bind("sess_jo", JO_TOKEN, {"GH_TOKEN": JO}))
        pat, jo, other = self.terminal.shell("sess_pat"), self.terminal.shell("sess_jo"), self.terminal.shell("sess_other")
        self.assertEqual((pat.variable("GH_TOKEN"), pat.variable("GITHUB_TOKEN"), pat.variable("JIRA_SITE")), (PAT, PAT, "example.atlassian.net"))
        self.assertEqual((jo.variable("GH_TOKEN"), jo.variable("GITHUB_TOKEN"), jo.variable("JIRA_SITE")), (JO, "", ""), "Jo's shell has Jo's, and nothing of Pat's")
        self.assertEqual(other.variable("GH_TOKEN"), "", "a session Servant gave nothing has nothing")
        self.assertIs(other, self.terminal.shared)
        self.assertIsNot(pat, jo)
        self.assertIsNot(pat, self.terminal.shared)
        # What one session's commands export stays in that session's shell.
        pat.exported["PROBE"] = "pat"
        self.assertEqual(self.terminal.shell("sess_jo").variable("PROBE"), "")
        self.assertEqual(self.terminal.shell("sess_pat").variable("PROBE"), "pat")
        # The values never reach this process's own environment, where every session would inherit them.
        self.assertNotIn(PAT, os.environ.values())
        self.assertNotIn(JO, os.environ.values())
        self.assertNotIn("GH_TOKEN", os.environ)
        self.assertEqual(self.terminal.shared.given, {})

    def test_with_the_gate_on_a_shell_has_the_named_proxy_and_the_persons_variables(self):
        self.gate_on()
        self.assertTrue(self.bind("sess_pat", PAT_TOKEN, {"GH_TOKEN": PAT}))
        self.assertTrue(self.bind("sess_jo", JO_TOKEN))
        pat, jo = self.terminal.shell("sess_pat"), self.terminal.shell("sess_jo")
        self.assertEqual(pat.variable("HTTPS_PROXY"), "http://%s:@127.0.0.1:8790" % PAT_TOKEN)
        self.assertEqual(pat.variable("GH_TOKEN"), PAT)
        self.assertEqual(jo.variable("all_proxy"), "http://%s:@127.0.0.1:8790" % JO_TOKEN)
        self.assertEqual(jo.variable("GH_TOKEN"), "", "named for the gate, with no credentials of anyone's")
        self.assertEqual(self.terminal.shell("sess_other").variable("HTTPS_PROXY"), "http://127.0.0.1:8790", "unnamed")

    def test_without_the_gate_a_session_with_nothing_keeps_the_shared_shell(self):
        self.assertFalse(self.bind("sess_plain", PAT_TOKEN))
        self.assertFalse(self.bind("sess_plain", PAT_TOKEN, {}))
        self.assertNotIn("sess_plain", self.terminal._task_env_overrides)
        self.assertIs(self.terminal.shell("sess_plain"), self.terminal.shared)
        for bad in ("", "short", "has space " + "x" * 30, None, 7):
            self.assertFalse(self.bind("sess_bad", bad, {"GH_TOKEN": PAT}), repr(bad))
        self.assertFalse(self.bind("", PAT_TOKEN, {"GH_TOKEN": PAT}))
        self.assertEqual(egress._shells, {})

    def test_a_shell_is_kept_while_nothing_changes_and_replaced_when_the_variables_do(self):
        self.assertTrue(self.bind("sess", PAT_TOKEN, {"GH_TOKEN": PAT}))
        first = self.terminal.shell("sess")
        first.exported["PROBE"] = "kept"
        self.assertTrue(self.bind("sess", PAT_TOKEN, {"GH_TOKEN": PAT}), "the next turn, nothing changed")
        self.assertIs(self.terminal.shell("sess"), first)
        # The person replaced their token: the shell that remembers the old one is closed.
        self.assertTrue(self.bind("sess", PAT_TOKEN, {"GH_TOKEN": JO}))
        second = self.terminal.shell("sess")
        self.assertIsNot(second, first)
        self.assertEqual((second.variable("GH_TOKEN"), second.variable("PROBE")), (JO, ""))
        # They removed it (or it could not be fetched this turn): no shell keeps it.
        self.assertFalse(self.bind("sess", PAT_TOKEN, None))
        third = self.terminal.shell("sess")
        self.assertIsNot(third, second)
        self.assertEqual(third.variable("GH_TOKEN"), "")
        self.assertNotIn("sess", egress._shells)

    def test_a_shell_made_before_the_session_had_anything_is_replaced(self):
        early = self.terminal.shell("sess_late")
        self.assertIs(early, self.terminal.shared)
        self.assertTrue(self.bind("sess_late", PAT_TOKEN, {"GH_TOKEN": PAT}))
        late = self.terminal.shell("sess_late")
        self.assertIsNot(late, self.terminal.shared)
        self.assertEqual(late.variable("GH_TOKEN"), PAT)
        self.assertEqual(self.terminal.shared.variable("GH_TOKEN"), "")

    def test_only_plain_variables_are_taken_and_never_the_proxy_or_the_agents_own(self):
        taken = egress.clean_env({"GH_TOKEN": PAT, "HTTPS_PROXY": "http://elsewhere.example.gov", "https_proxy": "x", "HERMES_HOME": "/tmp/x", "SERVANT_EGRESS_PORT": "1",
                                  "_HERMES_FORCE_OPENAI_API_KEY": "x", "bad name": "x", "": "x", "MULTI": "a\nb", "EMPTY": "", "NUMBER": 7, 9: "x", "OK_2": "fine"})
        self.assertEqual(taken, {"GH_TOKEN": PAT, "OK_2": "fine"})
        self.assertEqual(egress.clean_env(None), {})
        self.assertEqual(egress.clean_env(["GH_TOKEN"]), {})
        self.assertEqual(len(egress.clean_env({"V%d" % i: "x" for i in range(200)})), egress.MAX_VARIABLES)
        self.gate_on()
        self.assertTrue(self.bind("sess", PAT_TOKEN, {"HTTPS_PROXY": "http://elsewhere.example.gov", "GH_TOKEN": PAT}))
        self.assertEqual(self.terminal.shell("sess").variable("HTTPS_PROXY"), "http://%s:@127.0.0.1:8790" % PAT_TOKEN, "the way out is always the gate")


class Fetch(unittest.TestCase):
    """The bridge's question to Servant's local listener, against a stand-in for it."""

    def setUp(self):
        Door.answers, Door.asked = {}, []
        self.server = HTTPServer(("127.0.0.1", 0), Door)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.logs = Logs()
        egress.logger.addHandler(self.logs)
        egress.logger.setLevel(logging.DEBUG)

    def tearDown(self):
        egress.logger.removeHandler(self.logs)
        self.server.shutdown()
        self.server.server_close()

    def test_the_turns_token_fetches_that_persons_variables(self):
        Door.answers[PAT_TOKEN] = (200, {"env": {"GH_TOKEN": PAT, "GITHUB_TOKEN": PAT}, "connections": ["github"]})
        Door.answers[JO_TOKEN] = (200, {"env": {}, "connections": []})
        self.assertEqual(egress.fetch_connections(PAT_TOKEN, self.port), {"GH_TOKEN": PAT, "GITHUB_TOKEN": PAT})
        self.assertEqual(egress.fetch_connections(JO_TOKEN, str(self.port)), {})
        self.assertEqual(Door.asked, [("/connections", {"token": PAT_TOKEN}), ("/connections", {"token": JO_TOKEN})])
        self.assertEqual(self.logs.lines, [])

    def test_a_failure_is_none_and_the_log_says_so_without_a_value(self):
        Door.answers[PAT_TOKEN] = (200, b"not json " + PAT.encode())
        Door.answers[JO_TOKEN] = (200, {"env": [PAT]})
        Door.answers["turn-token-refused-" + "R" * 12] = (403, {"error": "no", "env": {"GH_TOKEN": PAT}})
        self.assertIsNone(egress.fetch_connections(PAT_TOKEN, self.port))
        self.assertIsNone(egress.fetch_connections(JO_TOKEN, self.port))
        self.assertIsNone(egress.fetch_connections("turn-token-refused-" + "R" * 12, self.port), "anything but 200 is nothing")
        self.assertIsNone(egress.fetch_connections(PAT_TOKEN, 1), "nobody listening")
        for token, door in ((PAT_TOKEN, "not-a-port"), (PAT_TOKEN, 0), ("", self.port), (None, self.port), ("short", self.port)):
            self.assertIsNone(egress.fetch_connections(token, door), repr((token, door)))
        self.assertEqual(len(self.logs.lines), 9, "every failure is said")
        for line in self.logs.lines:
            self.assertIn("without", line)
            for secret in (PAT, JO, PAT_TOKEN, JO_TOKEN):
                self.assertNotIn(secret, line)


if __name__ == "__main__":
    unittest.main()
