// A study readout's answers to the study's own questions: ratings and choices as
// totals per design, and written comments for the researcher to code into
// themes and, after review, quote.
//
// Comments are read on this device while the readout is open and never saved.
// What's kept is the researcher's own work: theme names, which themes each
// comment was given (keyed by a fingerprint of the comment, not its words, so
// the codes come back when the export is chosen again), theme counts, and the
// quotes the researcher reviewed and approved.
import { SMALL_THEME_MIN } from "./disclosure-rules.ts";
import { sha256Hex } from "./research-studio-vendor/qualtrics-embed.js";

export type ResultTable = { caption: string; header: string[]; rows: string[][]; widths: number[] };

/** A design as the answers are grouped by. */
export type DesignRef = { id: string; letter: string; label: string };
type Question = { id: string; type: string; text?: string; options?: unknown[]; lowLabel?: string; highLabel?: string };
type AnswerRow = { session_id: string; task_id: string; stage: string; question_id: string; response: unknown; variant_id?: string | null };
type StartRow = { session_id: string; variant_id: string | null };
export type Flat = { answers: AnswerRow[]; starts: StartRow[] };

export type QuestionDesign = DesignRef & { n: number; counts: number[]; median: number | null };
export type QuestionSummary = {
  kind: "scale" | "choice";
  questionId: string;
  text: string;
  /** The A/B activity it was asked after, or null for questions before or after all of them. */
  taskId: string | null;
  stage: "pre" | "post_task" | "post";
  /** "1"…"5" or "1"…"7" for a scale; the options for a choice. */
  choices: string[];
  lowLabel: string;
  highLabel: string;
  multiple: boolean;
  designs: QuestionDesign[];
};
export type CommentQuestion = {
  questionId: string;
  text: string;
  taskId: string | null;
  stage: "pre" | "post_task" | "post";
  designs: (DesignRef & { n: number })[];
};
/** One written comment, in memory only. */
export type Comment = { key: string; questionId: string; designId: string; text: string };

export type Theme = { id: string; name: string };
export type ThemeCount = { themeId: string; questionId: string; designId: string; n: number };
export type Quote = { key: string; questionId: string; designId: string; text: string };
export type Coding = {
  themes: Theme[];
  /** Theme ids for each coded comment, by the comment's fingerprint. */
  codes: Record<string, string[]>;
  /** Counts as of the last coding, kept for when the comments aren't loaded. */
  counts: ThemeCount[];
  quotes: Quote[];
};
export const EMPTY_CODING: Coding = { themes: [], codes: {}, counts: [], quotes: [] };

// Theme counts under SMALL_THEME_MIN show as "Fewer than N" in what's shared. See disclosure-rules.ts.
export { SMALL_THEME_MIN };
export const COMMENT_CHARS = 5000;

const median = (values: number[]) => {
  const v = values.slice().sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};
const textOf = (response: unknown) => (Array.isArray(response) ? response.join("|") : String(response ?? "")).trim();

/** A comment's fingerprint: the same words for the same question and design always get the same one. */
export async function commentKey(questionId: string, designId: string, text: string) {
  return (await sha256Hex(`${questionId}\u0000${designId}\u0000${text.trim()}`)).slice(0, 24);
}

/**
 * Totals for each rating and choice question, the number of comments per design,
 * and the comments themselves (to be kept in memory only). Answers are grouped by
 * the design the person saw: for an activity's questions, that activity's
 * design; before or after the activities, the one design they saw throughout.
 */
export async function summarizeAnswers(source: Record<string, unknown>, activities: { id: string; designs: DesignRef[] }[], flat: Flat):
  Promise<{ questions: QuestionSummary[]; commentQuestions: CommentQuestion[]; comments: Comment[] }> {
  const questions: QuestionSummary[] = [], commentQuestions: CommentQuestion[] = [], comments: Comment[] = [];
  if (!activities.length) return { questions, commentQuestions, comments };
  const seen = new Map<string, Set<string>>();
  for (const start of flat.starts) if (start.variant_id) seen.set(start.session_id, (seen.get(start.session_id) ?? new Set()).add(start.variant_id));
  const sessionDesign = (session: string) => { const s = seen.get(session); return s && s.size === 1 ? [...s][0] : null; };
  const list = (value: unknown) => Array.isArray(value) ? value.filter((q): q is Question => !!q && typeof q === "object" && typeof (q as Question).id === "string") : [];
  const asked: { q: Question; stage: QuestionSummary["stage"]; taskId: string | null; designs: DesignRef[] }[] = [
    ...list(source.preQuestions).map(q => ({ q, stage: "pre" as const, taskId: null, designs: activities[0].designs })),
    ...activities.flatMap(a => {
      const task = list(source.tasks).find(t => t.id === a.id) as (Question & { questions?: unknown }) | undefined;
      return list(task?.questions).map(q => ({ q, stage: "post_task" as const, taskId: a.id, designs: a.designs }));
    }),
    ...list(source.postQuestions).map(q => ({ q, stage: "post" as const, taskId: null, designs: activities[0].designs })),
  ];
  for (const { q, stage, taskId, designs } of asked) {
    // The latest answer from each person.
    const latest = new Map<string, { design: string; response: unknown }>();
    for (const row of flat.answers) {
      if (row.question_id !== q.id || row.stage !== stage || (taskId !== null && row.task_id !== taskId)) continue;
      const design = (stage === "post_task" ? row.variant_id : null) || sessionDesign(row.session_id);
      if (design) latest.set(row.session_id, { design, response: row.response });
    }
    const answers = [...latest.values()];
    const text = String(q.text || q.id);
    if (q.type === "scale5" || q.type === "scale7") {
      const points = q.type === "scale7" ? 7 : 5;
      const choices = Array.from({ length: points }, (_, i) => String(i + 1));
      questions.push({ kind: "scale", questionId: q.id, text, taskId, stage, choices, lowLabel: String(q.lowLabel || ""), highLabel: String(q.highLabel || ""), multiple: false,
        designs: designs.map(d => {
          const values = answers.filter(x => x.design === d.id).map(x => Number(textOf(x.response))).filter(v => Number.isInteger(v) && v >= 1 && v <= points);
          return { ...d, n: values.length, counts: choices.map((_, i) => values.filter(v => v === i + 1).length), median: median(values) };
        }) });
    } else if (q.type === "single" || q.type === "multi") {
      const choices = (q.options ?? []).map(String);
      questions.push({ kind: "choice", questionId: q.id, text, taskId, stage, choices, lowLabel: "", highLabel: "", multiple: q.type === "multi",
        designs: designs.map(d => {
          const picked = answers.filter(x => x.design === d.id).map(x => Array.isArray(x.response) ? x.response.map(String) : textOf(x.response).split("|").filter(Boolean));
          const counted = picked.filter(p => p.length);
          return { ...d, n: counted.length, counts: choices.map(c => counted.filter(p => p.includes(c)).length), median: null };
        }) });
    } else if (q.type === "text" || q.type === "textarea") {
      const written = answers.map(x => ({ design: x.design, text: textOf(x.response).slice(0, COMMENT_CHARS) })).filter(x => x.text && designs.some(d => d.id === x.design));
      for (const c of written) comments.push({ key: await commentKey(q.id, c.design, c.text), questionId: q.id, designId: c.design, text: c.text });
      commentQuestions.push({ questionId: q.id, text, taskId, stage, designs: designs.map(d => ({ ...d, n: written.filter(x => x.design === d.id).length })) });
    }
  }
  return { questions, commentQuestions, comments };
}

// ---------- coding ----------

/** Theme counts from the comments' codes: how many comments for each question and design were given each theme. */
export function themeCounts(coding: Coding, comments: Comment[]): ThemeCount[] {
  const counts = new Map<string, ThemeCount>();
  for (const c of comments) for (const themeId of coding.codes[c.key] ?? []) {
    if (!coding.themes.some(t => t.id === themeId)) continue;
    const id = `${themeId}|${c.questionId}|${c.designId}`;
    const current = counts.get(id) ?? { themeId, questionId: c.questionId, designId: c.designId, n: 0 };
    current.n++;
    counts.set(id, current);
  }
  return [...counts.values()];
}

/** A saved coding, checked before it's put back. */
export function parseCoding(value: unknown): Coding {
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!obj(value)) return EMPTY_CODING;
  const str = (v: unknown, max = 200) => typeof v === "string" ? v.slice(0, max) : "";
  const themes = (Array.isArray(value.themes) ? value.themes : []).filter(obj).map(t => ({ id: str(t.id, 40), name: str(t.name, 80) })).filter(t => t.id && t.name).slice(0, 200);
  const ids = new Set(themes.map(t => t.id));
  const codes: Record<string, string[]> = {};
  if (obj(value.codes)) for (const [key, list] of Object.entries(value.codes).slice(0, 20_000)) {
    if (!/^[0-9a-f]{24}$/.test(key) || !Array.isArray(list)) continue;
    const kept = list.filter((id): id is string => typeof id === "string" && ids.has(id));
    if (kept.length) codes[key] = kept;
  }
  const counts = (Array.isArray(value.counts) ? value.counts : []).filter(obj)
    .map(c => ({ themeId: str(c.themeId, 40), questionId: str(c.questionId), designId: str(c.designId), n: Number(c.n) }))
    .filter(c => ids.has(c.themeId) && c.questionId && c.designId && Number.isInteger(c.n) && c.n > 0);
  const quotes = (Array.isArray(value.quotes) ? value.quotes : []).filter(obj)
    .map(q => ({ key: str(q.key, 24), questionId: str(q.questionId), designId: str(q.designId), text: str(q.text, 1000) }))
    .filter(q => q.key && q.questionId && q.designId && q.text.trim()).slice(0, 100);
  return { themes, codes, counts, quotes };
}

// ---------- what's shared ----------

const designName = (d: DesignRef) => `${d.letter} · ${d.label}`;
const scaleKey = (q: QuestionSummary) => q.lowLabel || q.highLabel ? `1 = ${q.lowLabel || "lowest"}, ${q.choices.length} = ${q.highLabel || "highest"}` : `1 to ${q.choices.length}`;
const formatMedian = (m: number | null) => m == null ? "—" : Number.isInteger(m) ? String(m) : m.toFixed(1);
const smallCount = (n: number) => n > 0 && n < SMALL_THEME_MIN ? `Fewer than ${SMALL_THEME_MIN}` : String(n);

/** Tables for the rating and choice questions asked after one activity (taskId), or before or after all of them (null). */
export function questionTables(questions: QuestionSummary[], taskId: string | null, hidden: (designId: string) => boolean, hiddenText: string): ResultTable[] {
  return questions.filter(q => q.taskId === taskId && q.designs.some(d => d.n)).map(q => q.kind === "scale"
    ? {
      caption: `${q.text} (${scaleKey(q)})`, widths: [0.3, 0.12, 0.16, 0.42],
      header: ["Design", "People", "Median rating", `How many gave each rating, 1 to ${q.choices.length}`],
      rows: q.designs.map(d => hidden(d.id) ? [designName(d), "—", hiddenText, "—"]
        : [designName(d), String(d.n), formatMedian(d.median), d.counts.map((n, i) => `${i + 1}: ${n}`).join(" · ")]),
    }
    : {
      caption: `${q.text}${q.multiple ? " (people could choose more than one)" : ""}`, widths: [0.3, 0.12, 0.58],
      header: ["Design", "People", "Answers"],
      rows: q.designs.map(d => hidden(d.id) ? [designName(d), "—", hiddenText]
        : [designName(d), String(d.n), q.choices.map((c, i) => `${c}: ${d.counts[i]}`).join(" · ")]),
    });
}

/** One sentence per rating question for the drafted findings, without quotation marks. */
export function ratingLines(questions: QuestionSummary[], taskId: string | null, hidden: (designId: string) => boolean, hiddenText: string): string[] {
  return questions.filter(q => q.kind === "scale" && q.taskId === taskId && q.designs.some(d => d.n)).map(q =>
    `${q.text.replace(/["“”]/g, "")} (${scaleKey(q)}): ${q.designs.map(d => hidden(d.id) ? `Design ${d.letter}, ${hiddenText.toLowerCase()}` : `Design ${d.letter} median ${formatMedian(d.median)} from ${d.n} ${d.n === 1 ? "person" : "people"}`).join("; ")}.`);
}

/** What people said: for each question with coded comments, a table of theme counts per design, and the approved quotes. */
export function commentSections(commentQuestions: CommentQuestion[], coding: Coding, hidden: (designId: string) => boolean, hiddenText: string, taskTitle: (taskId: string | null) => string):
  { heading: string; table: ResultTable | null; quotes: string[] }[] {
  return commentQuestions.filter(q => q.designs.some(d => d.n)).map(q => {
    const themes = coding.themes.filter(t => coding.counts.some(c => c.themeId === t.id && c.questionId === q.questionId));
    const count = (themeId: string, designId: string) => coding.counts.find(c => c.themeId === themeId && c.questionId === q.questionId && c.designId === designId)?.n ?? 0;
    const table: ResultTable | null = themes.length ? {
      caption: `${q.text}: themes in the comments`,
      widths: [0.4, ...q.designs.map(() => 0.6 / q.designs.length)],
      header: ["Theme", ...q.designs.map(d => `${designName(d)} (${hidden(d.id) ? "—" : `${smallCount(d.n)} comments`})`)],
      rows: themes.map(t => [t.name, ...q.designs.map(d => hidden(d.id) ? hiddenText : smallCount(count(t.id, d.id)))]),
    } : null;
    const quotes = coding.quotes.filter(x => x.questionId === q.questionId && !hidden(x.designId)).map(x => {
      const d = q.designs.find(y => y.id === x.designId);
      return `“${x.text.trim()}” (${d ? `Design ${d.letter}, ${d.label}` : "a participant"})`;
    });
    return { heading: `${taskTitle(q.taskId)}: ${q.text}`, table, quotes };
  }).filter(s => s.table || s.quotes.length);
}
