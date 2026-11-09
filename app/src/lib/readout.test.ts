import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { draftedPart, updateReadout, draftFindings, draftLimitations, PRACTICE_NOTE, PREVIEWS_ONLY, draftReadout, formatSeconds, points, readoutDocx, readoutFileName, readoutHtml, readoutProblems, readoutResults, readStudyFile, resultTables, SMALL_GROUP_MIN, timeText, type ReadoutResults } from "./readout.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const studyText = fixture("research-studio-demo-ab.json");
const survey1 = fixture("qualtrics-survey1-SYNTHETIC.csv");
const survey2 = fixture("qualtrics-survey2-SYNTHETIC.csv");
const study = () => {
  const read = readStudyFile(studyText);
  assert.ok("study" in read);
  return read.study;
};
const results = async (s1 = survey1) => {
  const r = await readoutResults(study(), survey2, s1);
  assert.ok("results" in r, JSON.stringify(r));
  return r.results;
};

test("a study file needs A/B activities; working drafts and published studies both read", () => {
  const s = study();
  assert.equal(s.abActivities.length, 2);
  assert.deepEqual(s.abActivities[0].designs, ["Sidebar navigation", "Dashboard shortcuts"]);
  assert.ok("study" in readStudyFile(JSON.stringify({ study: JSON.parse(studyText) })), "a file that wraps the study");
  assert.match((readStudyFile("not json") as { problem: string }).problem, /isn't a study file/);
  assert.match((readStudyFile(JSON.stringify({ id: "x", tasks: [{ id: "t", method: "survey" }] })) as { problem: string }).problem, /no A\/B activities/);
});

test("results match Research Studio's import of the same exports, and keep only totals", async () => {
  const r = await results();
  assert.equal(r.responses, 59);
  assert.equal(r.dropouts, 11);
  assert.equal(r.survey1Provided, true);
  assert.equal(r.activities.length, 2);
  const a = r.activities[0];
  assert.equal(a.designs.length, 2);
  assert.equal(a.designs.reduce((s, d) => s + d.assigned, 0), 70, "everyone assigned in Survey 1");
  assert.equal(a.designs.reduce((s, d) => s + d.finished, 0), 59);
  for (const d of a.designs) {
    assert.ok(d.primary && d.primary.lo <= d.primary.p && d.primary.p <= d.primary.hi);
    assert.equal(d.primary!.n, d.assigned, "the main measure counts everyone assigned");
  }
  assert.ok(a.checks.some(c => c.title === "Group sizes"));
  // Nothing that identifies a response or a session, and no per-person values.
  const kept = JSON.stringify(r);
  assert.doesNotMatch(kept, /R_TEST|RRESP|sess-\d|"times"|"successTimes"/);
});

test("without Survey 1, drop-out is unknown and the readout says so", async () => {
  const r = await results("");
  assert.equal(r.survey1Provided, false);
  assert.equal(r.activities[0].dropoutUnknown, true);
  assert.ok(r.warnings.some(w => /Survey 1 was not imported/.test(w)));
  assert.match(draftReadout(study(), r).limitations, /drop-out/i);
  assert.doesNotMatch(draftReadout(study(), await results()).limitations, /Check designs/, "Research Studio's own instructions are left out");
});

test("the wrong files are explained", async () => {
  assert.match(((await readoutResults(study(), survey1)) as { problems: string[] }).problems[0], /intake survey/);
  assert.match(((await readoutResults(study(), "a,b\n1,2")) as { problems: string[] }).problems[0], /rs_ fields/);
  assert.match(((await readoutResults(study(), survey2, survey2)) as { problems: string[] }).problems[0], /isn't the intake survey/);
});

test("drafted findings are cautious: ranges, no winner, early comparisons named", async () => {
  const r = await results();
  const lines = draftFindings(r.activities[0]);
  assert.ok(lines.some(l => /^Design A \(Sidebar navigation\): \d+% succeeded \(\d+ of \d+ assigned; 95% range \d+% to \d+%\)\.$/.test(l)), lines.join("\n"));
  assert.ok(lines.some(l => /Design B .*(differed from A|The range includes zero)/.test(l) || /The difference between Design B/.test(l)));
  assert.doesNotMatch(lines.join(" "), /winner|better|proven|validated/i);
  const early: ReadoutResults = { ...r, activities: [{ ...r.activities[0], comparisons: r.activities[0].comparisons.map(c => ({ ...c, enough: false })) }] };
  assert.match(draftFindings(early.activities[0]).join(" "), /too early to compare/);
  assert.equal(points(0.004), "+0.4");
  assert.equal(points(-0.12), "−12");
});

test("checks before sharing: required sections, overclaiming, quotes, early comparisons", async () => {
  const r = await results();
  const draft = draftReadout(study(), r);
  assert.match(draft.background, /Sidebar navigation/);
  assert.deepEqual(readoutProblems(draft, r), ["Write the summary."]);
  const ready = { ...draft, summary: "Both layouts helped people find a request." };
  assert.deepEqual(readoutProblems(ready, r), []);
  assert.match(readoutProblems({ ...ready, summary: "Design B is the winner." }, r).join(" "), /Reword “winner”/);
  assert.match(readoutProblems({ ...ready, summary: "This validated the layout." }, r).join(" "), /Reword “validated”/);
  assert.match(readoutProblems({ ...ready, findings: `${ready.findings}\nOne person said "I gave up".` }, r).join(" "), /quotation marks/);
  const early: ReadoutResults = { ...r, activities: r.activities.map(a => ({ ...a, comparisons: a.comparisons.map(c => ({ ...c, enough: false })) })) };
  assert.match(readoutProblems({ ...ready, findings: "Layouts compared.", limitations: "Small study." }, early).join(" "), /too early to read/);
});

test("the Word document is a real .docx with the text and the results tables", async () => {
  const r = await results();
  const draft = { ...draftReadout(study(), r), summary: "Both layouts helped people find a request." };
  const bytes = readoutDocx(draft, r, { date: new Date("2026-11-08T12:00:00Z") });
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), "PK");
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /Both layouts helped people find a request\./);
  assert.match(text, /Compared with A/);
  assert.match(text, /Sidebar navigation/);
  assert.match(text, /Median active time/);
  assert.match(text, /<w:pStyle w:val="ListBullet"\/><w:numPr>/, "bullets are real Word list items");
  assert.match(text, /word\/numbering\.xml/);
  assert.equal(readoutFileName("Readout: Find a request", "html"), "readout-find-a-request.html");
  assert.equal(readoutFileName("Readout: Find a request — round 1"), "readout-find-a-request-round-1.docx");
  assert.equal(readoutFileName("???"), "study-readout.docx");
});

test("details about a person are caught before sharing; the drafted text passes", async () => {
  const r = await results();
  const ready = { ...draftReadout(study(), r), summary: "Both layouts helped people find a request." };
  assert.deepEqual(readoutProblems(ready, r), []);
  const flagged = (change: Partial<typeof ready>) => readoutProblems({ ...ready, ...change }, r).join(" ");
  assert.match(flagged({ summary: "One person gave 123-45-6789 in the survey." }), /Social Security or taxpayer ID number from the summary/);
  assert.match(flagged({ nextSteps: "Follow up with pat@example.gov." }), /email address from the next steps/);
  assert.match(flagged({ findings: "Call (555) 123-4567 back." }), /phone number from the findings/);
  assert.match(flagged({ limitations: "Response R_1a2B3c4D5e6F was a test." }), /Qualtrics response ID from the limits/);
  assert.match(flagged({ title: "Readout 12-3456789" }), /employer ID number from the title/);
  assert.doesNotMatch(flagged({ summary: "Design B differed by +17 points (−6 to +38), 22 of 35." }), /looks like/);
});

test("designs under the small-group minimum are hidden in what's shared, not in the app's results", async () => {
  const r = await results();
  const a = r.activities[0];
  const small = { ...a.designs[1], assigned: SMALL_GROUP_MIN - 1, finished: 7 };
  const activity = { ...a, designs: [a.designs[0], small], comparisons: a.comparisons.map(c => ({ ...c, enough: false })) };
  const table = resultTables(activity)[0];
  assert.deepEqual(table.rows[1].slice(1), [`Fewer than ${SMALL_GROUP_MIN}`, "—", `Not shown: fewer than ${SMALL_GROUP_MIN} people`, "—"]);
  assert.match(table.rows[0][3], /^\d+% \(\d+% to \d+%\)$/);
  assert.match(draftFindings(activity).join(" "), /fewer than 10 people were assigned, so its results aren't shown/);
  const shared: ReadoutResults = { ...r, activities: [activity] };
  const html = readoutHtml({ ...draftReadout(study(), shared), summary: "Early look." }, shared);
  assert.doesNotMatch(html, new RegExp(`${small.primary!.k} of ${small.primary!.n}`));
  assert.doesNotMatch(html.slice(html.indexOf("<svg"), html.indexOf("</svg>")), /Design B/, "the chart leaves the small design out");
});

test("times read as people say them", () => {
  assert.equal(formatSeconds(48.4), "48 s");
  assert.equal(formatSeconds(120), "2 min");
  assert.equal(formatSeconds(125), "2 min 5 s");
  assert.equal(timeText(null), "—");
  assert.equal(timeText({ m: 40, lo: null, hi: null, n: 3 }), "40 s (too few for a range)");
  assert.equal(timeText({ m: 40, lo: 30, hi: 75, n: 30 }), "40 s (30 s to 1 min 15 s)");
});

test("the PDF page is accessible: language, headings, described chart, captioned tables; text is escaped", async () => {
  const r = await results();
  const draft = { ...draftReadout(study(), r), title: "Readout <script>alert(1)</script>", summary: "Both layouts helped.\n- First point\n- Second point" };
  const html = readoutHtml(draft, r, { author: "Preview Researcher", date: new Date("2026-11-08T12:00:00Z") });
  assert.match(html, /^<!doctype html><html lang="en">/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<h1>Readout &lt;script&gt;/);
  assert.match(html, /<h2>Summary<\/h2><p>Both layouts helped\.<\/p><ul><li>First point<\/li><li>Second point<\/li><\/ul>/);
  assert.match(html, /<svg aria-hidden="true"/, "the drawn marks repeat the caption");
  assert.match(html, /<figcaption>Task success, everyone assigned, with 95% ranges: Design A, \d+% \(\d+% to \d+%\)/);
  assert.match(html, /<caption>[^<]+: each design&#39;s results<\/caption>/);
  assert.match(html, /<th scope="col">Design<\/th>/);
  assert.match(html, /<th scope="row">A · Sidebar navigation<\/th>/);
  assert.match(html, /Written by Preview Researcher\./);
});

test("previews and test responses: left out, explained when that's all there is, and a marked practice run on request", async () => {
  // The same synthetic export, as if every response were a Qualtrics survey preview.
  const asPreview = survey2.replace('"StartDate","Finished"', '"StartDate","Status","DistributionChannel","Finished"')
    .replace('"Start Date","Finished"', '"Start Date","Response Type","Distribution Channel","Finished"')
    .replace(/^("2026-[^"]*"),/gm, '$1,"Survey Preview","preview",');
  const left = await readoutResults(study(), asPreview, survey1) as { problems: string[]; previewsOnly?: boolean };
  assert.deepEqual(left.problems, [PREVIEWS_ONLY]);
  assert.equal(left.previewsOnly, true);
  const r = await readoutResults(study(), asPreview, survey1, { includePreviews: true });
  assert.ok("results" in r);
  const practice = r.results;
  assert.equal(practice.practice, true);
  assert.equal(practice.responses, 59, "the same numbers as the live export");
  assert.equal(draftLimitations(practice)[0], PRACTICE_NOTE);
  const draft = { ...draftReadout(study(), practice), summary: "Trying the readout." };
  assert.match(draft.title, /^Practice readout: /);
  assert.match(readoutHtml(draft, practice), /<p class="note">Practice run: made from Qualtrics preview and test responses/);
  assert.match(new TextDecoder().decode(readoutDocx(draft, practice)), /Practice run: made from Qualtrics preview/);
  assert.equal((await results()).practice, undefined, "live exports aren't marked");
  // Including previews changes nothing when every response is live.
  assert.equal(((await readoutResults(study(), survey2, survey1, { includePreviews: true })) as { results: ReadoutResults }).results.practice, undefined);
});

test("new results: drafted sections follow them, edited ones are kept and flagged until checked or redrafted", async () => {
  const before = await results("");          // Survey 2 only
  const after = await results();             // Survey 1 added: everyone assigned is counted
  const first = { ...draftReadout(study(), before), summary: "Mine." };
  const drafted = draftedPart(first);
  const fresh = draftReadout(study(), after);
  // Nothing edited: the numbers follow the new results, the summary stays.
  const same = updateReadout(first, drafted, fresh, { resultsChanged: true });
  assert.equal(same.readout.findings, fresh.findings);
  assert.match(same.readout.findings, /16 of 35 assigned/);
  assert.equal(same.readout.summary, "Mine.");
  assert.deepEqual(same.stale, []);
  // The findings were edited: they're kept, and flagged.
  const edited = { ...first, findings: `${first.findings}\nMy note.` };
  const kept = updateReadout(edited, drafted, fresh, { resultsChanged: true });
  assert.equal(kept.readout.findings, edited.findings);
  assert.equal(kept.readout.limitations, fresh.limitations, "the unedited limits still follow");
  assert.deepEqual(kept.stale, ["findings"]);
  assert.match(readoutProblems(kept.readout, after, undefined, kept.stale)[0], /^The results changed after you edited the findings\. Redraft/);
  // The same results again: nothing to flag.
  assert.deepEqual(updateReadout(edited, drafted, draftReadout(study(), before), { resultsChanged: false }).stale, []);
  // A readout saved before drafts were tracked keeps everything written, and flags it when the results change.
  assert.deepEqual(updateReadout(edited, null, fresh, { resultsChanged: true }).stale, ["background", "findings", "limitations"]);
});

test("more overclaiming is caught", async () => {
  const r = await results();
  const ready = { ...draftReadout(study(), r), summary: "x" };
  for (const claim of ["B significantly outperformed A.", "B outperforms A.", "A significant gain.", "B is superior."]) {
    assert.match(readoutProblems({ ...ready, summary: claim }, r).join(" "), /Reword “(significant|significantly|outperform|outperforms|outperformed|superior)”/i, claim);
  }
  assert.deepEqual(readoutProblems({ ...ready, summary: "B looked easier in comments; the range includes zero." }, r), []);
});
