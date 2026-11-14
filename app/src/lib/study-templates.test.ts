import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_STUDY_SETUP,
  METHOD_TEMPLATES,
  OTHER_METHOD_PRESETS,
  STUDY_METHODS,
  activityEdited,
  buildResearchStudioWorkingCopy,
  changeActivityMethod,
  hasTemplatePlaceholder,
  newOtherMethod,
  newStudyActivity,
  nextPlanKey,
  otherMethodEdited,
  otherMethodProblems,
  otherMethodsPrompt,
  researchStudioFileProblems,
  studyDraftProblems,
  switchActivityMethod,
  templateActivity,
  type OtherMethod,
} from "./research-methods.ts";
import { buildResearchPrompt, researchTask } from "./research-studio.ts";
import { parseResearchFormDraft, researchFormDraft, researchFormDraftEmpty } from "./research-form-draft.ts";

const brief = { decision: "Whether to change the balance page", question: "Can people find what they owe?", participants: "People with a balance due" };
const interviews = (extra: Partial<OtherMethod> = {}): OtherMethod => ({ ...newOtherMethod("interviews", "other-1"), description: "Talk with people about paying what they owe.", ...extra });

test("every method starts with template text, but no planning decision is filled in", () => {
  for (const { id } of STUDY_METHODS) {
    const activity = templateActivity(id, "a");
    assert.ok(activity.instructions.trim(), `${id} has starting instructions`);
    assert.ok(activity.objective.trim(), `${id} has a starting objective`);
    const blank = newStudyActivity(id, "a");
    for (const field of ["stoppingRule", "successSignal", "url", "cards", "categories", "tree"] as const) assert.equal(activity[field], blank[field], `${id}: ${field} is left to the researcher`);
    assert.deepEqual(activity.designs, blank.designs);
    assert.equal(activity.stoppingRuleConfirmed, false);
  }
});

test("templates never claim results or a winner", () => {
  const text = [...Object.values(METHOD_TEMPLATES).flatMap(item => Object.values(item)), ...OTHER_METHOD_PRESETS.map(preset => Object.values(newOtherMethod(preset.id, "k")).join(" "))].join(" ");
  assert.doesNotMatch(text, /validated|proven|winner|significant|outperform/i);
});

test("a template's [bracketed] text blocks the working draft until it's replaced", () => {
  const prototype = { ...templateActivity("prototype", "a"), url: "https://x.gov/p" };
  assert.ok(hasTemplatePlaceholder(prototype.instructions));
  assert.deepEqual(researchStudioFileProblems("Study", [prototype]), ["Activity 1 (Prototype usability): replace the [bracketed] template text with your own"]);
  const filled = { ...prototype, instructions: prototype.instructions.replace(/\[[^\]]+\]/, "find how much you owe") };
  assert.deepEqual(researchStudioFileProblems("Study", [filled]), []);
  // Starting text without brackets can be saved as it is.
  const card = { ...templateActivity("card_sort", "c"), cards: "Payments\nNotices" };
  assert.deepEqual(researchStudioFileProblems("Study", [card]), []);
  const survey = templateActivity("survey", "s");
  assert.match(researchStudioFileProblems("Study", [survey]).join("\n"), /replace the \[bracketed\] template text/, "survey questions are checked too");
});

test("an untouched template can be removed without asking; any change counts as work", () => {
  const activity = templateActivity("tree_test", "a");
  assert.equal(activityEdited(activity), false);
  assert.equal(activityEdited({ ...activity, tree: "Home\n  Pay *" }), true);
  assert.equal(activityEdited({ ...activity, margin: 15 }), true);
  assert.equal(otherMethodEdited(newOtherMethod("moderated", "o")), false);
  assert.equal(otherMethodEdited({ ...newOtherMethod("moderated", "o"), participants: 6 }), true);
});

test("changing method swaps untouched starting text and keeps what was written", () => {
  const survey = templateActivity("survey", "a");
  const moved = changeActivityMethod(survey, "card_sort");
  assert.equal(moved.instructions, METHOD_TEMPLATES.card_sort.instructions, "untouched template text follows the method");
  assert.equal(moved.questions, "", "card sorts have no questions");
  const written = changeActivityMethod({ ...survey, instructions: "Tell us about paying.", title: "Paying" }, "card_sort");
  assert.deepEqual([written.title, written.instructions, written.objective], ["Paying", "Tell us about paying.", METHOD_TEMPLATES.card_sort.objective]);
  // Switching back restores the set-aside details, with untouched text taken from them.
  const away = switchActivityMethod(survey, "first_click");
  const back = switchActivityMethod(away.activity, "survey", away.setAside);
  assert.deepEqual(back.activity, survey);
});

test("other methods need a name and what happens, and their numbers are the researcher's", () => {
  assert.deepEqual(otherMethodProblems([newOtherMethod("custom", "o")]), ["Other method 1: name the method", "Other method 1: describe what happens"]);
  assert.deepEqual(otherMethodProblems([newOtherMethod("interviews", "o")]), ["Other method 1 (Interviews): replace the [bracketed] template text with your own"]);
  assert.deepEqual(otherMethodProblems([interviews({ participants: 0 })]), ["Other method 1 (Interviews): the number of people must be between 1 and 1000"]);
  assert.deepEqual(otherMethodProblems([interviews({ participants: 8 })]), []);
});

test("other methods are listed at the end of the working draft's analysis plan, and never as Research Studio tasks", () => {
  const card = { ...templateActivity("card_sort", "c"), cards: "Payments\nNotices" };
  const file = buildResearchStudioWorkingCopy({ title: "Balance study", setup: DEFAULT_STUDY_SETUP, activities: [card], otherMethods: [interviews({ participants: 8 })] });
  assert.equal(file.tasks.length, 1);
  assert.match(file.plan.analysis, /\n\nOther methods in this study \(not run in Research Studio, and not counted in its sample sizes\)\nOther method 1: Interviews\nWhat happens: Talk with people about paying what they owe\.\n/);
  assert.match(file.plan.analysis, /People: about 8/);
  assert.doesNotMatch(file.plan.participants.recruitment, /Interviews/, "recruitment targets are Research Studio's only");
  assert.deepEqual(studyDraftProblems({ title: "Balance study", ...brief, setup: DEFAULT_STUDY_SETUP, activities: [card], otherMethods: [interviews()] }), []);
});

test("a plan of only other methods can't be a Research Studio working draft, and says why", () => {
  const problems = studyDraftProblems({ title: "Interview study", ...brief, setup: DEFAULT_STUDY_SETUP, activities: [], otherMethods: [interviews()] });
  assert.deepEqual(problems, ["Add at least one Research Studio activity: other methods are listed in the working draft's plan, but Research Studio doesn't run them"]);
  assert.deepEqual(studyDraftProblems({ title: "Empty", ...brief, setup: DEFAULT_STUDY_SETUP, activities: [] }), ["Add at least one study activity"]);
});

test("the Researcher prompt carries other methods, and the brief no longer has a free-text Other methods field", () => {
  assert.equal(researchTask("study").fields.some(field => field.id === "method"), false);
  const prompt = buildResearchPrompt({ kind: "study", title: "Balance", answers: brief, otherMethods: [interviews()] });
  assert.match(prompt, /Other methods \(not run in Research Studio\):\n1\. Interviews\n   - What happens: Talk with people about paying what they owe\.\n/);
  assert.match(prompt, /People: not decided yet/);
  assert.match(prompt, /do not claim that any session took place/);
  assert.deepEqual(otherMethodsPrompt([]), []);
});

test("plan keys stay unique across activities and other methods", () => {
  assert.equal(nextPlanKey("activity", ["activity-1", "activity-2", "other-1"]), "activity-3");
  assert.equal(nextPlanKey("other", ["activity-1", "other-2"]), "other-1");
});

const form = (extra = {}) => researchFormDraft({
  kind: "study", title: "", answers: {}, activities: [], otherMethods: [], setup: DEFAULT_STUDY_SETUP, prototypeMode: "none",
  prototypePurpose: "", researchFindings: "", selectedPrototypeId: null, createdPrototypeId: null, createdPrototypePrompt: null, ...extra,
});

test("other methods are kept with the form draft, checked field by field", () => {
  assert.equal(researchFormDraftEmpty(form({ otherMethods: [newOtherMethod("custom", "other-1")] })), false);
  const saved = JSON.parse(JSON.stringify(form({ otherMethods: [interviews({ participants: 8 }), { key: "other-1", preset: "nonsense", name: 4, description: "Watch.", participants: "lots" }] })));
  const parsed = parseResearchFormDraft(saved, "study")!;
  assert.equal(parsed.otherMethods.length, 2);
  assert.deepEqual(parsed.otherMethods[0], interviews({ participants: 8 }));
  assert.deepEqual([parsed.otherMethods[1].preset, parsed.otherMethods[1].name, parsed.otherMethods[1].description, parsed.otherMethods[1].participants], ["custom", "", "Watch.", null]);
  assert.notEqual(parsed.otherMethods[1].key, parsed.otherMethods[0].key, "duplicate keys are renumbered");
});

test("an older draft's free-text Other methods answer becomes a custom method", () => {
  const parsed = parseResearchFormDraft(form({ answers: { decision: "D", method: "Three diary entries a week" } }), "study")!;
  assert.equal(parsed.answers.method, undefined);
  assert.deepEqual(parsed.otherMethods.map(item => [item.preset, item.name, item.description]), [["custom", "Other methods", "Three diary entries a week"]]);
  assert.equal(parseResearchFormDraft({ ...form({ answers: { method: "x" } }), kind: "synthesis" }, "synthesis")!.otherMethods.length, 0);
});
