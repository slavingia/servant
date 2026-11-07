import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_STUDY_SETUP,
  STUDY_METHODS,
  buildResearchStudioWorkingCopy,
  changeActivityMethod,
  changeSortMode,
  newStudyActivity,
  parseTreeOutline,
  researchStudioFileName,
  researchStudioFileProblems,
  studyActivitiesPrompt,
  summarizeActivities,
  type StudyActivity,
  type StudyMethod,
} from "./research-methods.ts";
import { buildResearchPrompt } from "./research-studio.ts";
import { planStudy, sampleSizeForMargin, sampleSizeVsHalf, wilson } from "./research-stats.ts";

const activity = (method: StudyMethod, extra: Partial<StudyActivity> = {}): StudyActivity => ({ ...newStudyActivity(method, `k-${method}`), instructions: "Do the task.", ...extra });

// Expected values were produced by Civic Research Studio v0.3.24's own planner
// (src/abstats.js, src/method-plans.js, src/plan.js) for the same inputs.
test("statistics match Research Studio v0.3.24", () => {
  assert.equal(sampleSizeForMargin(0.75, 0.08), 113);
  assert.equal(sampleSizeForMargin(0.7, 0.1), 81);
  assert.equal(sampleSizeVsHalf(0.65, { power: 0.9 }), 113);
  assert.deepEqual(planStudy({ baseline: 0.62, difference: 0.12, designs: 3, power: 0.9 }), { perDesign: 373, total: 1119, alpha: 0.025, power: 0.9, target: 0.74, direction: "up" });
  assert.equal(planStudy({ baseline: 0.95, difference: 0.1 })!.direction, "down", "an impossible target is planned as a drop");
  const w = wilson(7, 10)!;
  assert.equal(Math.round(w.lo * 1000), 397);
  assert.equal(Math.round(w.hi * 1000), 892);
});

test("all seven Research Studio methods are offered", () => {
  assert.deepEqual(STUDY_METHODS.map(m => m.id), ["prototype", "ab_test", "card_sort", "tree_test", "first_click", "preference", "survey"]);
  assert.deepEqual(STUDY_METHODS.map(m => m.label), ["Prototype usability", "A/B implementation test", "Card sorting", "Tree testing", "First-click testing", "Preference testing", "Survey"]);
});

test("sample sizes and analysis read exactly as in Research Studio", () => {
  const { items, largest } = summarizeActivities([
    activity("prototype", { title: "Pay", url: "https://x.gov/", perRound: 5, rounds: 3 }),
    activity("tree_test", { title: "Find transcript", tree: "Home\nRecords\n  Tax transcripts *", benchmark: 70, directBenchmark: 50 }),
    activity("ab_test", { title: "One-time payment", successSignal: "paid", controlIndex: 1, baseline: 62, difference: 12, power: 0.9,
      designs: [{ label: "New", url: "https://x.gov/n" }, { label: "Current", url: "https://x.gov/c" }, { label: "C", url: "https://x.gov/x" }] }),
  ]);
  assert.match(items[0].size, /^5 people per round, 3 rounds \(15 in total\)/);
  assert.equal(items[1].size, "About 81 people completing the activity, so that task success (correct destination) near 70% is estimated to within about ±10 points (95% interval). Many teams recruit about 50 per tree. Recruit extra for drop-out.");
  assert.match(items[1].analysis, /Compare directness with 50% the same way\.$/);
  assert.match(items[2].size, /^Recruit about 373 people assigned per design \(1119 in total\).*adjusted for 2 comparisons with the control\.$/);
  assert.deepEqual(items[2].hypotheses, [
    "Compared with Design A (Current), the control, Design B (New) will have a higher task success rate.",
    "Compared with Design A (Current), the control, Design C (C) will have a higher task success rate.",
  ]);
  assert.match(items[2].analysis, /No winner is declared automatically/);
  assert.deepEqual(largest, { title: "One-time payment", n: 1119 });
});

test("tree outlines nest by indentation and * marks correct destinations", () => {
  const parsed = parseTreeOutline("Home\nRecords\n  Tax transcripts *\n\tTax documents\n    Archive *\nHelp\nRecords");
  assert.equal(parsed.nodes, 7);
  assert.deepEqual(parsed.tree.map(n => n.id), ["home", "records", "help", "records-2"]);
  assert.deepEqual(parsed.tree[1].children!.map(n => n.label), ["Tax transcripts", "Tax documents"]);
  assert.deepEqual(parsed.tree[1].children![1].children!.map(n => n.id), ["archive"]);
  assert.deepEqual(parsed.correctNodeIds, ["tax-transcripts", "archive"]);
});

test("the working copy has Research Studio's shape, Qualtrics consent, and nothing from the Hub", () => {
  const file = buildResearchStudioWorkingCopy({
    title: "IOLA: current vs new!", decision: "Ship it?", question: "Can people pay?\nCan they find OIC?", participants: "Taxpayers", background: "Earlier survey",
    setup: { collection: "qualtrics-embed", devices: "desktop" },
    activities: [
      activity("ab_test", { title: "One-time payment", successSignal: "iola-payment-submitted", controlIndex: 1,
        designs: [{ label: "New IOLA", url: "https://x.gov/new/" }, { label: "Current IOLA", url: "https://x.gov/cur/" }] }),
      changeSortMode(activity("card_sort", { title: "Group", cards: "Pay\nPay\nRecords", categories: "Money\nPapers" }), "closed"),
    ],
  });
  assert.equal(file.id, "iola-current-vs-new");
  assert.equal(researchStudioFileName("IOLA: current vs new!"), "iola-current-vs-new.working-copy.json");
  assert.equal(file.consentMode, "external", "consent is collected in the Qualtrics survey");
  assert.equal(file.allowedDevices, "desktop");
  assert.deepEqual([file.welcome, file.consent], ["", ""], "participant-facing text is written in Research Studio");
  const ab = file.tasks[0];
  assert.deepEqual(ab.variants!.map(v => v.id), ["design-b", "design-a"], "the control comes first; IDs keep the typed letters");
  assert.equal(ab.experimentId, ab.id);
  assert.equal(file.plan.experiments[ab.id].controlId, "design-b");
  assert.equal(file.plan.experiments[ab.id].primaryMeasure, "success");
  assert.deepEqual(file.tasks[1].cards!.map(c => c.id), ["pay", "pay-2", "records"]);
  assert.equal(file.plan.activities[file.tasks[1].id].goal, "validate", "a closed sort starts as validate");
  assert.deepEqual(file.plan.researchQuestions, ["Can people pay?", "Can they find OIC?"]);
  assert.equal(file.plan.participants.devices, "desktop");
  assert.doesNotMatch(JSON.stringify(file), /Research Hub|RH-\d|catalog/i);
  const undecided = buildResearchStudioWorkingCopy({ title: "Plan", setup: { collection: "undecided", devices: "any" }, activities: [activity("survey", { questions: "Q?" })] });
  assert.equal("consentMode" in undecided, false);
  assert.equal("allowedDevices" in undecided, false);
});

test("the file lists exactly what Research Studio's import would reject", () => {
  assert.deepEqual(researchStudioFileProblems("ab", []), ["Add a working title of at least three letters or numbers", "Add at least one study activity"]);
  const problems = researchStudioFileProblems("Study", [
    activity("prototype", { url: "http://example.gov/" }),
    activity("tree_test", { tree: "Home\n  Leaf", instructions: "" }),
    activity("preference", { split: 50, designs: [{ label: "A", url: "https://x.gov/a.png" }] }),
  ]);
  assert.deepEqual(problems, [
    "Activity 1 (Prototype usability): the prototype must be an HTTPS link",
    "Activity 2 (Tree testing): add instructions for participants",
    "Activity 2 (Tree testing): mark at least one correct destination with *",
    "Activity 3 (Preference testing): add at least two options",
    "Activity 3 (Preference testing): smallest split must be between 51 and 95",
  ]);
  assert.deepEqual(researchStudioFileProblems("Study", [activity("prototype", { url: "http://localhost:4000/" })]), [], "local HTTP is allowed for development");
  assert.deepEqual(researchStudioFileProblems("Study", [activity("prototype", { url: "https://x.gov/", goal: "discover", benchmark: 400 })]), [], "fields hidden by the goal never block the file");
});

test("changing method keeps shared text, and sort mode sets Research Studio's starting goal", () => {
  const moved = changeActivityMethod(activity("survey", { title: "T", objective: "O", questions: "Q?" }), "card_sort");
  assert.deepEqual([moved.method, moved.title, moved.objective, moved.questions, moved.goal], ["card_sort", "T", "O", "", "explore"]);
  assert.equal(changeSortMode(moved, "closed").goal, "validate");
  assert.equal(changeSortMode(moved, "open").goal, "explore");
});

test("the Researcher prompt carries the activities, fixed numbers, and the Qualtrics route", () => {
  const acts = [activity("first_click", { title: "Where first", url: "https://x.gov/shot.png", benchmark: 80 })];
  const lines = studyActivitiesPrompt(DEFAULT_STUDY_SETUP, acts).join("\n");
  assert.match(lines, /1\. Where first — First-click testing/);
  assert.match(lines, /Sample size: About 62 people/);
  assert.match(lines, /do not recompute or replace them/);
  assert.match(lines, /route B/);
  assert.match(lines, /Consent is collected in the Qualtrics survey/);
  assert.match(lines, /do not claim that any activity was run/);
  assert.deepEqual(studyActivitiesPrompt(DEFAULT_STUDY_SETUP, []), [], "no activities: the brief is unchanged");
  const prompt = buildResearchPrompt({ kind: "study", title: "Plan", answers: { decision: "D", question: "Q", participants: "P" }, activities: acts, setup: { collection: "qualtrics-links", devices: "desktop" } });
  assert.match(prompt, /two surveys and links \(route A\)/);
  assert.match(prompt, /laptop- and desktop-only/);
  const synthesis = buildResearchPrompt({ kind: "synthesis", title: "S", answers: { decision: "D", inputs: "I", question: "Q" }, activities: acts });
  assert.doesNotMatch(synthesis, /Research Studio activities/, "only study briefs carry activities");
});
