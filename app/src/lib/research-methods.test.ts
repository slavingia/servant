import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_STUDY_SETUP,
  STOP_DEFAULT,
  STUDY_METHODS,
  buildResearchStudioWorkingCopy,
  chooseControl,
  directionOptions,
  newProblems,
  recheckStudyPrototype,
  saveBlockedReason,
  switchActivityMethod,
  NO_LOSS_ALLOWANCE_TEXT,
  studyDraftProblems,
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
import { allowingForLoss, planStudy, sampleSizePerGroup, sampleSizeForMargin, sampleSizeVsHalf, wilson } from "./research-stats.ts";

const confirmedStop = { stoppingRule: STOP_DEFAULT, stoppingRuleConfirmed: true };
const activity = (method: StudyMethod, extra: Partial<StudyActivity> = {}): StudyActivity => ({ ...newStudyActivity(method, `k-${method}`), instructions: "Do the task.", ...(method === "ab_test" ? confirmedStop : {}), ...extra });

// Expected values were produced by Civic Research Studio v0.3.24's own planner
// (src/abstats.js, src/method-plans.js, src/plan.js) for the same inputs.
test("statistics match Research Studio v0.3.24", () => {
  assert.equal(sampleSizeForMargin(0.75, 0.08), 113);
  assert.equal(sampleSizeForMargin(0.7, 0.1), 81);
  assert.equal(sampleSizeVsHalf(0.65, { power: 0.9 }), 113);
  assert.deepEqual(planStudy({ baseline: 0.62, difference: 0.12, designs: 3, power: 0.9 }), { perDesign: 373, total: 1119, alpha: 0.025, confidence: 0.975, power: 0.9, target: 0.74, direction: "up" });
  const w = wilson(7, 10)!;
  assert.equal(Math.round(w.lo * 1000), 397);
  assert.equal(Math.round(w.hi * 1000), 892);
});

test("A/B sizing follows the planning direction and never swaps it silently (UX-H01)", () => {
  const lower = planStudy({ baseline: 0.5, difference: 0.15, direction: "lower" })!;
  assert.equal(lower.target, 0.35);
  assert.equal(lower.direction, "down");
  assert.equal(lower.perDesign, sampleSizePerGroup(0.5, 0.35));
  assert.equal(planStudy({ baseline: 0.5, difference: 0.15, direction: "higher" })!.target, 0.65);
  assert.equal(planStudy({ baseline: 0.95, difference: 0.1, direction: "higher" }), null, "a rise past 100% has no plan");
  assert.equal(planStudy({ baseline: 0.05, difference: 0.1, direction: "lower" }), null, "a drop below 0% has no plan");
  const different = planStudy({ baseline: 0.3, difference: 0.1, direction: "different" })!;
  assert.equal(different.perDesign, Math.max(sampleSizePerGroup(0.3, 0.4)!, sampleSizePerGroup(0.3, 0.2)!), "plans for the harder change to detect");
  assert.equal(planStudy({ baseline: 0.95, difference: 0.1, direction: "different" })!.target, 0.85, "either way: only the possible change is planned");
  assert.equal(planStudy({ baseline: 0.5, difference: 0.1, designs: 4 })!.confidence.toFixed(4), (1 - 0.05 / 3).toFixed(4), "Bonferroni for three comparisons");
  assert.equal(allowingForLoss(100, 20), 125, "100 ÷ (1 − .20), exactly");
  assert.equal(allowingForLoss(81, 20), 102);
  assert.equal(allowingForLoss(100, 0), 100);
});

test("release-safe scope: two A/B designs, one primary outcome, complete planning inputs (UX-H03)", () => {
  const ab = (extra: Partial<StudyActivity> = {}) => activity("ab_test", { title: "Pay", successSignal: "paid",
    designs: [{ label: "Current", url: "https://x.gov/c" }, { label: "New", url: "https://x.gov/n" }], ...extra });
  assert.equal(newStudyActivity("ab_test", "k").stoppingRule, "", "no stopping rule is accepted by default");
  assert.deepEqual(researchStudioFileProblems("Study", [ab()]), []);
  const problems = (extra: Partial<StudyActivity>) => researchStudioFileProblems("Study", [ab(extra)]).map(p => p.replace("Activity 1 (A/B implementation test): ", ""));
  assert.deepEqual(problems({ designs: [...ab().designs, { label: "Third", url: "https://x.gov/t" }] }), ["use exactly two designs: a control and one alternative"]);
  assert.deepEqual(problems({ successSignal: "" }), ["add a success signal, or choose self-reported completion as the primary outcome"]);
  assert.deepEqual(problems({ successSignal: "", primary: "self" }), []);
  assert.deepEqual(problems({ baseline: null }), ["enter the expected control rate (1–99%)"]);
  assert.deepEqual(problems({ difference: null }), ["enter the smallest difference worth detecting (1–98 points)"]);
  assert.deepEqual(problems({ baseline: 95, difference: 10, direction: "higher" }), ["a rise of 10 points from 95% would pass 100%: lower the difference or change the planning direction"]);
  assert.deepEqual(problems({ baseline: 5, difference: 10, direction: "lower" }), ["a drop of 10 points from 5% would fall below 0%: lower the difference or change the planning direction"]);
  assert.deepEqual(problems({ stoppingRule: " " }), ["add a stopping rule"]);
  assert.deepEqual(problems({ stoppingRuleConfirmed: false }), ["review the stopping rule and confirm it"], "even the standard rule must be confirmed");
  assert.deepEqual(researchStudioFileProblems("Study", [activity("tree_test", { tree: "Home\n  Leaf *", margin: null })]).map(p => p.split(": ")[1]), ["enter the precision (± points)"]);
  // The plan uses the chosen direction and outcome.
  const file = buildResearchStudioWorkingCopy({ title: "Study", setup: DEFAULT_STUDY_SETUP, activities: [ab({ direction: "lower", primary: "self" })] });
  const experiment = Object.values(file.plan.experiments)[0];
  assert.equal(experiment.primaryMeasure, "self");
  assert.equal(experiment.hypotheses[0].direction, "lower");
  assert.match(summarizeActivities([ab({ direction: "lower" })]).items[0].size, /from 50% to 35% with a two-sided test at 95% confidence/);
});

test("comparison wording uses the real number of comparisons (UX-H02)", () => {
  const four = summarizeActivities([activity("ab_test", { title: "Four", successSignal: "paid", designs: ["A", "B", "C", "D"].map(label => ({ label, url: `https://x.gov/${label}` })) })]).items[0];
  assert.match(four.analysis, /at 98\.3% \(Bonferroni\) because 3 treatments are each compared with the control/);
  const two = summarizeActivities([activity("ab_test", { title: "Two", successSignal: "paid", designs: [{ label: "A", url: "https://x.gov/a" }, { label: "B", url: "https://x.gov/b" }] })]).items[0];
  assert.match(two.analysis, /two-sided Newcombe hybrid score interval at 95%/);
  assert.doesNotMatch(two.analysis, /Bonferroni/);
});

test("preference: two options are powered, three or more are exploratory with no sample-size claim (UX-H04)", () => {
  const options = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Option ${i + 1}`, url: `https://x.gov/${i}.png` }));
  const two = summarizeActivities([activity("preference", { designs: options(2), split: 65 })]).items[0];
  assert.match(two.size, /^Estimate: about \d+ people choosing an option, to tell a 65\/35 split/);
  const three = summarizeActivities([activity("preference", { designs: options(3), split: 65 })]).items[0];
  assert.match(three.size, /^Exploratory/);
  assert.equal(three.recruit, null);
  assert.match(three.analysis, /Don't declare a winner/);
  const file = buildResearchStudioWorkingCopy({ title: "Prefs", setup: DEFAULT_STUDY_SETUP, activities: [activity("preference", { designs: options(3), split: 65 })] });
  assert.equal(Object.values(file.plan.activities)[0].split, null, "no split is planned for exploratory work");
  assert.deepEqual(researchStudioFileProblems("Prefs", [activity("preference", { designs: options(3), split: null })]), []);
  assert.deepEqual(researchStudioFileProblems("Prefs", [activity("preference", { designs: options(2), split: null })]).map(p => p.split(": ")[1]), ["enter the smallest split worth finding (51–95%)"]);
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
      designs: [{ label: "New", url: "https://x.gov/n" }, { label: "Current", url: "https://x.gov/c" }] }),
  ]);
  const perDesign = sampleSizePerGroup(0.62, 0.74, { power: 0.9 })!;
  assert.match(items[0].size, /^5 people per round, 3 rounds \(15 in total\), fixing problems between rounds\. Analysis denominator: people who complete a usable session in each round\. Recruit about 7 per round \(5 ÷ \(1 − 0\.20\)\), 21 in total, allowing for 20% of recruits not reaching the analysis/);
  assert.equal(items[1].size, "Estimate: about 81 people in the analysis, so that task success (correct destination) near 70% is estimated to within about ±10 points (95% interval). Analysis denominator: everyone who starts the activity; anyone who starts but doesn't finish stays in it and counts as not successful. Many teams recruit about 50 per tree. Recruit about 102 (81 ÷ (1 − 0.20)), allowing for 20% of recruits not reaching the analysis (recruits who never start it: screen-outs and technical failures).");
  assert.match(items[1].analysis, /Compare directness with 50% the same way\.$/);
  assert.equal(items[2].size, `Estimate: about ${perDesign} randomized eligible participants per design (${perDesign * 2} in total) give a 90% chance of detecting a change from 62% to 74% with a two-sided test at 95% confidence. Analysis denominator: every eligible participant randomized to each design; anyone randomized who doesn't finish, or whose success can't be measured, stays in it and counts as not successful, so the expected control rate should already include them. Recruit about ${allowingForLoss(perDesign * 2, 20)} (${perDesign * 2} ÷ (1 − 0.20)), allowing for 20% of recruits not reaching the analysis (screen-outs, ineligible people and technical failures before randomization). This is a planning estimate, not a guarantee.`);
  // The control is always Design A, as in Research Studio.
  assert.deepEqual(items[2].hypotheses, [
    "Compared with Design A (Current), the control, Design B (New) will have a higher task success rate. Planned for that direction; tested two-sided.",
  ]);
  assert.match(items[2].analysis, /No winner is declared automatically/);
  assert.deepEqual(largest, { title: "One-time payment", n: allowingForLoss(perDesign * 2, 20) });
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
    setup: { collection: "qualtrics-embed", devices: "desktop", lossAllowance: 20 },
    activities: [
      activity("ab_test", { title: "One-time payment", successSignal: "iola-payment-submitted", controlIndex: 1,
        designs: [{ label: "New IOLA", url: "https://x.gov/new/" }, { label: "Current IOLA", url: "https://x.gov/cur/" }] }),
      changeSortMode(activity("card_sort", { title: "Group", cards: "Pay\nPay\nRecords", categories: "Money\nPapers" }), "closed"),
    ],
  });
  assert.equal(file.id, "iola-current-vs-new");
  assert.equal(researchStudioFileName("IOLA: current vs new!"), "iola-current-vs-new.working-draft.json");
  assert.equal(file.consentMode, "external", "consent is collected in the Qualtrics survey");
  assert.equal(file.allowedDevices, "desktop");
  assert.deepEqual([file.welcome, file.consent], ["", ""], "participant-facing text is written in Research Studio");
  const ab = file.tasks[0];
  assert.deepEqual(ab.variants!.map(v => [v.id, v.label]), [["design-a", "Current IOLA"], ["design-b", "New IOLA"]], "the control is Design A");
  assert.equal(ab.experimentId, ab.id);
  assert.equal(file.plan.experiments[ab.id].controlId, "design-a");
  assert.equal(file.plan.experiments[ab.id].primaryMeasure, "success");
  assert.deepEqual(file.tasks[1].cards!.map(c => c.id), ["pay", "pay-2", "records"]);
  assert.equal(file.plan.activities[file.tasks[1].id].goal, "validate", "a closed sort starts as validate");
  assert.deepEqual(file.plan.researchQuestions, ["Can people pay?", "Can they find OIC?"]);
  assert.equal(file.plan.participants.devices, "desktop");
  assert.doesNotMatch(JSON.stringify(file), /Research Hub|RH-\d|catalog/i);
  const undecided = buildResearchStudioWorkingCopy({ title: "Plan", setup: { collection: "undecided", devices: "any", lossAllowance: 20 }, activities: [activity("survey", { questions: "Q?" })] });
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
  ]);
  assert.deepEqual(researchStudioFileProblems("Study", [activity("preference", { split: 50, designs: [{ label: "A", url: "https://x.gov/a.png" }, { label: "B", url: "https://x.gov/b.png" }] })]).map(p => p.split(": ")[1]), ["smallest split must be between 51 and 95"]);
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
  assert.match(lines, /Sample size: Estimate: about 62 people in the analysis/);
  assert.match(lines, /do not recompute or replace them/);
  assert.match(lines, /route B/);
  assert.match(lines, /Consent is collected in the Qualtrics survey/);
  assert.match(lines, /do not claim that any activity was run/);
  assert.deepEqual(studyActivitiesPrompt(DEFAULT_STUDY_SETUP, []), [], "no activities: the brief is unchanged");
  const prompt = buildResearchPrompt({ kind: "study", title: "Plan", answers: { decision: "D", question: "Q", participants: "P" }, activities: acts, setup: { collection: "qualtrics-links", devices: "desktop", lossAllowance: 20 } });
  assert.match(prompt, /two surveys and links \(route A\)/);
  assert.match(prompt, /laptop- and desktop-only/);
  const synthesis = buildResearchPrompt({ kind: "synthesis", title: "S", answers: { decision: "D", inputs: "I", question: "Q" }, activities: acts });
  assert.doesNotMatch(synthesis, /Research Studio activities/, "only study briefs carry activities");
});

// ---------- research pilot blockers 2 and 3 ----------
const brief = { title: "Payment study", decision: "Ship the new flow?", question: "Can people pay?", participants: "People paying a balance", setup: DEFAULT_STUDY_SETUP };

test("the A/B denominator is randomized eligible participants per design, noncompletion counts as not successful, and loss is allowed for once (blocker 3)", () => {
  const ab = activity("ab_test", { title: "Pay", successSignal: "paid", baseline: 60, difference: 15,
    designs: [{ label: "Current", url: "https://x.gov/c" }, { label: "New", url: "https://x.gov/n" }] });
  const perDesign = sampleSizePerGroup(0.6, 0.75)!;
  const { items, largest } = summarizeActivities([ab]);
  assert.match(items[0].size, new RegExp(`^Estimate: about ${perDesign} randomized eligible participants per design \\(${perDesign * 2} in total\\)`));
  assert.match(items[0].analysis, /Each design's denominator is every eligible participant randomized to it\. Anyone randomized who drops out or whose success cannot be measured counts as not successful; nobody is removed after randomization\./);
  for (const text of [items[0].size, items[0].analysis]) {
    assert.match(text, new RegExp(`Recruit about ${allowingForLoss(perDesign * 2, 20)} \\(${perDesign * 2} ÷ \\(1 − 0\\.20\\)\\), allowing for 20% of recruits not reaching the analysis`));
    assert.doesNotMatch(text, /extra/);
  }
  assert.equal(largest!.n, allowingForLoss(perDesign * 2, 20));
  const prompt = studyActivitiesPrompt(DEFAULT_STUDY_SETUP, [ab, activity("survey", { title: "S", questions: "Q?" })]).join("\n");
  assert.match(prompt, new RegExp(`recruit for the largest need: about ${allowingForLoss(perDesign * 2, 20)} people \\(Pay\\), which already allows for 20% loss\\.`));
  assert.doesNotMatch(prompt, /extra for drop-out|plus extra/);
  const none = summarizeActivities([ab], 0);
  assert.match(none.items[0].size, new RegExp(`No loss allowance is set, so recruit ${perDesign * 2}\\.`));
  assert.equal(none.largest!.n, perDesign * 2);
  for (const lossAllowance of [-1, 51, 2.5, Number.NaN]) {
    assert.ok(studyDraftProblems({ ...brief, setup: { ...DEFAULT_STUDY_SETUP, lossAllowance }, activities: [ab] }).includes("Enter a loss allowance from 0 to 50%"), String(lossAllowance));
  }
});

test("the allowance applies to every method with a target, defined against that method's analysis denominator (blocker 2)", () => {
  const { items, largest } = summarizeActivities([
    activity("prototype", { title: "Discover", url: "https://x.gov/", goal: "discover", perRound: 5, rounds: 3 }),
    changeSortMode(activity("card_sort", { title: "Sort", cards: "A\nB" }), "open"),
    activity("preference", { title: "Prefer", split: 65, designs: [{ label: "A", url: "https://x.gov/a.png" }, { label: "B", url: "https://x.gov/b.png" }] }),
    activity("survey", { title: "Ask", questions: "Q?" }),
    activity("preference", { title: "Explore", designs: ["A", "B", "C"].map(label => ({ label, url: `https://x.gov/${label}.png` })) }),
  ], 20);
  assert.deepEqual(items.map(item => [item.denominator?.short ?? null, item.recruitLabel]), [
    ["people completing a usable session, per round", "about 7 per round (21 in total)"],
    ["completed sorts", "about 25"],
    ["people who choose an option", `about ${allowingForLoss(sampleSizeVsHalf(0.65)!, 20)}`],
    ["completed responses", `about ${allowingForLoss(sampleSizeForMargin(0.5, 0.1)!, 20)}`],
    [null, null],
  ], "exploratory preference has no target, so no allowance");
  assert.match(items[1].size, /About 20 completed sorts\..*Analysis denominator: completed sorts\. Recruit about 25 \(20 ÷ \(1 − 0\.20\)\), allowing for 20% of recruits not reaching the analysis \(recruits who don't complete the sort\)\./);
  assert.equal(largest!.n, allowingForLoss(sampleSizeForMargin(0.5, 0.1)!, 20));
});

test("A/B copy: exactly two designs, outcome-specific direction labels, and measured success only with a signal (blocker 3)", () => {
  assert.match(STUDY_METHODS.find(m => m.id === "ab_test")!.description, /exactly two live designs/);
  assert.deepEqual(directionOptions("success").map(o => o.label), ["Higher task success", "Lower task success", "Different (either way)"]);
  assert.deepEqual(directionOptions("self").map(o => o.label), ["Higher self-reported completion", "Lower self-reported completion", "Different (either way)"]);
  const designs = [{ label: "Current", url: "https://x.gov/c" }, { label: "New", url: "https://x.gov/n" }];
  const secondary = (extra: Partial<StudyActivity>) => Object.values(buildResearchStudioWorkingCopy({ title: "S", setup: DEFAULT_STUDY_SETUP, activities: [activity("ab_test", { designs, ...extra })] }).plan.experiments)[0].secondary;
  assert.deepEqual(secondary({ successSignal: "paid" }), ["measured", "self", "time", "dropout"]);
  assert.deepEqual(secondary({ successSignal: "", primary: "self" }), ["time", "dropout"], "no measured success without a signal; self-report is already primary");
  assert.deepEqual(secondary({ successSignal: "Not A Slug", primary: "self" }), ["time", "dropout"], "an invalid signal isn't a signal");
  assert.deepEqual(secondary({ successSignal: "paid", primary: "self" }), ["measured", "time", "dropout"]);
  const analysis = summarizeActivities([activity("ab_test", { designs, successSignal: "", primary: "self" })]).items[0].analysis;
  assert.doesNotMatch(analysis, /success measured/i);
  assert.match(analysis, /compare the alternative with Design A \(Current\), the control/);
});

test("the stopping rule must be actively confirmed; editing it needs a new confirmation (blocker 3)", () => {
  const fresh = { ...newStudyActivity("ab_test", "k"), title: "Pay", instructions: "Pay.", successSignal: "paid", designs: [{ label: "A", url: "https://x.gov/a" }, { label: "B", url: "https://x.gov/b" }] };
  const only = (a: StudyActivity) => researchStudioFileProblems("Study", [a]).map(p => p.split(": ")[1]);
  assert.deepEqual(only(fresh), ["add a stopping rule"], "nothing is accepted silently");
  assert.deepEqual(only({ ...fresh, stoppingRule: STOP_DEFAULT }), ["review the stopping rule and confirm it"], "choosing the standard rule still needs confirming");
  assert.deepEqual(only({ ...fresh, stoppingRule: STOP_DEFAULT, stoppingRuleConfirmed: true }), []);
  assert.match(summarizeActivities([fresh]).items[0].analysis, /Stopping rule: not set yet/);
});

test("choosing Design B as the control makes it Design A everywhere: editor, hypothesis and file (blocker 2)", () => {
  const designs = [{ label: "Current", url: "https://x.gov/c" }, { label: "New", url: "https://x.gov/n" }];
  const before = activity("ab_test", { title: "Pay", successSignal: "paid", designs });
  const after = chooseControl(before, 1);
  assert.deepEqual([after.designs.map(d => d.label), after.controlIndex], [["New", "Current"], 0], "the editor's own state is reordered");
  assert.deepEqual(chooseControl(after, 0).designs, after.designs, "choosing the current control changes nothing");
  const [hypothesis] = summarizeActivities([after]).items[0].hypotheses;
  assert.equal(hypothesis, "Compared with Design A (New), the control, Design B (Current) will have a higher task success rate. Planned for that direction; tested two-sided.");
  const task = buildResearchStudioWorkingCopy({ title: "Pay", setup: DEFAULT_STUDY_SETUP, activities: [after] }).tasks[0];
  assert.deepEqual(task.variants!.map(v => [v.id, v.label]), [["design-a", "New"], ["design-b", "Current"]], "same letters and IDs in the file");
  // Older state with the control at index 1 is normalized the same way, never left disagreeing.
  const legacy = buildResearchStudioWorkingCopy({ title: "Pay", setup: DEFAULT_STUDY_SETUP, activities: [{ ...before, controlIndex: 1 }] });
  assert.deepEqual(legacy.tasks[0].variants!.map(v => [v.id, v.label]), [["design-a", "New"], ["design-b", "Current"]]);
  assert.equal(Object.values(legacy.plan.experiments)[0].controlId, "design-a");
});

test("the working draft needs a title, decision, research question, intended participants and valid activities (blocker 2)", () => {
  const ok = activity("survey", { title: "S", questions: "Q?" });
  assert.deepEqual(studyDraftProblems({ ...brief, activities: [ok] }), []);
  assert.deepEqual(studyDraftProblems({ title: "", setup: DEFAULT_STUDY_SETUP, activities: [] }), [
    "Add a working title of at least three letters or numbers",
    "Add the decision this study should inform",
    "Add the research question",
    "Add the people to learn from (intended participants)",
    "Add at least one study activity",
  ]);
  assert.deepEqual(studyDraftProblems({ ...brief, decision: "  ", activities: [activity("survey", { questions: "" })] }), [
    "Add the decision this study should inform",
    "Activity 1 (Survey): add at least one question",
  ]);
});

test("an existing prototype selection is used by the working draft (blocker 2)", () => {
  const proto = activity("prototype", { title: "Pay", url: "", goal: "measure" });
  const url = "https://servant.example.test/p/proto-abcdef012345678901/";
  assert.deepEqual(studyDraftProblems({ ...brief, activities: [proto], prototype: { mode: "existing", url: null } }), [
    "Choose an existing prototype, or select No prototype",
    "Activity 1 (Prototype usability): the prototype needs a link, or choose a study prototype",
  ]);
  assert.deepEqual(studyDraftProblems({ ...brief, activities: [proto], prototype: { mode: "existing", url } }), [], "a blank prototype activity uses the chosen prototype");
  assert.deepEqual(studyDraftProblems({ ...brief, activities: [proto], prototype: { mode: "existing", url: "http://servant.example.test/p/x/" } }), [
    "The chosen prototype's preview link can't be used in Research Studio (it must be HTTPS). Choose another prototype",
    "Activity 1 (Prototype usability): the prototype needs a link, or choose a study prototype",
  ]);
  const file = buildResearchStudioWorkingCopy({ ...brief, activities: [proto], prototypeUrl: url });
  assert.equal(file.prototypeUrl, url, "Research Studio uses the study prototype for activities without their own link");
  assert.equal("prototypeUrl" in file.tasks[0], false);
  const own = buildResearchStudioWorkingCopy({ ...brief, activities: [{ ...proto, url: "https://x.gov/other/" }], prototypeUrl: url });
  assert.equal(own.tasks[0].prototypeUrl, "https://x.gov/other/", "an activity's own link wins");
  assert.equal(buildResearchStudioWorkingCopy({ ...brief, activities: [ok()] }).prototypeUrl, "");
  function ok() { return activity("survey", { questions: "Q?" }); }
});

test("new validation problems are announced, and a disabled Save says why (blocker 2)", () => {
  assert.deepEqual(newProblems(["a", "b"], ["b", "c", "d"]), ["c", "d"]);
  assert.deepEqual(newProblems(["a"], []), []);
  assert.equal(saveBlockedReason([]), null);
  assert.equal(saveBlockedReason(["Add the research question"]), "Save is unavailable until 1 item is fixed: Add the research question.");
  assert.equal(saveBlockedReason(["Add the research question", "Add at least one study activity"]), "Save is unavailable until 2 items are fixed: Add the research question, and 1 more listed above.");
});

test("the chosen prototype is rechecked right before export and fails closed (blocker 2)", () => {
  const ready = [{ id: "p1", previewUrl: "https://servant.example.test/p/proto-aaaaaaaaaaaaaaaaaaaa/" }, { id: "p2", previewUrl: "http://servant.example.test/p/x/" }];
  const ok = recheckStudyPrototype("p1", ready);
  assert.equal(ok.ok && ok.url, ready[0].previewUrl);
  const gone = recheckStudyPrototype("p9", ready);
  assert.equal(gone.ok, false);
  assert.match(!gone.ok ? gone.message : "", /no longer available or published, so the working draft wasn't saved/);
  assert.equal(recheckStudyPrototype("p2", ready).ok, false, "an unusable preview link fails closed");
  assert.equal(recheckStudyPrototype("p1", [{ id: "p1", previewUrl: " " }]).ok, false);
});

test("switching an activity's method sets its details aside, and switching back restores them (audit 1)", () => {
  const ab = { ...newStudyActivity("ab_test", "k"), title: "Pay", instructions: "Pay it.", baseline: 60, stoppingRule: "Stop at 300.", stoppingRuleConfirmed: true,
    designs: [{ label: "Current flow", url: "https://x.gov/a" }, { label: "New flow", url: "https://x.gov/b" }] };
  const away = switchActivityMethod(ab, "survey");
  assert.equal(away.activity.method, "survey");
  assert.equal(away.activity.title, "Pay", "shared fields carry over");
  const renamed = { ...away.activity, title: "Pay a bill" };
  const back = switchActivityMethod(renamed, "ab_test", away.setAside);
  assert.equal(back.activity.method, "ab_test");
  assert.deepEqual([back.activity.baseline, back.activity.stoppingRule, back.activity.stoppingRuleConfirmed, back.activity.designs[0].label], [60, "Stop at 300.", true, "Current flow"]);
  assert.equal(back.activity.title, "Pay a bill", "the current shared fields win");
  assert.equal(back.activity.key, "k");
  assert.equal(back.setAside.survey?.method, "survey");
  assert.equal(switchActivityMethod(ab, "ab_test").activity, ab, "choosing the same method changes nothing");
  // Never exported: the set-aside copy isn't part of the activity.
  assert.equal("setAside" in back.activity, false);
});

test("a blank or out-of-range loss allowance shows no recruit numbers instead of wrong ones (audit 9)", () => {
  const ab = { ...newStudyActivity("ab_test", "ab"), title: "Pay", instructions: "Pay.", successSignal: "paid", stoppingRule: STOP_DEFAULT, stoppingRuleConfirmed: true,
    designs: [{ label: "Current", url: "https://x.gov/c" }, { label: "New", url: "https://x.gov/n" }] };
  const tree = { ...newStudyActivity("tree_test", "t"), title: "Find", instructions: "Find it.", tree: "Home\n  Records *" };
  const discover = { ...newStudyActivity("prototype", "p"), title: "Look", instructions: "Look.", goal: "discover" as const, url: "https://x.gov/p" };
  for (const lossAllowance of [null, 55, 7.5, -1]) {
    const summary = summarizeActivities([ab, tree, discover], lossAllowance);
    assert.equal(summary.largest, null, `${lossAllowance}: no largest need`);
    for (const item of summary.items) {
      assert.deepEqual([item.recruit, item.recruitLabel], [null, null], `${lossAllowance}`);
      assert.ok(item.size.includes(NO_LOSS_ALLOWANCE_TEXT), `${lossAllowance}: ${item.size}`);
      assert.doesNotMatch(item.size, /No loss allowance is set|Recruit about/);
    }
    assert.ok(summary.items[0].analysis.includes(NO_LOSS_ALLOWANCE_TEXT));
    const problems = studyDraftProblems({ title: "Study", decision: "D", question: "Q", participants: "P", setup: { ...DEFAULT_STUDY_SETUP, lossAllowance }, activities: [ab, tree, discover] });
    assert.ok(problems.some(problem => /loss allowance from 0 to 50%/.test(problem)), `${lossAllowance}: save is blocked`);
  }
  // 0 is a real allowance: recruit the target itself.
  const none = summarizeActivities([tree], 0);
  assert.equal(none.items[0].recruit, none.items[0].plannerN);
  assert.match(none.items[0].size, /No loss allowance is set, so recruit \d+\./);
});
