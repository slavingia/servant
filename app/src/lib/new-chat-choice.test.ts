import test from "node:test";
import assert from "node:assert/strict";
import { VIBE_CHOICE, canChangeChatAbout, choiceName, needsNewChat, newChatMatchesChoice, newChatOptions, offered } from "./new-chat-choice.ts";
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
  assert.equal(choiceName(projects, VIBE_CHOICE), "Design Studio");
  assert.equal(choiceName(projects, "gone"), "Just the agent");
  assert.equal(choiceName(null, "expo"), "Just the agent");
});

test("request body per choice", () => {
  assert.deepEqual(newChatOptions(VIBE_CHOICE), { mode: "vibe" });
  assert.deepEqual(newChatOptions(VIBE_CHOICE, 4), { mode: "vibe", requiredAgentRole: "prototype" });
  assert.deepEqual(newChatOptions("expo"), { projectId: "expo" });
  assert.deepEqual(newChatOptions("expo", 4), { projectId: "expo", requiredAgentRole: "researcher" });
  assert.deepEqual(newChatOptions(null), {});
  assert.deepEqual(newChatOptions(null, 4), { requiredAgentRole: "researcher" });
});

test("created chats must match the requested Researcher or prototype lane", () => {
  assert.equal(newChatMatchesChoice({ mode: "vibe", agentRole: "prototype" }, VIBE_CHOICE, 4), true);
  assert.equal(newChatMatchesChoice({ mode: "vibe", agentRole: "researcher" }, VIBE_CHOICE, 4), false);
  assert.equal(newChatMatchesChoice({ agentRole: "researcher" }, null, 4), true);
  assert.equal(newChatMatchesChoice({ agentRole: "prototype" }, null, 4), false);
  assert.equal(newChatMatchesChoice({ mode: "vibe" }, VIBE_CHOICE, 3), true);
});

test("a prototype workspace cannot be reassigned through the generic project picker", () => {
  assert.equal(canChangeChatAbout(null), true);
  assert.equal(canChangeChatAbout("expo"), true);
  assert.equal(canChangeChatAbout(VIBE_CHOICE), false);
});

test("only vibe mode needs a fresh chat", () => {
  assert.equal(needsNewChat(null, "expo"), false);
  assert.equal(needsNewChat("expo", null), false);
  assert.equal(needsNewChat(null, VIBE_CHOICE), true);
  assert.equal(needsNewChat(VIBE_CHOICE, "expo"), true);
  assert.equal(needsNewChat(VIBE_CHOICE, VIBE_CHOICE), false);
});
