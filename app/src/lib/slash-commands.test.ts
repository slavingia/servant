import { test } from "node:test";
import assert from "node:assert/strict";
import { helpText, parseSlash, resolvePeople, SLASH_COMMANDS, slashMatches, splitDm } from "./slash-commands.ts";

test("the command list shows while typing a slash at the start, filtered", () => {
  assert.ok(slashMatches("/", true)!.length >= 8);
  assert.deepEqual(slashMatches("/ar", true)!.map(c => c.name), ["archive"]);
  assert.deepEqual(slashMatches("/ar", false)!.map(c => c.name), ["archive"], "archive works in a DM too");
  assert.deepEqual(slashMatches("/in", true)!.map(c => c.name), ["invite"]);
  assert.equal(slashMatches("/in", false)!.length, 0, "channel commands hide in DMs");
  assert.equal(slashMatches("hello /in", true), null);
  assert.equal(slashMatches("/invite @m", true), null, "list closes once you add arguments");
});

test("commands parse; paths and unknown words stay ordinary messages", () => {
  assert.deepEqual(parseSlash("/invite @maya @sam", true)?.args, "@maya @sam");
  assert.equal(parseSlash("/RENAME  refund-desk ", true)?.args, "refund-desk");
  assert.equal(parseSlash("/topic hi", true), null, "no topics");
  assert.equal(parseSlash("/leave", true)?.name, "leave");
  assert.equal(parseSlash("/leave", false), null, "channel-only in a DM is just text");
  assert.equal(parseSlash("/usr/local/bin is the path", true), null);
  assert.equal(parseSlash("/notacommand hi", true), null);
  assert.equal(parseSlash("hi /invite @maya", true), null);
});

test("people resolve by @handle, full name or a unique first name", () => {
  const people = [{ id: "1", name: "Maya Ortiz" }, { id: "2", name: "Sam Patel" }, { id: "3", name: "Sam Lee" }, { id: "4", name: "José Núñez" }];
  const r = resolvePeople("@maya-ortiz, sam-lee @jose @sam nobody", people);
  assert.deepEqual(r.found.map(p => p.id), ["1", "3", "4"]);
  assert.deepEqual(r.unknown, ["@sam", "nobody"], "ambiguous first names and strangers are reported");
  assert.deepEqual(splitDm("@maya can you cover 2pm?"), { who: "@maya", message: "can you cover 2pm?" });
});

test("every command says where it works, and the lists follow that", () => {
  for (const c of SLASH_COMMANDS) assert.ok(["channel", "talk", "agent", "any"].includes(c.where), c.name);
  const names = (isChannel: boolean, agent: boolean) => slashMatches("/", isChannel, agent)!.map(c => c.name).sort();
  assert.deepEqual(names(false, true), ["archive", "browse", "help", "new", "people", "stop"], "an agent chat: only what makes sense there");
  assert.ok(!names(true, false).includes("stop"), "stop is for agent chats only");
  assert.ok(!names(false, false).includes("invite") && names(true, false).includes("invite"));
  for (const name of ["archive", "new", "browse", "people", "help"]) {
    for (const [isChannel, agent] of [[true, false], [false, false], [false, true]] as const) assert.ok(names(isChannel, agent).includes(name), `${name} everywhere`);
  }
});

test("the new commands parse in the right places and nowhere else", () => {
  assert.equal(parseSlash("/archive", true)?.name, "archive");
  assert.equal(parseSlash("/archive", false, true)?.name, "archive");
  assert.equal(parseSlash("/stop", false, true)?.name, "stop");
  assert.equal(parseSlash("/stop", true), null, "stop in a channel is just text");
  assert.equal(parseSlash("/call", false, true), null, "channel commands don't run in an agent chat");
  assert.equal(parseSlash("/invite @maya", false, true), null);
  assert.equal(parseSlash("/archive old stuff", true)?.args, "old stuff");
});

test("/help lists exactly the commands that work in that kind of conversation", () => {
  const agentHelp = helpText(false, true).split("\n");
  assert.equal(agentHelp.length, 6);
  assert.ok(agentHelp.some(l => l.startsWith("/stop")) && !agentHelp.some(l => l.startsWith("/invite")));
  const channelHelp = helpText(true).split("\n");
  assert.ok(channelHelp.some(l => l.startsWith("/invite")) && !channelHelp.some(l => l.startsWith("/stop")));
  assert.ok(channelHelp.every(l => /^\/[a-z]+( .*)? — .+/.test(l)));
});
