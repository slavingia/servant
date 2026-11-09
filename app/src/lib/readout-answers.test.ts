import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { commentSections, EMPTY_CODING, parseCoding, questionTables, SMALL_THEME_MIN, summarizeAnswers, themeCounts, type Coding, type Comment } from "./readout-answers.ts";
import { draftReadout, parseReadoutDraft, readoutDocx, readoutHtml, readoutProblems, readoutResults, readStudyFile, type ReadoutResults } from "./readout.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const study = () => {
  const read = readStudyFile(fixture("research-studio-demo-ab.json"));
  assert.ok("study" in read);
  return read.study;
};
// A made-up export of the demo study run inside a survey (scripts/make-embedded-fixture.mjs).
const embedded = async () => {
  const r = await readoutResults(study(), fixture("qualtrics-embedded-SYNTHETIC.csv"));
  assert.ok("results" in r, JSON.stringify(r));
  return r;
};

test("ratings come back as totals per design; comments come back separately and aren't in the results", async () => {
  const { results, comments } = await embedded();
  const ease = results.questions!.find(q => q.questionId === "request-ease")!;
  assert.equal(ease.kind, "scale");
  assert.equal(ease.taskId, "find-service-request");
  assert.deepEqual(ease.choices, ["1", "2", "3", "4", "5", "6", "7"]);
  for (const d of ease.designs) {
    assert.equal(d.n, 12, "everyone answered");
    assert.equal(d.counts.reduce((s, n) => s + n, 0), d.n);
    assert.ok(d.median! >= 1 && d.median! <= 7);
  }
  const clarity = results.questions!.find(q => q.questionId === "overall-clarity")!;
  assert.equal(clarity.taskId, null, "asked after all the tasks");
  assert.equal(clarity.designs.reduce((s, d) => s + d.n, 0), 24, "grouped by the one design each person saw");
  const issue = results.commentQuestions!.find(q => q.questionId === "request-issue")!;
  assert.equal(issue.designs.reduce((s, d) => s + d.n, 0), comments.filter(c => c.questionId === "request-issue").length);
  assert.ok(comments.length > 5);
  assert.ok(comments.every(c => /^[0-9a-f]{24}$/.test(c.key) && ["design-a", "design-b"].includes(c.designId)));
  // The results (what's saved) carry counts only: no comment's words.
  const kept = JSON.stringify(results);
  for (const c of comments) assert.ok(!kept.includes(c.text), `comment kept: ${c.text}`);
});

test("the same words for the same question and design get the same fingerprint", async () => {
  const { comments } = await embedded();
  const same = comments.filter(c => c.text === "Couldn't tell which request was the newest.");
  const a = same.filter(c => c.designId === "design-a"), b = same.filter(c => c.designId === "design-b");
  assert.ok(a.length && b.length);
  assert.equal(new Set(a.map(c => c.key)).size, 1);
  assert.notEqual(a[0].key, b[0].key, "a different design is a different comment");
});

test("choice questions count each option per design", async () => {
  const source = { preQuestions: [{ id: "used", type: "single", text: "Have you used it?", options: ["Yes", "No"] }, { id: "tools", type: "multi", text: "Which?", options: ["App", "Web", "Phone"] }], tasks: [] };
  const flat = {
    starts: [{ session_id: "s1", variant_id: "a" }, { session_id: "s2", variant_id: "b" }, { session_id: "s3", variant_id: "a" }, { session_id: "s3", variant_id: "b" }],
    answers: [
      { session_id: "s1", task_id: "", stage: "pre", question_id: "used", response: "Yes" },
      { session_id: "s2", task_id: "", stage: "pre", question_id: "used", response: "No" },
      { session_id: "s3", task_id: "", stage: "pre", question_id: "used", response: "No" },
      { session_id: "s1", task_id: "", stage: "pre", question_id: "tools", response: ["App", "Web"] },
      { session_id: "s2", task_id: "", stage: "pre", question_id: "tools", response: "Web|Phone" },
    ],
  };
  const { questions } = await summarizeAnswers(source, [{ id: "t", designs: [{ id: "a", letter: "A", label: "One" }, { id: "b", letter: "B", label: "Two" }] }], flat);
  const used = questions.find(q => q.questionId === "used")!;
  assert.deepEqual(used.designs.map(d => [d.n, d.counts]), [[1, [1, 0]], [1, [0, 1]]], "someone who saw both designs isn't counted under either");
  const tools = questions.find(q => q.questionId === "tools")!;
  assert.equal(tools.multiple, true);
  assert.deepEqual(tools.designs.map(d => d.counts), [[1, 1, 0], [0, 1, 1]]);
});

const coded = (comments: Comment[]): Coding => {
  const coding: Coding = { themes: [{ id: "t1", name: "Hard to find requests" }, { id: "t2", name: "Unclear which is newest" }], codes: {}, counts: [], quotes: [] };
  for (const c of comments) {
    if (/sidebar|requests page|didn't see/i.test(c.text)) coding.codes[c.key] = ["t1"];
    if (/newest/.test(c.text)) coding.codes[c.key] = [...(coding.codes[c.key] ?? []), "t2"];
  }
  const quote = comments.find(c => c.text.startsWith("The sidebar had"))!;
  coding.quotes = [{ key: quote.key, questionId: quote.questionId, designId: quote.designId, text: quote.text }];
  coding.counts = themeCounts(coding, comments);
  return coding;
};

test("themes are counted per question and design; small counts and small designs are hidden in what's shared", async () => {
  const { results, comments } = await embedded();
  const coding = coded(comments);
  const hard = coding.counts.filter(c => c.themeId === "t1");
  assert.ok(hard.length && hard.every(c => c.designId === "design-a"));
  const sections = commentSections(results.commentQuestions!, coding, () => false, "Not shown", () => "Find your most recent service request");
  assert.equal(sections.length, 1);
  const table = sections[0].table!;
  assert.deepEqual(table.rows.map(r => r[0]), ["Hard to find requests", "Unclear which is newest"]);
  for (const row of table.rows) for (const cell of row.slice(1)) assert.ok(cell === "0" || cell === `Fewer than ${SMALL_THEME_MIN}` || Number(cell) >= SMALL_THEME_MIN, cell);
  assert.deepEqual(sections[0].quotes, ["“The sidebar had too many links.” (Design A, Sidebar navigation)"]);
  const hiddenA = commentSections(results.commentQuestions!, coding, id => id === "design-a", "Not shown", () => "Task");
  assert.ok(hiddenA[0].table!.rows.every(r => r[1] === "Not shown"));
  assert.deepEqual(hiddenA[0].quotes, [], "a hidden design's quotes aren't shared");
  // Ratings tables hide small designs too.
  const tables = questionTables(results.questions!, "find-service-request", id => id === "design-b", "Not shown");
  assert.match(tables[0].caption, /\(1 = Very difficult, 7 = Very easy\)$/);
  assert.deepEqual(tables[0].rows[1].slice(1), ["—", "Not shown", "—"]);
  assert.match(tables[0].rows[0][3], /^1: \d+ · 2: \d+ · 3: \d+ · 4: \d+ · 5: \d+ · 6: \d+ · 7: \d+$/);
});

test("the readout drafts rating lines, checks themes and quotes, and shares what people said", async () => {
  const { results, comments } = await embedded();
  const coding = coded(comments);
  const draft = { ...draftReadout(study(), results), summary: "Both layouts helped." };
  assert.match(draft.findings, /- How easy or difficult was it to find the service request\? \(1 = Very difficult, 7 = Very easy\): Design A median [\d.]+ from 12 people; Design B median/);
  assert.match(draft.findings, /Before and after the tasks\n- How clear was the account navigation overall\?/);
  assert.deepEqual(readoutProblems(draft, results, coding), []);
  const phone = comments.find(c => /555-123-4567/.test(c.text))!;
  const risky: Coding = { ...coding, quotes: [...coding.quotes, { key: phone.key, questionId: phone.questionId, designId: phone.designId, text: phone.text }] };
  assert.match(readoutProblems(draft, results, risky).join(" "), /Edit or remove quote 2: it looks like it has a phone number/);
  const badTheme: Coding = { ...coding, themes: coding.themes.map(t => t.id === "t2" ? { ...t, name: "Asked us to email pat@example.gov" } : t) };
  assert.match(readoutProblems(draft, results, badTheme).join(" "), /Reword the theme “Asked us to email/);
  const html = readoutHtml(draft, results, { coding });
  assert.match(html, /<h2>What people said<\/h2>/);
  assert.match(html, /<caption>What, if anything, made this task difficult\?: themes in the comments<\/caption>/);
  assert.match(html, /<li>“The sidebar had too many links\.” \(Design A, Sidebar navigation\)<\/li>/);
  assert.match(html, /<caption>How easy or difficult was it to find the service request\? \(1 = Very difficult, 7 = Very easy\)<\/caption>/);
  assert.match(html, /<h3>Before and after the tasks<\/h3>/);
  for (const c of comments) if (c.text !== "The sidebar had too many links.") assert.ok(!html.includes(c.text.replace(/'/g, "&#39;").replace(/"/g, "&quot;")), `only reviewed quotes are shared: ${c.text}`);
  const docx = new TextDecoder().decode(readoutDocx(draft, results, { coding }));
  assert.match(docx, /What people said/);
  assert.match(docx, /Hard to find requests/);
});

test("a saved coding is checked before it's put back, and a saved readout carries it", async () => {
  const { results, comments } = await embedded();
  const coding = coded(comments);
  assert.deepEqual(parseCoding(JSON.parse(JSON.stringify(coding))), coding);
  assert.deepEqual(parseCoding(null), EMPTY_CODING);
  const bad = parseCoding({ themes: [{ id: "t1", name: "Kept" }, { id: "", name: "No id" }], codes: { "not-a-key": ["t1"], [comments[0].key]: ["t1", "gone"] }, counts: [{ themeId: "gone", questionId: "q", designId: "d", n: 2 }], quotes: [{ key: "k", questionId: "q", designId: "d", text: " " }] });
  assert.deepEqual(bad, { themes: [{ id: "t1", name: "Kept" }], codes: { [comments[0].key]: ["t1"] }, counts: [], quotes: [] });
  const draft = parseReadoutDraft({ version: 1, studyName: "s.json", study: study().source, files: { survey2: "x.csv", survey1: null }, results, readout: draftReadout(study(), results), coding });
  assert.deepEqual(draft!.coding, coding);
  const saved = JSON.stringify(draft);
  for (const c of comments) if (!coding.quotes.some(q => q.text === c.text)) assert.ok(!saved.includes(c.text), "only reviewed quotes are saved");
  const old = parseReadoutDraft({ version: 1, studyName: "s.json", study: study().source, files: { survey2: "x.csv", survey1: null }, results: { ...results, questions: undefined, commentQuestions: undefined } as ReadoutResults, readout: draftReadout(study(), results) });
  assert.deepEqual(old!.coding, EMPTY_CODING, "readouts saved before comments existed still open");
});
