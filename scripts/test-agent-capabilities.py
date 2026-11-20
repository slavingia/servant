#!/usr/bin/env python3
"""What each tool call needs (server/hermes_capabilities.py). Run with any Python: python3 scripts/test-agent-capabilities.py"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from hermes_capabilities import DELETE as D, FS_READ as R, FS_WRITE as W, GH_READ as GR, GH_WRITE as GW, command_needs, describe, in_order, targets, tool_needs


class CommandNeeds(unittest.TestCase):
    def check(self, expected, *commands):
        for command in commands:
            self.assertEqual(command_needs(command), set(expected), command)

    def test_commands_that_only_read(self):
        self.check({R}, "ls -la", "cat README.md", "grep -rn TODO src | head -20", "wc -l *.md && pwd", "cd app && ls", "FOO=1 ls", "cat a 2>/dev/null",
                   "find . -name '*.ts' | sort", "sed -n 1,20p file.txt", "git status", "git log --oneline -5", "git diff HEAD~1", "git -C app show HEAD",
                   "git branch -a", "git remote -v", "git stash list", "/bin/ls", "echo 'a > b'", "")

    def test_commands_that_change_files(self):
        self.check({W}, "rm -rf build", "touch x", "mkdir out", "mv a b", "cp a b", "echo hi > out.txt", "cat a >> b", "ls > listing.txt", "sed -i '' s/a/b/ f",
                   "find . -name '*.tmp' -delete", "find . -exec rm {} ;", "git add -A", "git commit -m x", "git checkout -b new", "git branch new", "git stash",
                   "git reset --hard", "npm install", "python3 script.py", "make", "bash -c 'ls'", "cat f | xargs rm", "ls | tee out", "unknowncommand --flag",
                   "ls; rm x", "ls && touch y", "awk '{print}' f", "sudo rm x", "$(echo rm) x", "echo `date`", "eval ls", "source env.sh", "cat 'unterminated")

    def test_reading_github(self):
        self.check({GR}, "gh pr view 12", "gh pr list --state open", "gh issue list", "gh repo view example-org/example-app", "gh run list", "gh api repos/example-org/example-app/pulls",
                   "gh api -X GET repos/example-org/example-app", "gh search issues bug", "gh auth status", "git ls-remote origin")
        self.check({GR, W}, "git fetch origin", "git pull --rebase", "git clone https://github.com/example-org/example-app", "gh pr checkout 12")
        self.check({GR, R}, "gh pr view 12 && cat README.md")

    def test_changing_github(self):
        self.check({GW}, "git push origin main", "git push", "gh pr create --fill", "gh pr merge 12", "gh issue create -t x", "gh issue comment 3 -b hi", "gh release create v1",
                   "gh api -X POST repos/example-org/example-app/issues", "gh api repos/example-org/example-app/issues -f title=x", "gh api -XPATCH repos/x/y",
                   "gh workflow run build.yml", "gh unknown thing", "gh secret set X")
        self.check({GW, W}, "git commit -am x && git push", "curl -X POST https://api.github.com/repos/x/y/issues", "bash -c 'git push'", "echo $(gh pr merge 1)")
        self.check({GW, R}, "git status; git push")

    def test_deleting_a_branch_a_tag_or_a_repository_asks_for_delete_beside_the_write(self):
        self.check({GW, D}, "git push --delete origin feature", "git push origin --delete feature", "git push -d origin feature", "git push origin :feature",
                   "git push origin +:refs/heads/feature", "git push --mirror backup", "git push --prune origin", "gh repo delete example-org/example-app --yes",
                   "gh api -X DELETE repos/example-org/example-app", "gh api --method DELETE repos/example-org/example-app/git/refs/heads/feature",
                   "gh api -XDELETE repos/example-org/example-app/branches/feature", "gh api --method=DELETE repos/x/y")
        self.check({W, D}, "git branch -D feature", "git branch -d feature", "git branch --delete feature", "git tag -d v1", "git branch -vD old")
        self.check({GW, W, D}, "bash -c 'git push --delete origin x'", "echo $(gh repo delete x --yes)", "curl -X DELETE https://api.github.com/repos/example-org/example-app")
        self.check({GW, D, R}, "git status && git push origin :old")
        # Ordinary pushes and branch work, and deleting something smaller than a branch, do not.
        self.check({GW}, "git push origin main", "git push -u origin feature", "git push --force-with-lease origin feature", "gh pr close 3 --delete-branch=false",
                   "gh api -X DELETE repos/example-org/example-app/issues/comments/9", "gh api -X DELETE repos/example-org/example-app/labels/bug")
        self.check({W}, "git branch new", "git branch -m old new", "git tag v2", "git checkout -b feature")
        self.assertEqual(in_order({R, GR, W, GW, D}), [D, GW, W, GR, R], "the delete is asked about first")

    def test_a_wrong_guess_asks_for_more_never_less(self):
        # Anything this reader cannot follow is able to change files.
        for command in ("x=$(cat f); echo $x", "ls <(cat f)", ". ./env", "python3 -c 'open(\"f\",\"w\")'", "node -e 1", "curl https://example.gov -o f", "open file.pdf", "docker run x", "ssh host ls"):
            self.assertIn(W, command_needs(command), command)
        # A read-only name with an output redirection still writes.
        self.assertIn(W, command_needs("git log > log.txt"))
        self.assertIn(W, command_needs("gh pr view 1 > pr.txt"))


class Targets(unittest.TestCase):
    def named(self, command):
        found = targets("terminal", {"command": command})
        return found["paths"], found["repos"]

    def test_file_tools_name_their_path_exactly(self):
        self.assertEqual(targets("read_file", {"path": "/etc/hosts"}), {"paths": ["/etc/hosts"], "repos": []})
        self.assertEqual(targets("write_file", {"file_path": "src/a.ts"}), {"paths": ["src/a.ts"], "repos": []})
        self.assertEqual(targets("search_files", {"pattern": "x", "path": "../elsewhere"}), {"paths": ["../elsewhere"], "repos": []})
        self.assertEqual(targets("web_search", {"query": "x"}), {"paths": [], "repos": []})
        self.assertEqual(targets("read_file", None), {"paths": [], "repos": []})

    def test_a_command_names_the_places_its_words_show(self):
        self.assertEqual(self.named("ls -la"), ([], []))
        self.assertEqual(self.named("cat ../other/secret.txt && cd /Users/you/elsewhere"), (["../other/secret.txt", "/Users/you/elsewhere"], []))
        self.assertEqual(self.named("git -C ../servant status"), (["../servant"], []))
        self.assertEqual(self.named("cd app && ls ~/Desktop"), (["app", "~/Desktop"], []))
        self.assertEqual(self.named("cp src/a.ts src/../../outside/a.ts"), (["src/../../outside/a.ts"], []))
        self.assertEqual(self.named("grep -rn TODO src"), ([], []), "a plain relative path stays where the command runs")
        self.assertEqual(self.named("curl https://example.gov/x/../y"), ([], []), "a web address is not a path")
        self.assertEqual(targets("terminal", {"command": "ls", "workdir": "/tmp/elsewhere"})["paths"], ["/tmp/elsewhere"])

    def test_a_command_names_the_repositories_it_addresses(self):
        for command in ("gh pr list --repo example-org/other", "gh pr view 3 -R example-org/other", "gh pr list --repo=example-org/other", "gh api repos/example-org/other/issues",
                        "git clone https://github.com/example-org/other.git", "git push git@github.com:example-org/other.git main", "curl https://api.github.com/repos/example-org/other/pulls"):
            self.assertEqual(self.named(command)[1], ["example-org/other"], command)
        self.assertEqual(self.named("gh pr list")[1], [], "no repository named: the one the folder belongs to")
        self.assertEqual(self.named("gh pr list -R not-a-repo")[1], [])

    def test_the_lists_are_short_and_never_fail(self):
        many = " ".join("/tmp/f%d" % i for i in range(60))
        self.assertEqual(len(self.named("cat " + many)[0]), 20)
        self.assertEqual(self.named("cat 'unterminated /etc/hosts"), ([], []), "a command that can't be read names nothing here; it is already asked about as a write")
        self.assertEqual(targets("terminal", {"command": None}), {"paths": [], "repos": []})


class ToolNeeds(unittest.TestCase):
    def test_file_tools_are_exact_and_other_tools_need_nothing(self):
        self.assertEqual(tool_needs("read_file", {"path": "a"}), {R})
        self.assertEqual(tool_needs("search_files", {"pattern": "x"}), {R})
        self.assertEqual(tool_needs("write_file", {"path": "a", "content": "x"}), {W})
        self.assertEqual(tool_needs("patch", {"path": "a"}), {W})
        self.assertEqual(tool_needs("execute_code", {"code": "print(1)"}), {W})
        self.assertEqual(tool_needs("terminal", {"command": "git push"}), {GW})
        self.assertEqual(tool_needs("terminal", {}), {R})
        self.assertEqual(tool_needs("terminal", None), {R})
        for tool in ("web_search", "todo", "memory", "clarify", "delegate_task", "browser_navigate", "vision_analyze"):
            self.assertEqual(tool_needs(tool, {}), set(), tool)

    def test_the_weightiest_is_asked_first_and_the_line_for_the_manager_is_short(self):
        self.assertEqual(in_order({R, GR, W, GW}), [GW, W, GR, R])
        self.assertEqual(describe("terminal", {"command": "git   push\n origin main"}), "Run: git push origin main")
        self.assertEqual(describe("write_file", {"path": "docs/notes.md", "content": "secret text"}), "Write docs/notes.md")
        self.assertEqual(describe("read_file", {"path": "README.md"}), "Read README.md")
        self.assertEqual(describe("search_files", {"pattern": "TODO", "path": "src"}), "Search files for TODO in src")
        self.assertEqual(describe("execute_code", {"code": "x" * 999}), "Use execute_code")
        self.assertEqual(len(describe("terminal", {"command": "echo " + "x" * 999})), 300)


class Guard(unittest.TestCase):
    """The bridge's side of the question (server/hermes_guard.py), against a stand-in for Servant's listener."""

    def setUp(self):
        import json
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer
        import hermes_guard
        self.guard = hermes_guard
        self.asked = asked = []
        self.answers = answers = {}

        class Door(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                asked.append((self.path, body))
                status, answer = answers.get(body["token"], (200, {"verdict": "allow"}))
                data = answer if isinstance(answer, bytes) else json.dumps(answer).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Door)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.guard._turns.clear()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def bind(self, key, token, door=None):
        with self.guard._lock:
            self.guard._turns[key] = (token, door or self.port)

    def test_a_tool_that_needs_nothing_or_a_turn_servant_did_not_mark_is_not_asked_about(self):
        self.bind("sess", "tok")
        self.assertIsNone(self.guard.check("web_search", {"query": "x"}, session_id="sess"))
        self.assertIsNone(self.guard.check("terminal", {"command": "rm -rf x"}, session_id="someone-elses"))
        self.assertEqual(self.asked, [])

    def test_servant_is_asked_with_what_is_needed_and_what_was_about_to_happen(self):
        self.bind("sess", "tok")
        self.assertIsNone(self.guard.check("terminal", {"command": "git commit -am x && git push"}, session_id="sess"))
        self.assertEqual(self.asked, [("/use", {"token": "tok", "needs": [GW, W], "detail": "Run: git commit -am x && git push"})])
        self.assertIsNone(self.guard.check("read_file", {"path": "README.md"}, task_id="sess"), "a tool call may carry the session as its task id")
        self.assertEqual(self.asked[1][1], {"token": "tok", "needs": [R], "detail": "Read README.md", "paths": ["README.md"]})

    def test_servant_is_told_where_the_call_points_so_one_projects_grant_does_not_cover_another(self):
        self.bind("sess", "tok")
        self.guard.check("terminal", {"command": "cat ../other/notes.md && gh pr list --repo example-org/other"}, session_id="sess")
        self.assertEqual(self.asked[0][1]["paths"], ["../other/notes.md"])
        self.assertEqual(self.asked[0][1]["repos"], ["example-org/other"])
        self.guard.check("terminal", {"command": "ls -la"}, session_id="sess")
        self.assertNotIn("paths", self.asked[1][1], "a call that names nowhere sends no list")
        self.assertNotIn("repos", self.asked[1][1])

    def test_anything_but_allow_stops_the_call_with_servants_words(self):
        self.bind("deny", "tok-deny")
        self.bind("wait", "tok-wait")
        self.answers["tok-deny"] = (200, {"verdict": "deny", "message": "Servant blocked this: Pat Tester was declined GitHub write."})
        self.answers["tok-wait"] = (200, {"verdict": "wait", "message": "Jo Park has been asked."})
        self.assertEqual(self.guard.check("terminal", {"command": "git push"}, session_id="deny"), "Servant blocked this: Pat Tester was declined GitHub write.")
        self.assertEqual(self.guard.check("write_file", {"path": "a"}, session_id="wait"), "Jo Park has been asked.")
        self.assertEqual(self.guard._hook(tool_name="write_file", args={"path": "a"}, session_id="wait", telemetry_schema_version=1), {"action": "block", "message": "Jo Park has been asked."})
        self.assertIsNone(self.guard._hook(tool_name="todo", args={}, session_id="wait"))

    def test_a_question_that_cannot_be_asked_or_understood_is_a_refusal(self):
        self.bind("forbidden", "tok-403")
        self.bind("garbage", "tok-garbage")
        self.bind("empty", "tok-empty")
        self.bind("nobody-home", "tok", door=1)
        self.answers["tok-403"] = (403, {"verdict": "deny", "message": "Servant doesn't know whose turn this is."})
        self.answers["tok-garbage"] = (200, b"not json")
        self.answers["tok-empty"] = (200, {})
        self.assertEqual(self.guard.check("patch", {"path": "a"}, session_id="forbidden"), "Servant doesn't know whose turn this is.")
        for session in ("garbage", "empty", "nobody-home"):
            message = self.guard.check("patch", {"path": "a"}, session_id=session)
            self.assertIsInstance(message, str, session)
            self.assertTrue(message, session)
        # Even an error inside the check itself stops the call rather than letting it through.
        self.bind("broken", "tok")
        original, self.guard.check = self.guard.check, lambda *a, **k: 1 / 0
        try:
            self.assertEqual(self.guard._hook(tool_name="patch", args={}, session_id="broken")["action"], "block")
        finally:
            self.guard.check = original

    def test_binding_needs_a_token_and_a_port(self):
        for token, door in (("", "8790"), ("tok", ""), ("tok", "abc"), ("tok", "0"), ("tok", "70000"), (None, "8790")):
            self.assertFalse(self.guard.bind(["s"], token, door), (token, door))
        self.assertEqual(self.guard._turns, {})


if __name__ == "__main__":
    unittest.main(verbosity=1)
