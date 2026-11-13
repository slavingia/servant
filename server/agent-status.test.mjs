import { test } from "node:test";
import assert from "node:assert/strict";
import { toolStatusLine, WORKING_LINE } from "./agent-status.mjs";

test("tool calls read as plain language, never raw tool names", () => {
  for (const name of ["terminal", "execute_code", "web_search", "web_extract", "browser_navigate", "read_file", "patch", "search_files", "delegate_task", "session_search", "memory", "skill_view", "mcp_github_list"]) {
    const line = toolStatusLine(name);
    assert.ok(!line.includes(name) && !/_/.test(line), `${name} -> ${line}`);
    assert.match(line, /^[A-Z][a-z]/);
  }
  assert.equal(toolStatusLine("terminal"), "Running a command");
});

test("limited agents and unknown tools get the neutral line", () => {
  assert.equal(toolStatusLine("terminal", { full: false }), WORKING_LINE);
  assert.equal(toolStatusLine("some_new_tool"), WORKING_LINE);
  assert.equal(toolStatusLine(undefined), WORKING_LINE);
});

test("step details keep what the agent is doing and mask secrets", async () => {
  const { stepDetail } = await import("./agent-status.mjs");
  assert.equal(stepDetail("git   status\n --short"), "git status --short");
  assert.equal(stepDetail("curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' https://x"), "curl -H 'Authorization: Bearer •••' https://x");
  assert.equal(stepDetail("export OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234"), "export OPENAI_API_KEY=•••");
  assert.equal(stepDetail("PASSWORD=hunter2 npm start"), "PASSWORD=••• npm start");
  assert.equal(stepDetail("push ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "push •••");
  assert.equal(stepDetail("word ".repeat(100)).length, 160);
  assert.ok(stepDetail("word ".repeat(100)).endsWith("…"));
  assert.equal(stepDetail(undefined), "");
});
