// The connection form's rules and words (connections.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { cardLine, cardState, createHost, fieldProblem, fieldValid, formValid, formValues, KEPT_OUT_LINE, openLabel, parseConnectParts, parseTool, savedLine, standingLine, timesLine, type ConnectTool } from "./connections.ts";

// Made-up values in the shapes the real ones have, put together here so no file holds one whole.
const CLASSIC = "ghp_" + "x".repeat(32) + "a1b2";
const FINE = "github_pat_" + "y".repeat(40) + "c3d4";
const github: ConnectTool = { id: "github", name: "GitHub", heading: "GitHub token for your account", help: "Needed so the agent works on GitHub as you, with only your access.",
  createUrl: "https://github.com/settings/personal-access-tokens/new", hosts: ["github.com"],
  fields: [{ key: "token", label: "Personal access token", placeholder: "github_pat_… or ghp_…", pattern: "^(?:github_pat_[A-Za-z0-9_]{22,255}|gh[pousr]_[A-Za-z0-9]{36,255})$", secret: true }] };
const jira: ConnectTool = { id: "jira", name: "Jira", heading: "Jira API token", help: "", createUrl: "https://id.atlassian.com/manage-profile/security/api-tokens", hosts: [],
  fields: [{ key: "site", label: "Jira site", placeholder: "example.atlassian.net", pattern: "^[a-z0-9][a-z0-9-]{0,62}\\.atlassian\\.net$", secret: false },
    { key: "email", label: "Your Jira email", placeholder: "you@example.gov", pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", secret: false },
    { key: "token", label: "API token", placeholder: "ATATT…", pattern: "^[A-Za-z0-9_=-]{20,512}$", secret: true }] };

test("Save is off until every field fits its pattern", () => {
  const token = github.fields[0]!;
  for (const good of [CLASSIC, FINE, `  ${CLASSIC}\n`]) assert.equal(fieldValid(token, good), true, good);
  for (const bad of ["", "   ", "hunter2", "ghp_short", `${CLASSIC} ${CLASSIC}`, `x${CLASSIC}`, "a\u0000b"]) assert.equal(fieldValid(token, bad), false, JSON.stringify(bad));
  assert.equal(formValid(github, {}), false);
  assert.equal(formValid(github, { token: CLASSIC }), true);
  assert.equal(formValid(jira, { site: "example.atlassian.net", email: "pat@example.gov" }), false, "every field is needed");
  assert.equal(formValid(jira, { site: "example.atlassian.net", email: "pat@example.gov", token: "ATATT3" + "z".repeat(40) }), true);
  assert.equal(formValid(jira, { site: "https://example.atlassian.net", email: "pat@example.gov", token: "ATATT3" + "z".repeat(40) }), false);
  // A field with no pattern takes anything typed; one whose pattern this phone can't read is left to the server.
  assert.equal(fieldValid({ key: "k", label: "Key", placeholder: "", secret: true }, "anything"), true);
  assert.equal(fieldValid({ key: "k", label: "Key", placeholder: "", pattern: "(", secret: true }, "anything"), true);
  assert.equal(fieldValid({ key: "k", label: "Key", placeholder: "", secret: true }, "x".repeat(2001)), false);
});

test("a field says what is wrong only once something is typed, and what is sent is trimmed", () => {
  const token = github.fields[0]!;
  assert.equal(fieldProblem(token, ""), null);
  assert.equal(fieldProblem(token, CLASSIC), null);
  assert.equal(fieldProblem(token, "hunter2"), "That doesn't look like personal access token. It should look like github_pat_… or ghp_…");
  assert.equal(fieldProblem({ key: "k", label: "API key", placeholder: "", pattern: "^a$", secret: true }, "b"), "That doesn't look like api key");
  assert.deepEqual(formValues(jira, { site: " example.atlassian.net ", email: "pat@example.gov", token: " t ", extra: "not sent" }), { site: "example.atlassian.net", email: "pat@example.gov", token: "t" });
});

test("the button names the site the token is made on", () => {
  assert.equal(openLabel(github), "Open github.com");
  assert.equal(openLabel(jira), "Open id.atlassian.com");
  assert.equal(createHost({ ...github, createUrl: "https://www.example.gov/keys" }), "example.gov");
  assert.equal(createHost({ ...github, createUrl: "" }), "");
});

test("a saved card shows the last four characters and never a value", () => {
  assert.equal(savedLine(github, "a1b2"), "GitHub token saved · ••••a1b2");
  assert.equal(savedLine(github), "GitHub token saved");
  assert.equal(cardLine("saved", jira, "g7h8"), "Jira token saved · ••••g7h8");
  assert.equal(cardLine("declined", github), "Declined");
  assert.equal(cardLine("removed", github), "GitHub token removed");
  assert.equal(KEPT_OUT_LINE, "Kept out of chat. Only your agent's commands can use it.");
});

test("what the card is: a form for the person asked, a line for anyone else, and what happened here wins", () => {
  assert.equal(cardState({ mine: true, status: "open", agent: "full" }), "form");
  assert.equal(cardState({ mine: true, status: "open" }), "form");
  assert.equal(cardState({ mine: true, status: "open", agent: "restricted" }), "restricted");
  assert.equal(cardState({ mine: true, status: "open", agent: "none" }), "restricted");
  assert.equal(cardState({ mine: true, status: "saved", agent: "full" }), "saved");
  assert.equal(cardState({ mine: true, status: "declined", agent: "full" }), "declined");
  assert.equal(cardState({ mine: true, status: "removed", agent: "full" }), "removed");
  assert.equal(cardState({ mine: true, status: "open", agent: "full" }, "saved"), "saved", "saved a moment ago on this phone");
  assert.equal(cardState({ mine: true, status: "open", agent: "full" }, "declined"), "declined");
  // Someone else reading the chat never gets a form, whatever its state.
  assert.equal(cardState({ mine: false, status: "open", agent: "full" }, "saved"), "asked");
  assert.equal(cardLine("asked", github, undefined, "open"), "The agent asked for a GitHub token");
  assert.equal(cardLine("asked", github, "a1b2", "saved"), "GitHub token saved", "not even the last four characters");
  assert.equal(cardLine("asked", github, undefined, "declined"), "Declined to connect GitHub");
});

test("Connections says where you stand, when it was saved and when it was last used", () => {
  const now = new Date(2026, 10, 18, 12).getTime();
  assert.equal(standingLine(null), "Not connected");
  assert.equal(standingLine({ type: "github", last4: "a1b2", savedAt: now }), "Connected ••••a1b2");
  assert.equal(standingLine({ type: "github", last4: "a1b2", account: "@pat", savedAt: now }), "Connected as @pat ••••a1b2");
  assert.equal(timesLine(null, now), "");
  assert.match(timesLine({ type: "github", last4: "a1b2", savedAt: new Date(2026, 10, 17).getTime() }, now), /^Saved .*17.* · Not used yet$/);
  assert.match(timesLine({ type: "github", last4: "a1b2", savedAt: new Date(2025, 2, 3).getTime(), usedAt: now }, now), /^Saved .*2025.* · Last used .*18.*$/);
});

test("a tool type and a message's connect parts are read from the server with care", () => {
  assert.deepEqual(parseTool({ ...github, env: { GH_TOKEN: "{token}" } }), github, "only what the form needs is kept");
  assert.equal(parseTool({ id: "x", name: "X", fields: [] }), null);
  assert.equal(parseTool({ id: "x", fields: [{ key: "k" }] }), null);
  assert.equal(parseTool(null), null);
  assert.equal(parseTool({ id: "x", name: "X", createUrl: "javascript:alert(1)", fields: [{ key: "k" }] })?.createUrl, "", "only an https address is opened");
  assert.equal(parseTool({ id: "x", name: "X", fields: [{ key: "k" }] })?.heading, "X token for your account");
  const parts = parseConnectParts([
    { requestId: "creq_1", mine: true, status: "saved", last4: "xxxxa1b2", account: "@pat", agent: "full", tool: github, value: "never" },
    { requestId: "creq_2", mine: false, status: "open", tool: jira },
    { requestId: "creq_3", status: "unknown", tool: github }, { requestId: 4, status: "open", tool: github }, { requestId: "creq_5", status: "open" }, null,
  ]);
  assert.deepEqual(parts.map(p => [p.requestId, p.mine, p.status, p.last4, p.tool.id]), [["creq_1", true, "saved", "a1b2", "github"], ["creq_2", false, "open", undefined, "jira"]]);
  assert.ok(!("value" in parts[0]!));
  assert.deepEqual(parseConnectParts(undefined), []);
});
