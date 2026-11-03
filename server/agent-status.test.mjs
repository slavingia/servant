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
