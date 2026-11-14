import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_STUDY_SETUP, newStudyActivity } from "./research-methods.ts";
import { parseResearchFormDraft, researchFormDraft, researchFormDraftEmpty } from "./research-form-draft.ts";

const form = (extra = {}) => researchFormDraft({
  kind: "study", title: "", answers: {}, activities: [], otherMethods: [], setup: DEFAULT_STUDY_SETUP, prototypeMode: "none",
  prototypePurpose: "", researchFindings: "", selectedPrototypeId: null, createdPrototypeId: null, createdPrototypePrompt: null, ...extra,
});

test("an untouched form isn't kept; anything typed or chosen is", () => {
  assert.equal(researchFormDraftEmpty(form()), true);
  assert.equal(researchFormDraftEmpty(form({ answers: { decision: "   " } })), true);
  assert.equal(researchFormDraftEmpty(form({ title: "Balance" })), false);
  assert.equal(researchFormDraftEmpty(form({ researchFindings: "People hesitated." })), false);
  assert.equal(researchFormDraftEmpty(form({ prototypeMode: "new" })), false);
  assert.equal(researchFormDraftEmpty(form({ setup: { ...DEFAULT_STUDY_SETUP, devices: "desktop" } })), false);
  assert.equal(researchFormDraftEmpty(form({ activities: [newStudyActivity("survey", "activity-1")] })), false);
});

test("a saved draft round-trips through storage (JSON) unchanged", () => {
  const activity = { ...newStudyActivity("ab_test", "activity-1"), title: "Compare layouts", perRound: 9, stoppingRuleConfirmed: true };
  const draft = form({
    title: "Balance due page", answers: { decision: "Choose a layout.", question: "Can people find it?" }, activities: [activity],
    setup: { collection: "qualtrics-links", devices: "desktop", lossAllowance: 15 }, prototypeMode: "existing", prototypePurpose: "Find the balance.",
    researchFindings: "People hesitated.", selectedPrototypeId: "cht_ready1", createdPrototypeId: "cht_made1", createdPrototypePrompt: "Prototype: Balance due page",
  });
  assert.deepEqual(parseResearchFormDraft(JSON.parse(JSON.stringify(draft)), "study"), draft);
});

test("a damaged or foreign draft can't put unexpected values on screen", () => {
  assert.equal(parseResearchFormDraft(null, "study"), null);
  assert.equal(parseResearchFormDraft("text", "study"), null);
  assert.equal(parseResearchFormDraft({ ...form(), version: 2 }, "study"), null, "a newer draft format is ignored");
  assert.equal(parseResearchFormDraft(form(), "synthesis"), null, "another form's draft is ignored");
  const parsed = parseResearchFormDraft({
    ...form(),
    title: 42,
    answers: { decision: "Choose", evil: "x", question: 7 },
    activities: [
      { method: "survey", key: "activity-1", title: { html: "<b>" }, perRound: "nine", rounds: 3, goal: "conquer", designs: [{ label: "A", url: 5 }, null] },
      { method: "teleport", key: "activity-2" },
      { method: "prototype", key: "activity-1", instructions: "Find the balance." },
    ],
    setup: { collection: "fax", devices: "phone", lossAllowance: "lots" },
    prototypeMode: "sideways",
    selectedPrototypeId: "../../etc",
    createdPrototypeId: "cht_ok",
    evidence: [{ id: "rhe_0123456789abcdef", title: "Hub record" }],
    designGuidance: "Reviewed guidance",
  }, "study")!;
  assert.equal(parsed.title, "");
  assert.deepEqual(parsed.answers, { decision: "Choose" });
  assert.equal(parsed.activities.length, 2, "an unknown method is dropped");
  const [survey, prototype] = parsed.activities;
  assert.equal(survey.title, "");
  assert.equal(survey.perRound, newStudyActivity("survey", "x").perRound);
  assert.equal(survey.rounds, 3);
  assert.equal(survey.goal, newStudyActivity("survey", "x").goal);
  assert.deepEqual(survey.designs, [{ label: "A", url: "" }]);
  assert.notEqual(prototype.key, survey.key, "keys stay unique");
  assert.equal(prototype.instructions, "Find the balance.");
  assert.deepEqual(parsed.setup, DEFAULT_STUDY_SETUP);
  assert.equal(parsed.prototypeMode, "none");
  assert.equal(parsed.selectedPrototypeId, null);
  assert.equal(parsed.createdPrototypeId, "cht_ok");
  assert.ok(!("evidence" in parsed) && !("designGuidance" in parsed), "nothing from Research Hub is kept");
});

test("only a study keeps activities, prototypes and findings", () => {
  const parsed = parseResearchFormDraft({ ...form({ prototypeMode: "new", researchFindings: "x", activities: [newStudyActivity("survey", "activity-1")] }), kind: "synthesis" }, "synthesis")!;
  assert.deepEqual([parsed.activities, parsed.prototypeMode, parsed.researchFindings], [[], "none", ""]);
});
