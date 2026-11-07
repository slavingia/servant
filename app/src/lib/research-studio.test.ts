import assert from "node:assert/strict";
import test from "node:test";
import {
  RESEARCH_TASKS,
  buildResearchPrompt,
  missingResearchFields,
  researchChatKind,
  researchChatTitle,
  researchChats,
  researchDisplayTitle,
  type ResearchBrief,
} from "./research-studio.ts";
import type { Chat } from "./server.ts";

const chat = (id: string, title: string, updatedAt = 1) => ({ id, title, createdAt: 1, updatedAt }) as Chat;

test("Research Studio offers the three distinct planning tasks", () => {
  assert.deepEqual(RESEARCH_TASKS.map(task => task.kind), ["study", "synthesis", "design-review"]);
  assert.equal(RESEARCH_TASKS.find(task => task.kind === "design-review")?.actionLabel, "Run a research-informed design review");
  assert.equal(new Set(RESEARCH_TASKS.map(task => task.titlePrefix)).size, RESEARCH_TASKS.length);
  for (const task of RESEARCH_TASKS) {
    assert.ok(task.fields.some(field => field.required));
    assert.ok(task.requestedOutput.length >= 3);
  }
});

test("title prefixes identify ordinary research chats and keep their useful title", () => {
  const title = researchChatTitle("study", "  Refund   status interviews  ");
  assert.equal(title, "[Research study] Refund status interviews");
  const item = chat("one", title);
  assert.equal(researchChatKind(item), "study");
  assert.equal(researchDisplayTitle(item), "Refund status interviews");
  assert.equal(researchChatKind(chat("ordinary", "Refund status interviews")), null);
  assert.ok(researchChatTitle("design-review", "x".repeat(200)).length <= 80);
});

test("the library keeps only prefixed research work and sorts newest first", () => {
  const older = chat("older", researchChatTitle("synthesis", "Support themes"), 10);
  const newer = chat("newer", researchChatTitle("design-review", "Account flow"), 30);
  const ordinary = chat("ordinary", "General agent chat", 40);
  assert.deepEqual(researchChats([older, ordinary, newer]).map(item => item.id), ["newer", "older"]);
});

test("the structured prompt is readable in every Servant client and omits empty optional fields", () => {
  const brief: ResearchBrief = {
    kind: "study",
    title: "Payment plan usability",
    answers: {
      decision: "Choose which payment-plan flow to ship.",
      question: "Where do people lose confidence?",
      participants: "People who recently set up a payment plan.",
      method: "",
      constraints: "Five sessions in two weeks.",
    },
  };
  assert.deepEqual(missingResearchFields(brief), []);
  const prompt = buildResearchPrompt(brief);
  assert.match(prompt, /^\[Research study\] Payment plan usability/);
  assert.match(prompt, /Decision this study should inform: Choose which payment-plan flow to ship\./);
  assert.match(prompt, /participant criteria/);
  assert.match(prompt, /Do not contact participants/);
  assert.doesNotMatch(prompt, /Method ideas:/);
});

test("required-field validation returns user-facing labels", () => {
  assert.deepEqual(missingResearchFields({ kind: "synthesis", title: "", answers: {} }), [
    "Working title",
    "Decision this synthesis should inform",
    "Evidence to synthesize",
    "Synthesis question",
  ]);
});

test("design reviews require dated Research Hub evidence without claiming validation", () => {
  const prompt = buildResearchPrompt({
    kind: "design-review",
    title: "Account recovery flow",
    answers: {
      inputs: "A mobile recovery prototype",
      decision: "Choose what to test next",
      participants: "People locked out of an account",
    },
  });
  assert.match(prompt, /Search the Research Hub/);
  assert.match(prompt, /title, link or catalog reference/);
  assert.match(prompt, /publication or data date/);
  assert.match(prompt, /Clearly label evidence gaps/);
  assert.match(prompt, /Never claim that the design is validated or approved/);
  assert.match(prompt, /Working agreement:/);
});
