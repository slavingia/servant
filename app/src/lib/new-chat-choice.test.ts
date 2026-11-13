import test from "node:test";
import assert from "node:assert/strict";
import { VIBE_CHOICE, choiceName, needsNewChat, newChatOptions, offered } from "./new-chat-choice.ts";
import type { Projects } from "./projects-store.ts";

const projects = { list: [{ id: "expo", name: "Expo app" }], vibeCoder: false, vibe: true } as unknown as Projects;

test("choices the server offers", () => {
  assert.equal(offered(projects, "expo"), true);
  assert.equal(offered(projects, VIBE_CHOICE), true);
  assert.equal(offered(projects, "gone"), false);
  assert.equal(offered({ ...projects, vibe: false }, VIBE_CHOICE), false);
  assert.equal(offered(null, "expo"), false);
  assert.equal(offered(projects, null), false);
});

test("names fall back to just the agent", () => {
  assert.equal(choiceName(projects, "expo"), "Expo app");
  assert.equal(choiceName(projects, VIBE_CHOICE), "Prototyping");
  assert.equal(choiceName(projects, "gone"), "Agent");
  assert.equal(choiceName(null, "expo"), "Agent");
});

test("request body per choice", () => {
  assert.deepEqual(newChatOptions(VIBE_CHOICE), { mode: "vibe" });
  assert.deepEqual(newChatOptions("expo"), { projectId: "expo" });
  assert.deepEqual(newChatOptions(null), {});
});

test("only vibe mode needs a fresh chat", () => {
  assert.equal(needsNewChat(null, "expo"), false);
  assert.equal(needsNewChat("expo", null), false);
  assert.equal(needsNewChat(null, VIBE_CHOICE), true);
  assert.equal(needsNewChat(VIBE_CHOICE, "expo"), true);
  assert.equal(needsNewChat(VIBE_CHOICE, VIBE_CHOICE), false);
});
