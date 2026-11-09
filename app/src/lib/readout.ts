// Study readouts: results from a Civic Research Studio A/B study, imported from
// Qualtrics CSV exports on this device, turned into a report a researcher writes
// and checks before sharing.
//
// The numbers come from Civic Research Studio's own code (research-studio-vendor,
// copied from the supported version), so a readout shows what Research Studio's
// results dashboard shows for the same files. Only totals, rates and ranges are
// kept: the export's rows, response IDs, per-person times and answers are read
// here and dropped. Nothing is sent anywhere.
import { analyzeAB as analyzeABUntyped } from "./research-studio-vendor/ab-results.js";
import { classifyExport, eventsFromQualtrics, expandEmbedded, isLiveResponse, qualtricsRecords } from "./research-studio-vendor/qualtrics-import.js";
import { flattenEvents } from "./research-studio-vendor/shared.js";
import { SMALL_GROUP_MIN } from "./disclosure-rules.ts";
import { buildWordDocument, type WordBlock } from "./word-document.ts";
import { commentSections, EMPTY_CODING, parseCoding, SMALL_THEME_MIN, questionTables, ratingLines, summarizeAnswers, type Coding, type Comment, type CommentQuestion, type Flat, type QuestionSummary, type ResultTable } from "./readout-answers.ts";

export type { ResultTable } from "./readout-answers.ts";

export type Rate = { p: number; lo: number; hi: number; k: number; n: number };
export type Difference = { d: number; lo: number | null; hi: number | null };
export type MedianRange = { m: number; lo: number | null; hi: number | null; n: number };

export type DesignResult = {
  id: string;
  letter: string;
  label: string;
  assigned: number;
  finished: number;
  /** null when drop-out is unknown (no Survey 1). */
  dropped: number | null;
  measured: number;
  successes: number;
  selfDone: number;
  /** The main measure: successes (or self-reported completions) out of everyone assigned. */
  primary: Rate | null;
  /** Successes out of finishers whose success could be measured. */
  measuredRate: Rate | null;
  self: Rate | null;
  time: MedianRange | null;
  successTime: MedianRange | null;
};
export type ComparisonResult = {
  designId: string;
  letter: string;
  /** Both designs have enough people (Research Studio's minimum, 10) to read a comparison. */
  enough: boolean;
  primary: Difference | null;
  measured: Difference | null;
  self: Difference | null;
  time: Difference | null;
};
export type CheckResult = { level: "ok" | "warn" | "info"; title: string; text: string };
export type HypothesisResult = { n: number; sentence: string; status: "consistent" | "opposite" | "inconclusive" | "early" | "missing"; text: string; value: string; secondary: boolean };
export type ActivityResult = {
  id: string;
  title: string;
  /** Task success (success signal) or self-reported completion. */
  hasSignal: boolean;
  dropoutUnknown: boolean;
  /** Confidence level of the difference ranges (0.95, wider with 3+ designs). */
  confidence: number;
  minAssigned: number;
  designs: DesignResult[];
  comparisons: ComparisonResult[];
  checks: CheckResult[];
  hypotheses: HypothesisResult[];
};
export type ReadoutResults = {
  studyId: string;
  studyTitle: string;
  responses: number;
  dropouts: number;
  survey1Provided: boolean;
  /** Made from Qualtrics preview or test responses, to try the readout: not study results. */
  practice?: boolean;
  warnings: string[];
  activities: ActivityResult[];
  /** Ratings and choices, as totals per design. */
  questions?: QuestionSummary[];
  /** How many written comments each question got, per design (the comments aren't kept). */
  commentQuestions?: CommentQuestion[];
};

export type ReadoutStudy = {
  id: string;
  title: string;
  abActivities: { id: string; title: string; designs: string[] }[];
  /** The study as Research Studio reads it (tasks, designs, plan). */
  source: Record<string, unknown>;
};

// Research Studio's analysis, as this file reads it.
type Analysis = {
  designs: (Record<string, unknown> & { variant: { id: string; label: string }; index: number })[];
  comparisons: (Record<string, unknown> & { design: { variant: { id: string }; index: number } })[];
  checks: CheckResult[];
  hypotheses: HypothesisResult[];
  hasSignal: boolean;
  dropoutUnknown: boolean;
  conf: number;
  minAssigned: number;
};
const analyzeAB = analyzeABUntyped as unknown as (task: unknown, data: unknown[], flat: unknown, plan: unknown) => Analysis;

export const MIN_COMPARE = 10;
// Designs under SMALL_GROUP_MIN are hidden in what's shared (Word and PDF): the
// person writing the readout sees them, its readers don't. See disclosure-rules.ts.
export { SMALL_GROUP_MIN };
export const isSmallGroup = (design: Pick<DesignResult, "assigned">) => design.assigned < SMALL_GROUP_MIN;
export const HIDDEN_TEXT = `Not shown: fewer than ${SMALL_GROUP_MIN} people`;
/** Whether a design is hidden in what's shared: it's under the small-group minimum in any activity. */
export const hiddenDesign = (results: Pick<ReadoutResults, "activities">) => (designId: string) => results.activities.some(a => a.designs.some(d => d.id === designId && isSmallGroup(d)));
const letter = (i: number) => String.fromCharCode(65 + i);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** A Research Studio study file (working copy or published study), or what's wrong with it. */
export function readStudyFile(text: string): { study: ReadoutStudy } | { problem: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { problem: "This isn't a study file. Choose the study's JSON file from Civic Research Studio, or a working draft saved here." }; }
  const study = isObject(parsed) && isObject(parsed.study) ? parsed.study : parsed;
  if (!isObject(study) || !Array.isArray(study.tasks) || typeof study.id !== "string") {
    return { problem: "This file doesn't have a study's activities. Choose the study's JSON file from Civic Research Studio, or a working draft saved here." };
  }
  const abActivities = (study.tasks as unknown[]).filter(isObject).filter(task => task.method === "ab_test" && typeof task.id === "string" && Array.isArray(task.variants))
    .map(task => ({ id: String(task.id), title: String(task.title || task.id), designs: (task.variants as unknown[]).filter(isObject).map(v => String(v.label || v.id)) }));
  if (!abActivities.length) return { problem: "This study has no A/B activities. Readouts cover A/B studies for now." };
  return { study: { id: study.id, title: String(study.title || study.id), abActivities, source: study } };
}

const rate = (r: unknown): Rate | null => isObject(r) && typeof r.p === "number" ? { p: r.p, lo: Number(r.lo), hi: Number(r.hi), k: Number(r.k), n: Number(r.n) } : null;
const diff = (r: unknown): Difference | null => isObject(r) && typeof r.d === "number" ? { d: r.d, lo: typeof r.lo === "number" ? r.lo : null, hi: typeof r.hi === "number" ? r.hi : null } : null;
const medianRange = (r: unknown): MedianRange | null => isObject(r) && typeof r.m === "number" ? { m: r.m, lo: typeof r.lo === "number" ? r.lo : null, hi: typeof r.hi === "number" ? r.hi : null, n: Number(r.n) } : null;

type QualtricsRecord = Record<string, string>;
// Research Studio leaves Qualtrics previews and test responses out of results.
// For a practice run they're read as if they were live, in memory only.
function readAsLive(record: QualtricsRecord) {
  for (const key of Object.keys(record)) {
    const k = key.toLowerCase().replace(/^__js_/, "");
    if (k === "status") record[key] = "IP Address";
    if (k === "distributionchannel") record[key] = "anonymous";
  }
}
export const PRACTICE_NOTE = "Practice run: made from Qualtrics preview and test responses to try the readout. These aren't study results.";
export const PREVIEWS_ONLY = "Every response in this export is a Qualtrics preview or test response, which study results leave out. To try the readout with them, include preview and test responses: the readout is then marked as a practice run, not study results.";

/**
 * Results for each A/B activity from Qualtrics CSV exports (Survey 2, and Survey 1
 * when there is one), computed as Research Studio computes them. Only totals,
 * rates and ranges come back. With includePreviews, Qualtrics preview and test
 * responses count too and the results are marked as a practice run.
 */
export async function readoutResults(study: ReadoutStudy, survey2Text: string, survey1Text = "", { includePreviews = false } = {}):
  Promise<{ results: ReadoutResults; comments: Comment[] } | { problems: string[]; previewsOnly?: boolean }> {
  const survey2 = qualtricsRecords(survey2Text);
  const survey1 = survey1Text.trim() ? qualtricsRecords(survey1Text) : [];
  const kind2 = classifyExport(survey2);
  if (kind2 === "survey1") return { problems: ["That's the intake survey (Survey 1). Choose the follow-up survey's export (Survey 2), which has the rs_ fields, first."] };
  if (kind2 !== "survey2") return { problems: ["This export doesn't have Civic Research Studio's rs_ fields. Export the survey that ran the study as CSV, with the embedded data fields included."] };
  if (survey1.length && classifyExport(survey1) !== "survey1") return { problems: ["The second file isn't the intake survey (Survey 1). It needs ResponseId and Variant columns."] };
  const previews = [...survey2, ...survey1].filter(record => !isLiveResponse(record)) as QualtricsRecord[];
  if (!includePreviews && survey2.length && previews.length && !survey2.some(record => isLiveResponse(record))) return { problems: [PREVIEWS_ONLY], previewsOnly: true };
  const practice = includePreviews && previews.length > 0;
  if (practice) previews.forEach(readAsLive);
  await expandEmbedded(survey2);
  const imported = eventsFromQualtrics(study.source, survey2, survey1);
  if (imported.problems.length) return { problems: imported.problems };
  const flat = flattenEvents(imported.events);
  const plan = isObject(study.source.plan) && (study.source.plan.locked || study.source.plan.edited) ? study.source.plan : null;
  const tasks = (study.source.tasks as Record<string, unknown>[]).filter(task => task.method === "ab_test");
  const activities = tasks.map(task => {
    const analysis = analyzeAB(task, flat.tasks.filter((row: { task_id: string }) => row.task_id === task.id), flat, plan);
    const designs: DesignResult[] = analysis.designs.map(d => ({
      id: d.variant.id, letter: letter(d.index), label: d.variant.label,
      assigned: Number(d.assigned), finished: Number(d.finished), dropped: d.dropped == null ? null : Number(d.dropped),
      measured: Number(d.measured), successes: Number(d.successes), selfDone: Number(d.selfDone),
      primary: rate(d.primary), measuredRate: rate(d.measuredRate), self: rate(d.self),
      time: medianRange(d.time), successTime: medianRange(d.successTime),
    }));
    const comparisons: ComparisonResult[] = analysis.comparisons.map(c => ({
      designId: c.design.variant.id, letter: letter(c.design.index), enough: !!c.enough,
      primary: diff(c.primary), measured: diff(c.measured), self: diff(c.self), time: diff(c.time),
    }));
    return {
      id: String(task.id), title: String(task.title || task.id), hasSignal: !!analysis.hasSignal, dropoutUnknown: !!analysis.dropoutUnknown,
      confidence: Number(analysis.conf), minAssigned: Number(analysis.minAssigned), designs, comparisons,
      checks: analysis.checks.map(({ level, title, text }) => ({ level, title, text })),
      hypotheses: analysis.hypotheses.map(({ n, sentence, status, text, value, secondary }) => ({ n, sentence, status, text, value: value ?? "", secondary: !!secondary })),
    };
  });
  const answers = await summarizeAnswers(study.source, activities.map(a => ({ id: a.id, designs: a.designs.map(({ id, letter, label }) => ({ id, letter, label })) })), flat as unknown as Flat);
  return { results: {
    studyId: study.id, studyTitle: study.title,
    responses: Number(imported.summary.responses), dropouts: Number(imported.summary.dropouts), survey1Provided: !!imported.summary.survey1Provided,
    ...(practice ? { practice: true } : {}),
    warnings: imported.warnings, activities,
    questions: answers.questions, commentQuestions: answers.commentQuestions,
  }, comments: answers.comments };
}

// ---------- wording ----------

export const percent = (p: number) => `${Math.round(p * 100)}%`;
/** Signed percentage points, one decimal under 1 point so a limit just above zero never reads "+0". */
export function points(d: number) {
  const v = d * 100, a = Math.abs(v), sign = v > 0 ? "+" : v < 0 ? "−" : "±";
  return `${sign}${a > 0 && a < 1 ? a.toFixed(1) : Math.round(a)}`;
}
export const confidenceText = (c: number) => c === 0.95 ? "95%" : `${(c * 100).toFixed(1).replace(/\.0$/, "")}%`;
export const measureName = (activity: Pick<ActivityResult, "hasSignal">) => activity.hasSignal ? "task success (success signal)" : "self-reported completion";
/** Seconds as "48 s", "2 min" or "2 min 5 s". */
export function formatSeconds(seconds: number) {
  const t = Math.max(0, Math.round(seconds));
  if (t < 60) return `${t} s`;
  const m = Math.floor(t / 60), r = t % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}
/** A median time with its 95% range, or why there's no range. */
export function timeText(time: MedianRange | null) {
  if (!time) return "—";
  return time.lo == null || time.hi == null ? `${formatSeconds(time.m)} (too few for a range)` : `${formatSeconds(time.m)} (${formatSeconds(time.lo)} to ${formatSeconds(time.hi)})`;
}
const excludesZero = (r: Difference | null) => !!r && r.lo != null && r.hi != null && (r.lo > 0 || r.hi < 0);

/** One cautious sentence per comparison with the first design, for the researcher to edit. No winner is named. */
export function draftFindings(activity: ActivityResult, results?: Pick<ReadoutResults, "activities" | "questions">): string[] {
  const base = activity.designs[0];
  const lines: string[] = [];
  for (const design of activity.designs) {
    if (isSmallGroup(design)) { lines.push(`Design ${design.letter} (${design.label}): fewer than ${SMALL_GROUP_MIN} people were assigned, so its results aren't shown in the shared readout.`); continue; }
    if (!design.primary) continue;
    lines.push(`Design ${design.letter} (${design.label}): ${percent(design.primary.p)} ${activity.hasSignal ? "succeeded" : "said they completed the task"} (${design.primary.k} of ${design.primary.n} assigned; 95% range ${percent(design.primary.lo)} to ${percent(design.primary.hi)}).`);
  }
  for (const c of activity.comparisons) {
    const design = activity.designs.find(d => d.id === c.designId)!;
    if (!c.enough) { lines.push(`Design ${c.letter} compared with A: too early to compare (fewer than ${MIN_COMPARE} people in a design).`); continue; }
    if (!c.primary || c.primary.lo == null || c.primary.hi == null) { lines.push(`Design ${c.letter} compared with A: too few results to compare.`); continue; }
    const range = `${confidenceText(activity.confidence)} range ${points(c.primary.lo)} to ${points(c.primary.hi)} points`;
    lines.push(excludesZero(c.primary)
      ? `Design ${c.letter} (${design.label}) differed from A (${base.label}) by ${points(c.primary.d)} points in ${measureName(activity)} (${range}). A gap this large would be unusual if the designs performed the same.`
      : `The difference between Design ${c.letter} (${design.label}) and A (${base.label}) was ${points(c.primary.d)} points (${range}). The range includes zero, so these results can't tell the designs apart; that isn't evidence that they perform the same.`);
  }
  if (results?.questions) lines.push(...ratingLines(results.questions, activity.id, hiddenDesign(results), HIDDEN_TEXT));
  return lines;
}

/** What the readout should say about limits, from the data checks and import warnings. */
export function draftLimitations(results: ReadoutResults): string[] {
  // Research Studio's instructions to use its own tools aren't limits of the results.
  const tidy = (text: string) => text.replace(/\s*Use Check designs[^.]*\./g, "").trim();
  const lines = results.activities.flatMap(a => a.checks.filter(c => c.level !== "ok").map(c => `${a.title}, ${c.title.toLowerCase()}: ${tidy(c.text)}`));
  lines.push(...results.warnings);
  if (results.practice) lines.unshift(PRACTICE_NOTE);
  lines.push("These are descriptive results from one study. How much a difference matters is the team's judgement.");
  return lines;
}

// ---------- the readout ----------

/** The sections drafted from the results, which can fall out of date when the results change. */
export const DRAFTED_FIELDS = ["title", "background", "findings", "limitations"] as const;
export type Drafted = Pick<Readout, typeof DRAFTED_FIELDS[number]>;
export type StaleField = Exclude<typeof DRAFTED_FIELDS[number], "title">;
const STALE_NAMES: Record<StaleField, string> = { background: "what you tested and why", findings: "the findings", limitations: "the limits" };
const listOf = (items: string[]) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
export const draftedPart = (readout: Readout): Drafted => ({ title: readout.title, background: readout.background, findings: readout.findings, limitations: readout.limitations });

/**
 * New results for a readout in progress. Sections still as they were drafted
 * follow the new results; sections the researcher edited are kept and, when the
 * results changed, listed as stale so the readout can't be shared with old
 * numbers by mistake. The summary and next steps are always kept.
 */
export function updateReadout(current: Readout, drafted: Drafted | null, fresh: Readout, { resultsChanged, stale = [] }: { resultsChanged: boolean; stale?: readonly StaleField[] }):
  { readout: Readout; drafted: Drafted; stale: StaleField[] } {
  const readout = { ...current };
  const nextStale = new Set(stale);
  for (const field of DRAFTED_FIELDS) {
    const unedited = !!drafted && current[field] === drafted[field];
    if (unedited || !current[field].trim()) {
      readout[field] = fresh[field];
      if (field !== "title") nextStale.delete(field);
    } else if (resultsChanged && field !== "title") nextStale.add(field);
  }
  return { readout, drafted: draftedPart(fresh), stale: DRAFTED_FIELDS.filter((f): f is StaleField => f !== "title" && nextStale.has(f)) };
}

export type Readout = {
  title: string;
  summary: string;
  background: string;
  findings: string;
  limitations: string;
  nextSteps: string;
};
export const READOUT_SECTIONS: readonly { id: keyof Omit<Readout, "title">; label: string; required: boolean; hint: string }[] = [
  { id: "summary", label: "Summary", required: true, hint: "Two or three sentences: what you tested, what you found and what it means for the decision." },
  { id: "background", label: "What we tested and why", required: false, hint: "The decision, the research question, the designs and who took part." },
  { id: "findings", label: "Findings", required: true, hint: "Drafted from the results. Edit them into your own words; keep the numbers and ranges." },
  { id: "limitations", label: "Limits of these results", required: true, hint: "Drafted from the data checks." },
  { id: "nextSteps", label: "Next steps", required: false, hint: "What the team will do, and what research would increase confidence." },
];

/** A first draft from the study and its results; every section is the researcher's to edit. */
export function draftReadout(study: ReadoutStudy, results: ReadoutResults): Readout {
  const plan = isObject(study.source.plan) ? study.source.plan : {};
  const questions = Array.isArray(plan.researchQuestions) ? plan.researchQuestions.filter(q => typeof q === "string" && q.trim()) as string[] : [];
  const decision = typeof plan.decisions === "string" ? plan.decisions.trim() : "";
  const background = [
    decision ? `Decision: ${decision}` : "",
    questions.length ? `Research question${questions.length > 1 ? "s" : ""}: ${questions.join(" ")}` : "",
    ...results.activities.map(a => `${a.title}: ${a.designs.map(d => `Design ${d.letter}, ${d.label}`).join("; ")}.`),
    `${results.responses} people took part${results.survey1Provided ? `, and ${results.dropouts} more were assigned a design but didn't finish` : ""}.`,
  ].filter(Boolean).join("\n");
  return {
    title: `${results.practice ? "Practice readout" : "Readout"}: ${study.title}`.slice(0, 120),
    summary: "",
    background,
    findings: [
      ...results.activities.map(a => [`${a.title} (main measure: ${measureName(a)}, counting everyone assigned)`, ...draftFindings(a, results).map(line => `- ${line}`)].join("\n")),
      ...(() => {
        const general = [...ratingLines(results.questions ?? [], null, hiddenDesign(results), HIDDEN_TEXT)];
        return general.length ? [["Before and after the tasks", ...general.map(line => `- ${line}`)].join("\n")] : [];
      })(),
    ].join("\n\n"),
    limitations: draftLimitations(results).map(line => `- ${line}`).join("\n"),
    nextSteps: "",
  };
}

// Details about a person that a readout must never carry. Matching is
// deliberately broad: a false alarm costs a moment, a missed one doesn't.
const SENSITIVE: readonly [RegExp, string][] = [
  [/\b\d{3}-\d{2}-\d{4}\b|\b\d{9}\b/, "a Social Security or taxpayer ID number"],
  [/\b\d{2}-\d{7}\b/, "an employer ID number"],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/, "an email address"],
  [/(?:\+?1[-. ]?)?(?:\(\d{3}\)\s?|\b\d{3}[-. ])\d{3}[-. ]\d{4}\b/, "a phone number"],
  [/\bR_[A-Za-z0-9]{10,}\b/, "a Qualtrics response ID"],
];
/** What a piece of text looks like it has that a readout must not carry ("a phone number"), or null. */
export const looksSensitive = (text: string) => SENSITIVE.find(([pattern]) => pattern.test(text))?.[1] ?? null;
const OVERCLAIM = /\b(validated?|validates|proven|proves|approved|winner|wins|won|significant(?:ly)?|outperform(?:s|ed|ing)?|superior|definitely|guarantees?)\b/i;
/** What to fix before the readout is shared, in plain language, or [] when it's ready. */
export function readoutProblems(readout: Readout, results: ReadoutResults, coding: Coding = EMPTY_CODING, stale: readonly StaleField[] = []): string[] {
  const problems: string[] = [];
  if (stale.length) problems.push(`The results changed after you edited ${listOf(stale.map(f => STALE_NAMES[f]))}. Redraft from the results, or check every number against the results and choose Numbers checked.`);
  if (!readout.title.trim()) problems.push("Add a title.");
  for (const section of READOUT_SECTIONS) if (section.required && !readout[section.id].trim()) problems.push(`Write the ${section.label.toLowerCase()}.`);
  const words = [readout.title, ...READOUT_SECTIONS.map(s => readout[s.id])].join("\n").match(OVERCLAIM);
  if (words) problems.push(`Reword “${words[0]}”: the results describe one study, they don't validate, prove or approve a design, or name a winner.`);
  for (const field of ["title", ...READOUT_SECTIONS.map(s => s.id)] as (keyof Readout)[]) {
    const found = SENSITIVE.find(([pattern]) => pattern.test(readout[field]));
    const where = field === "title" ? "title" : READOUT_SECTIONS.find(s => s.id === field)!.label.toLowerCase();
    if (found) problems.push(`Remove what looks like ${found[1]} from the ${where}. A readout shares totals, never details about a person.`);
  }
  if (/["“”]/.test(readout.findings + readout.summary)) problems.push("Put participants' words in the quotes from What people said, where each one is reviewed, rather than in quotation marks in the summary or findings.");
  const usedThemes = coding.themes.filter(t => coding.counts.some(c => c.themeId === t.id));
  for (const t of usedThemes) {
    const found = SENSITIVE.find(([pattern]) => pattern.test(t.name));
    if (found) problems.push(`Reword the theme “${t.name.slice(0, 40)}”: it looks like it has ${found[1]}.`);
  }
  coding.quotes.forEach((q, i) => {
    const found = SENSITIVE.find(([pattern]) => pattern.test(q.text));
    if (found) problems.push(`Edit or remove quote ${i + 1}: it looks like it has ${found[1]}.`);
  });
  if (results.activities.some(a => a.comparisons.some(c => !c.enough)) && !/too early|fewer than/i.test(readout.findings + readout.limitations)) {
    problems.push(`Say that some comparisons are too early to read (fewer than ${MIN_COMPARE} people in a design).`);
  }
  return problems;
}

/** One activity's results tables, as both the Word and PDF readouts lay them out. Designs below SMALL_GROUP_MIN are hidden here. */
export function resultTables(a: ActivityResult): ResultTable[] {
  const hidden = HIDDEN_TEXT;
  const tables: ResultTable[] = [{
    caption: `${a.title}: each design's results`,
    widths: [0.3, 0.12, 0.12, 0.24, 0.22],
    header: ["Design", "Assigned", "Finished", a.hasSignal ? "Task success (95% range)" : "Said they completed it (95% range)", "Median active time (95% range)"],
    rows: a.designs.map(d => isSmallGroup(d)
      ? [`${d.letter} · ${d.label}`, `Fewer than ${SMALL_GROUP_MIN}`, "—", hidden, "—"]
      : [`${d.letter} · ${d.label}`, String(d.assigned), String(d.finished), d.primary ? `${percent(d.primary.p)} (${percent(d.primary.lo)} to ${percent(d.primary.hi)})` : "—", timeText(d.time)]),
  }];
  if (a.comparisons.length) tables.push({
    caption: `${a.title}: compared with Design A`,
    widths: [0.3, 0.7],
    header: ["Compared with A", `Difference in points (${confidenceText(a.confidence)} range)`],
    rows: a.comparisons.map(c => [`Design ${c.letter}`, !c.enough ? `Too early to compare (fewer than ${MIN_COMPARE} in a design)` : c.primary && c.primary.lo != null && c.primary.hi != null ? `${points(c.primary.d)} (${points(c.primary.lo)} to ${points(c.primary.hi)})` : "Too few results"]),
  });
  if (a.hypotheses.length) tables.push({
    caption: `${a.title}: planned hypotheses`,
    widths: [0.55, 0.45],
    header: ["Planned hypothesis", "What the results show"],
    rows: a.hypotheses.map(h => [h.sentence, `${h.text}${h.value ? ` ${h.value}` : ""}`]),
  });
  return tables;
}
const measureNote = (a: ActivityResult) => `Main measure: ${measureName(a)}, out of everyone assigned to a design. Ranges are 95% confidence intervals${a.confidence !== 0.95 ? `; differences use ${confidenceText(a.confidence)} ranges because several designs are compared with A` : ""}. Median active time is a secondary measure, for people who finished.`;
const preparedNote = (results: ReadoutResults, date: Date) => `${results.practice ? `${PRACTICE_NOTE} ` : ""}Civic Research Studio results for “${results.studyTitle}”, imported from Qualtrics. ${results.responses} responses. Prepared ${date.toLocaleDateString("en-US", { dateStyle: "medium" })}.`;
const paragraphs = (text: string) => text.split(/\n/).filter(line => line.trim()).map(line => /^\s*[-•]\s+/.test(line) ? { bullet: true, text: line.replace(/^\s*[-•]\s+/, "") } : { bullet: false, text: line });

// What both the Word and PDF readouts lay out, in order.
type DocBlock =
  | { type: "title" | "note" | "h1" | "h2" | "h3" | "p" | "bullet"; text: string }
  | { type: "table"; table: ResultTable }
  | { type: "chart"; activity: ActivityResult };
type ShareOptions = { author?: string; date?: Date; coding?: Coding };

function readoutBlocks(readout: Readout, results: ReadoutResults, { date = new Date(), coding = EMPTY_CODING }: ShareOptions): DocBlock[] {
  const hidden = hiddenDesign(results);
  const blocks: DocBlock[] = [{ type: "title", text: readout.title.trim() || "Study readout" }, { type: "note", text: preparedNote(results, date) }];
  for (const s of READOUT_SECTIONS) {
    if (!readout[s.id].trim()) continue;
    blocks.push({ type: "h1", text: s.label });
    for (const line of paragraphs(readout[s.id])) blocks.push({ type: line.bullet ? "bullet" : "p", text: line.text });
  }
  const questions = results.questions ?? [];
  blocks.push({ type: "h1", text: "Results" });
  for (const a of results.activities) {
    blocks.push({ type: "h2", text: a.title }, { type: "p", text: measureNote(a) }, { type: "chart", activity: a });
    for (const table of [...resultTables(a), ...questionTables(questions, a.id, hidden, HIDDEN_TEXT)]) blocks.push({ type: "table", table });
  }
  const general = questionTables(questions, null, hidden, HIDDEN_TEXT);
  if (general.length) {
    blocks.push({ type: "h2", text: "Before and after the tasks" });
    for (const table of general) blocks.push({ type: "table", table });
  }
  const taskTitle = (taskId: string | null) => results.activities.find(a => a.id === taskId)?.title ?? "After the tasks";
  const said = commentSections(results.commentQuestions ?? [], coding, hidden, HIDDEN_TEXT, taskTitle);
  if (said.length) {
    blocks.push({ type: "h1", text: "What people said" }, { type: "p", text: `Themes are the researcher's, from reading each comment. Counts under ${SMALL_THEME_MIN} aren't shown. Quotes were reviewed for identifying details before they were added.` });
    for (const section of said) {
      blocks.push({ type: "h2", text: section.heading });
      if (section.table) blocks.push({ type: "table", table: section.table });
      for (const quote of section.quotes) blocks.push({ type: "bullet", text: quote });
    }
  }
  return blocks;
}

/** The readout as a Word document: the text, then each activity's results as tables, which carry the charts' numbers. */
export function readoutDocx(readout: Readout, results: ReadoutResults, options: ShareOptions = {}): Uint8Array {
  const out: WordBlock[] = [];
  for (const b of readoutBlocks(readout, results, options)) {
    if (b.type === "chart") continue;
    if (b.type === "table") { out.push({ type: "p", text: [{ text: b.table.caption, bold: true }] }, { type: "table", widths: b.table.widths, rows: [b.table.header, ...b.table.rows] }); continue; }
    out.push({ type: b.type === "h3" ? "h2" : b.type, text: b.text });
  }
  return buildWordDocument(out, { title: readout.title.trim(), author: options.author ?? "" }, options.date ?? new Date());
}

const esc = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A dot-and-range chart of each shown design's main measure, for the PDF. Its words repeat the table below it. */
function ratesSvg(a: ActivityResult) {
  const shown = a.designs.filter(d => !isSmallGroup(d) && d.primary);
  if (!shown.length) return "";
  const short = (text: string, n: number) => text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text;
  const w = 560, left = 190, right = 16, row = 30, top = 8, h = top + shown.length * row + 22;
  const x = (v: number) => left + Math.min(1, Math.max(0, v)) * (w - left - right);
  const what = a.hasSignal ? "Task success" : "Said they completed the task";
  const label = `${what}, everyone assigned, with 95% ranges: ${shown.map(d => `Design ${d.letter}, ${percent(d.primary!.p)} (${percent(d.primary!.lo)} to ${percent(d.primary!.hi)})`).join("; ")}.`;
  const rows = shown.map((d, i) => {
    const y = top + i * row + row / 2, r = d.primary!;
    return `<text x="0" y="${y + 4}" font-size="12">${esc(short(`${d.letter} · ${d.label}`, 26))}</text><line x1="${x(0)}" x2="${x(1)}" y1="${y}" y2="${y}" stroke="#d0d5dd" stroke-width="2"/><line x1="${x(r.lo)}" x2="${x(r.hi)}" y1="${y}" y2="${y}" stroke="#1a3d6d" stroke-width="2"/><line x1="${x(r.lo)}" x2="${x(r.lo)}" y1="${y - 6}" y2="${y + 6}" stroke="#1a3d6d" stroke-width="2"/><line x1="${x(r.hi)}" x2="${x(r.hi)}" y1="${y - 6}" y2="${y + 6}" stroke="#1a3d6d" stroke-width="2"/><circle cx="${x(r.p)}" cy="${y}" r="6" fill="#1f5fae"/>`;
  }).join("");
  const axisY = top + shown.length * row + 14;
  const axis = [0, 0.5, 1].map(v => `<text x="${x(v)}" y="${axisY}" font-size="11" fill="#555" text-anchor="${v === 0 ? "start" : v === 1 ? "end" : "middle"}">${percent(v)}</text>`).join("");
  // The caption says what the marks show, so screen readers read it once rather than twice.
  return `<figure><svg aria-hidden="true" focusable="false" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="inherit">${rows}${axis}</svg><figcaption>${esc(label)}</figcaption></figure>`;
}

/**
 * The readout as a standalone, printable web page: headings, the text, a chart
 * per activity with a text description, and the results tables. Printing it
 * (or saving it as a PDF) is how the PDF is made.
 */
export function readoutHtml(readout: Readout, results: ReadoutResults, options: ShareOptions = {}): string {
  const title = readout.title.trim() || "Study readout";
  const body: string[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) body.push(`<ul>${list.map(item => `<li>${esc(item)}</li>`).join("")}</ul>`); list = []; };
  for (const b of readoutBlocks(readout, results, options)) {
    if (b.type === "bullet") { list.push(b.text); continue; }
    flush();
    if (b.type === "title") body.push(`<h1>${esc(b.text)}</h1>`);
    else if (b.type === "note") body.push(`<p class="note">${esc(b.text)}${options.author ? ` ${esc(`Written by ${options.author}.`)}` : ""}</p>`);
    else if (b.type === "h1") body.push(`<h2>${esc(b.text)}</h2>`);
    else if (b.type === "h2") body.push(`<h3>${esc(b.text)}</h3>`);
    else if (b.type === "h3") body.push(`<h4>${esc(b.text)}</h4>`);
    else if (b.type === "p") body.push(`<p>${esc(b.text)}</p>`);
    else if (b.type === "chart") body.push(ratesSvg(b.activity));
    else if (b.type === "table") {
      const t = b.table;
      body.push(`<table><caption>${esc(t.caption)}</caption><thead><tr>${t.header.map(h => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${t.rows.map(r => `<tr>${r.map((cell, i) => i === 0 ? `<th scope="row">${esc(cell)}</th>` : `<td>${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    }
  }
  flush();
  const style = "body{font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1b1b1b;line-height:1.45;margin:0;padding:24px}main{max-width:720px;margin:0 auto}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:24px 0 6px}h3{font-size:15px;margin:18px 0 6px}p,li{font-size:13px}.note,figcaption{color:#555;font-size:12px}figure{margin:12px 0}svg{max-width:100%;height:auto}table{border-collapse:collapse;width:100%;margin:10px 0 14px;font-size:12px;page-break-inside:avoid}caption{text-align:left;font-weight:600;padding:0 0 4px}th,td{border:1px solid #c6cbd1;padding:5px 7px;text-align:left;vertical-align:top}thead th{background:#eef2f7}@page{margin:18mm}";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${style}</style></head><body><main>${body.join("")}</main></body></html>`;
}

export function readoutFileName(title: string, extension = "docx") {
  const slug = title.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 60).replace(/-+$/, "");
  return `${slug || "study-readout"}.${extension}`;
}

// ---------- saved on this device ----------

/** What a readout keeps on this device between visits: the study, totals and the text. Never the exports. */
export type ReadoutDraft = {
  version: 1;
  studyName: string;
  study: Record<string, unknown>;
  files: { survey2: string; survey1: string | null };
  results: ReadoutResults;
  readout: Readout;
  /** Themes, codes (by comment fingerprint), counts and reviewed quotes. Never the comments. */
  coding?: Coding;
  /** The drafted sections as last drafted, to tell the researcher's edits from the draft. */
  drafted?: Drafted;
  /** Edited sections written against earlier results. */
  stale?: StaleField[];
};
const TEXT = 50_000;
/** A saved readout, checked before it's put back, or null. */
export function parseReadoutDraft(value: unknown): ReadoutDraft | null {
  if (!isObject(value) || value.version !== 1 || !isObject(value.study) || !isObject(value.results) || !isObject(value.readout) || !isObject(value.files)) return null;
  const read = readStudyFile(JSON.stringify(value.study));
  if (!("study" in read)) return null;
  const r = value.results;
  if (!Array.isArray(r.activities) || !Array.isArray(r.warnings) || typeof r.responses !== "number") return null;
  const text = (v: unknown) => typeof v === "string" ? v.slice(0, TEXT) : "";
  const readout: Readout = { title: text(value.readout.title), summary: text(value.readout.summary), background: text(value.readout.background), findings: text(value.readout.findings), limitations: text(value.readout.limitations), nextSteps: text(value.readout.nextSteps) };
  return {
    version: 1, studyName: text(value.studyName), study: value.study,
    files: { survey2: text(value.files.survey2), survey1: typeof value.files.survey1 === "string" ? text(value.files.survey1) : null },
    results: r as ReadoutResults, readout,
    coding: parseCoding(value.coding),
    ...(isObject(value.drafted) ? { drafted: { title: text(value.drafted.title), background: text(value.drafted.background), findings: text(value.drafted.findings), limitations: text(value.drafted.limitations) } } : {}),
    stale: Array.isArray(value.stale) ? DRAFTED_FIELDS.filter((f): f is StaleField => f !== "title" && (value.stale as unknown[]).includes(f)) : [],
  };
}
