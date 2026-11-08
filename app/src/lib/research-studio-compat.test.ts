import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildResearchStudioWorkingCopy, DEFAULT_STUDY_SETUP, newStudyActivity, RESEARCH_STUDIO_VERSION, studioPlanTexts, studyDraftProblems, summarizeActivities, type StudyActivity } from "./research-methods.ts";
import {
  researchStudioImportChanges,
  researchStudioImportView,
  servantPlannedSize,
  SUPPORTED_RESEARCH_STUDIO_COMMIT,
  SUPPORTED_RESEARCH_STUDIO_VERSION,
  type WorkingDraft,
} from "./research-studio-compat.ts";

// Produced by scripts/research-studio-golden.mjs, which imports each draft with
// Research Studio 0.3.24's own validateStudy, validatePlan and ensurePlan, then
// reads back what a person sees: its planner's numbers, its hypothesis
// sentences, and the recruitment, exclusions and analysis as its plan editor
// (planHTML) and plan document (planBlocks) show them.
type View = ReturnType<typeof researchStudioImportView>;
type GoldenCase = { name: string; activities: StudyActivity[]; draft: WorkingDraft; studio: Omit<View, "shown"> & { shown: View["shown"] & { inEditor: Record<string, boolean>; inDocument: Record<string, boolean> } } };
const golden = JSON.parse(fs.readFileSync(new URL("./research-studio-golden.json", import.meta.url), "utf8")) as { researchStudio: { version: string; commit: string }; cases: GoldenCase[] };
const byName = (prefix: string) => golden.cases.find(item => item.name.startsWith(prefix))!;
const brief = { title: "Golden study", decision: "Decide", question: "Question", participants: "People", setup: DEFAULT_STUDY_SETUP };
const exported = (activities: readonly StudyActivity[]) => buildResearchStudioWorkingCopy({ ...brief, activities }) as unknown as WorkingDraft;
const problems = (activities: readonly StudyActivity[]) => studyDraftProblems({ ...brief, decision: "D", question: "Q", participants: "P", activities });

test("the supported Research Studio version is the one the golden values came from", () => {
  assert.equal(SUPPORTED_RESEARCH_STUDIO_VERSION, RESEARCH_STUDIO_VERSION);
  assert.deepEqual(golden.researchStudio, { version: SUPPORTED_RESEARCH_STUDIO_VERSION, commit: SUPPORTED_RESEARCH_STUDIO_COMMIT });
});

test("the import model matches what Research Studio 0.3.24 shows for each draft, hypotheses and analysis included", () => {
  for (const item of golden.cases) {
    assert.deepEqual(exported(item.activities), item.draft, `${item.name}: the export is unchanged since the golden values were made`);
    const { inEditor, inDocument, editedIn: _editedIn, ...shown } = item.studio.shown as GoldenCase["studio"]["shown"] & { editedIn?: unknown };
    assert.deepEqual(researchStudioImportView(item.draft), { ...item.studio, shown }, item.name);
    assert.deepEqual(inEditor, { recruitment: true, exclusions: true, analysis: true }, `${item.name}: visible in the plan editor`);
    assert.deepEqual(inDocument, { analysis: true }, `${item.name}: in the plan document`);
  }
});

test("round trip: recruitment assumption, analysis denominators, targets and exclusions stay visible and unchanged", () => {
  for (const item of golden.cases) {
    const texts = studioPlanTexts(DEFAULT_STUDY_SETUP, item.activities);
    const { recruitment, exclusions, analysis, editedIn } = item.studio.shown as View["shown"] & { editedIn: Record<string, string> };
    assert.deepEqual({ recruitment, exclusions, analysis }, texts, `${item.name}: exactly what Servant planned`);
    // Research Studio edits Recruitment and Exclusions in one-line input boxes, which drop line breaks:
    // those fields are one short line each, and everything else lives in the multi-line analysis plan.
    assert.deepEqual(editedIn, { recruitment: "input", exclusions: "input", analysis: "textarea" }, item.name);
    for (const [field, value] of Object.entries({ recruitment, exclusions })) {
      assert.doesNotMatch(value, /[\r\n]/, `${item.name}: ${field} has no line breaks`);
      assert.ok(value.length <= 500, `${item.name}: ${field} is short (${value.length})`);
    }
    // The analysis Research Studio shows is the analysis Servant showed.
    for (const shown of summarizeActivities(item.activities).items) assert.ok(analysis.includes(shown.analysis), item.name);
  }
  const every = byName("recruitment for every method").studio.shown;
  assert.match(every.analysis, /^Sample size and recruitment\nLoss assumption: 20% of recruits won't reach each activity's analysis denominator, so each target is recruited as n ÷ \(1 − 0\.20\)\./);
  assert.match(every.analysis, /Prototype usability\): analysis denominator people completing a usable session, per round; target 5 per round \(15 in total\), shown by Research Studio as 15; recruit about 7 per round \(21 in total\)\./);
  assert.match(every.analysis, /Card sorting\): analysis denominator completed sorts; target 20; recruit about 25\./);
  assert.match(every.analysis, /Tree testing\): analysis denominator people who start the activity; target 81; recruit about 102\./);
  assert.match(every.recruitment, /^Recruit about 122 people for the largest need \(survey survey\), allowing for 20% of recruits lost before randomization or start\. Everyone takes every activity\./);
  assert.match(every.recruitment, /Each activity's target and analysis denominator are in the analysis plan\.$/);
  assert.match(every.exclusions, /screen-outs, ineligible people, no-shows and technical failures are in no denominator \(the loss allowance covers them\)/);
  const ab = byName("higher, control A").studio.shown;
  assert.match(ab.analysis, /analysis denominator eligible participants randomized to each design; target 152 per design \(304 in total\), shown by Research Studio as 304; recruit about 380\./);
  assert.match(ab.exclusions, /After randomization or start, nobody is excluded/);
  assert.match(ab.analysis, /Each design's denominator is every eligible participant randomized to it/);
});

test("round trip: Research Studio's own sample-size summary and size text agree with the plan's text (audit 2)", () => {
  for (const item of golden.cases) {
    if (researchStudioImportChanges(item.draft).length) continue; // blocked from saving
    const { summary, texts } = item.studio.sizes;
    const ours = summarizeActivities(item.activities);
    const { recruitment, analysis } = item.studio.shown;
    // Each number Research Studio shows is one the analysis plan names, beside the recruit number that adds the allowance.
    for (const [index, shown] of ours.items.entries()) {
      if (shown.plannerN == null) continue;
      assert.ok(summary.rows.some(r => r.n === shown.plannerN), `${item.name}: Research Studio shows ${shown.plannerN} for activity ${index + 1}`);
      const studio = shown.target === String(shown.plannerN) ? "" : `, shown by Research Studio as ${shown.plannerN}`;
      assert.ok(analysis.includes(`target ${shown.target}${studio}; recruit ${shown.recruitLabel}.`), `${item.name}: activity ${index + 1}`);
    }
    assert.equal(summary.rows.length, ours.items.filter(i => i.plannerN != null).length, `${item.name}: no Studio number without an explanation`);
    if (summary.top) {
      // The number Research Studio calls its largest need is the one the recruitment field names, and the recruit number never falls below it.
      assert.ok(recruitment.includes(`Research Studio's sample-size summary shows about ${summary.top.n} "plus extra for drop-out"`), item.name);
      assert.ok(ours.largest!.n >= summary.top.n, `${item.name}: the recruit number is never below Research Studio's`);
      assert.ok(recruitment.startsWith(`Recruit about ${ours.largest!.n} people for the largest need`), item.name);
    }
    // Where Research Studio says "completing" for a starters' target, the plan says how to read it.
    const starters = texts.filter(t => /people completing the activity/.test(t.text)).map(t => item.draft.tasks.find(task => task.id === t.id)!.method)
      .filter(method => ["prototype", "tree_test", "first_click"].includes(method));
    if (starters.length) assert.match(analysis, /Research Studio's size text calls prototype-task, tree-test and first-click targets "people completing the activity": read them as people who start, as its standard analysis does\./, item.name);
    for (const t of texts.filter(t => /plus extra for drop-out/.test(t.text))) assert.match(t.text, /^Recruit about \d+ people assigned per design \((\d+) in total\)/);
  }
  const every = byName("recruitment for every method");
  assert.deepEqual(every.studio.sizes.summary.rows.map(r => r.n), [15, 20, 81, 97]);
  assert.match(every.studio.sizes.texts[2].text, /^About 81 people completing the activity/, "Research Studio's wording, as imported");
  assert.match(byName("higher, control A").studio.shown.recruitment, /Research Studio's sample-size summary shows about 304 "plus extra for drop-out": that's the analysis target, and the 380 here already includes the extra\./);
});

test("when Research Studio's largest analysis target and the largest recruit number are different activities, both are named (review)", () => {
  const rounds = { ...newStudyActivity("prototype", "rounds"), title: "Rounds", instructions: "Look.", goal: "discover" as const, url: "https://example.com/p/", perRound: 5, rounds: 5 };
  const survey = { ...newStudyActivity("survey", "survey"), title: "Survey", instructions: "Answer.", questions: "Q?", margin: 19 };
  const { recruitment } = studioPlanTexts(DEFAULT_STUDY_SETUP, [rounds, survey]);
  const items = summarizeActivities([rounds, survey]).items;
  assert.deepEqual([items[0].plannerN, items[0].recruit, items[1].plannerN, items[1].recruit], [25, 35, 27, 34]);
  assert.match(recruitment, /^Recruit about 35 people for the largest need \(Rounds\)/);
  assert.match(recruitment, /shows about 27 "plus extra for drop-out" for its largest analysis target \(Survey\); with the extra included, Rounds needs the most recruits \(35\)\./);
});

test("with no loss allowance, the recruitment field says Research Studio's extra isn't added (audit 2)", () => {
  const item = byName("higher, control A");
  const texts = studioPlanTexts({ ...DEFAULT_STUDY_SETUP, lossAllowance: 0 }, item.activities);
  assert.match(texts.recruitment, /^Recruit about 304 people for the largest need \(AB higher-a\), with no loss allowance\./);
  assert.match(texts.recruitment, /Research Studio's sample-size summary shows the same 304 "plus extra for drop-out"; with no loss allowance, none is added\./);
  assert.doesNotMatch(texts.exclusions, /loss allowance covers/);
});

test("round trip: A/B plans keep size, target, direction, two-sided analysis and the same Design A/B in both tools", () => {
  for (const name of ["higher, control A", "higher, Design B chosen as control"]) {
    const item = byName(name), [studio] = item.studio.experiments;
    const ours = servantPlannedSize(Object.values(item.draft.plan.experiments)[0], 2)!;
    assert.deepEqual([studio.perDesign, studio.target, studio.directions], [ours.perDesign, Math.round(ours.target * 100), ["higher"]], name);
    assert.deepEqual(researchStudioImportChanges(item.draft), [], `${name} imports unchanged`);
    // Same letters, same designs: Research Studio's sentence is ours without the closing note.
    const [mine] = summarizeActivities(item.activities).items[0].hypotheses;
    assert.ok(mine.startsWith(studio.hypotheses[0].replace(/\.$/, "")), `${name}: "${studio.hypotheses[0]}" vs "${mine}"`);
    assert.match(item.studio.shown.analysis, /two-sided Newcombe hybrid score interval at 95%/);
    assert.doesNotMatch(item.studio.shown.analysis, /one-sided/i);
  }
  const b = byName("higher, Design B chosen as control").studio.experiments[0];
  assert.deepEqual([b.variantIds, b.labels, b.controlId], [["design-a", "design-b"], ["New flow", "Current flow"], "design-a"], "the chosen control is Design A");
  const self = byName("self-reported primary").studio.experiments[0];
  assert.match(self.hypotheses[0], /higher self-reported completion rate\.$/);
  assert.match(byName("self-reported primary").studio.shown.analysis, /Secondary measures \(active time on task; drop-out by design\)/, "no measured-success secondary without a signal");
});

test("round trip: lower-direction plans keep their meaning, or the export is blocked", () => {
  const kept = byName("lower 90/15");
  assert.deepEqual(kept.studio.experiments[0].directions, ["lower"]);
  assert.deepEqual([kept.studio.experiments[0].target, kept.studio.experiments[0].perDesign], [75, servantPlannedSize(Object.values(kept.draft.plan.experiments)[0], 2)!.perDesign]);
  assert.match(kept.studio.experiments[0].hypotheses[0], /lower task success rate\.$/);
  assert.deepEqual(researchStudioImportChanges(kept.draft), []);
  assert.deepEqual(problems(kept.activities), []);
  for (const name of ["lower 60/15", "different 70/10"]) {
    const changed = byName(name);
    const ours = servantPlannedSize(Object.values(changed.draft.plan.experiments)[0], 2)!;
    assert.notEqual(changed.studio.experiments[0].target, Math.round(ours.target * 100), `${name}: Research Studio really does change it`);
    const [problem] = researchStudioImportChanges(changed.draft);
    assert.match(problem.problem, /^Research Studio 0\.3\.24 ignores the planning direction, so it would plan a change from \d+% to \d+%/);
    assert.deepEqual(problems(changed.activities), [`Activity 1 (A/B implementation test): ${problem.problem}`], name);
  }
  assert.deepEqual(researchStudioImportChanges(byName("different 30/10").draft), []);
});

test("round trip: two-option preference keeps its split and size; three-option exploratory tests are blocked", () => {
  const two = byName("two-option preference");
  assert.deepEqual([two.studio.preferences[0].split, two.studio.preferences[0].n], [65, 85]);
  assert.match(summarizeActivities(two.activities).items[0].size, /about 85 people choosing an option, to tell a 65\/35 split/);
  assert.deepEqual(researchStudioImportChanges(two.draft), []);
  const three = byName("three-option");
  assert.equal(Object.values(three.draft.plan.activities)[0].split, null, "Servant plans no split");
  assert.deepEqual([three.studio.preferences[0].split, three.studio.preferences[0].n], [60, 194], "Research Studio 0.3.24 would add one");
  assert.match(researchStudioImportChanges(three.draft)[0].problem, /would add a 60\/40 split and a sample size of 194 to this exploratory test/);
  assert.equal(problems(three.activities).length, 1);
});
