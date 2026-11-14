import { test } from "node:test";
import assert from "node:assert/strict";
import { helpText, parseSlash, queuedMessage, resolvePeople, SLASH_COMMANDS, slashMatches, splitDm } from "./slash-commands.ts";

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
  assert.deepEqual(names(false, true), ["archive", "browse", "help", "new", "people", "queue", "stop"], "an agent chat: only what makes sense there");
  assert.ok(!names(true, false).includes("queue") && !names(false, false).includes("queue"), "queue is for agent chats only");
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
  assert.equal(agentHelp.length, 7);
  assert.ok(agentHelp.includes("/queue message — Send it after the current reply, not into it"));
  assert.ok(agentHelp.some(l => l.startsWith("/stop")) && !agentHelp.some(l => l.startsWith("/invite")));
  const channelHelp = helpText(true).split("\n");
  assert.ok(channelHelp.some(l => l.startsWith("/invite")) && !channelHelp.some(l => l.startsWith("/stop")));
  assert.ok(channelHelp.every(l => /^\/[a-z]+( .*)? — .+/.test(l)));
});

test("commands for a feature the server turned off are not offered, parsed or listed in /help", () => {
  const off = { channels: false, directMessages: false, meetings: false, secureInbox: false, people: true };
  const names = (list: { name: string }[] | null) => (list ?? []).map(c => c.name);
  assert.ok(names(slashMatches("/", true, false, off)).every(n => !["call", "dm", "new", "browse"].includes(n)));
  assert.ok(names(slashMatches("/", true, false, { ...off, channels: true })).includes("browse"), "browse stays while channels are on");
  assert.ok(names(slashMatches("/", false, true, off)).every(n => !["new", "browse"].includes(n)));
  assert.equal(parseSlash("/call", true, false, { ...off, channels: true, directMessages: true }), null, "no calls without meetings");
  assert.ok(parseSlash("/call", true), "everything on by default");
  assert.equal(parseSlash("/new", false, true, { ...off, channels: true }), null, "no new message without DMs");
  assert.equal(parseSlash("/browse", false, true, { ...off, directMessages: true }), null, "no browsing without channels");
  assert.ok(parseSlash("/people", false, true, off) && parseSlash("/help", false, true, off));
  assert.equal(parseSlash("/people", false, true, { ...off, people: false }), null, "deep work: no /people");
  assert.doesNotMatch(helpText(true, false, off), /\/call|\/dm|\/new|\/browse/);
  assert.match(helpText(true, false, { ...off, meetings: true }), /\/call/);
});

test("/queue carries a message: the text after it is what gets sent later", () => {
  assert.equal(queuedMessage("/queue fix the title next"), "fix the title next");
  assert.equal(queuedMessage("  /QUEUE   two lines\nof text  "), "two lines\nof text");
  assert.equal(queuedMessage("/queue /stop"), "/stop", "what follows is a message, never a command to run");
  assert.equal(queuedMessage("/queue"), "", "nothing to send yet");
  assert.equal(queuedMessage("/queue   "), "");
  assert.equal(queuedMessage("/queued up"), null, "another word");
  assert.equal(queuedMessage("please /queue this"), null, "only at the start");
  assert.equal(queuedMessage("hello"), null);
  assert.equal(slashMatches("/q", false, true)?.[0]?.name, "queue", "offered as you type it");
});
