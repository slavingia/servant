// Study activities for Research Studio studies: the seven Civic Research Studio
// methods, their planner defaults, sample-size guidance, standard analysis, the
// Researcher agent prompt section, and an importable Research Studio working copy.
//
// Planner text and rules are ported from Civic Research Studio v0.3.24
// (ash-webb/research-studio, CC0): src/methods.js, src/method-plans.js and
// src/plan.js. Keep them in step so a plan drafted here matches what the
// researcher sees after importing the file into Research Studio's builder.
import { planStudy, sampleSizeForMargin, sampleSizeVsHalf } from "./research-stats.ts";

export const RESEARCH_STUDIO_VERSION = "0.3.24";

export type StudyMethod = "prototype" | "ab_test" | "card_sort" | "tree_test" | "first_click" | "preference" | "survey";
export type StudyGoal = "discover" | "measure" | "explore" | "validate";
export type StudyDesign = { label: string; url: string };
export type HypothesisDirection = "higher" | "lower" | "different";

export const STUDY_METHODS: readonly { id: StudyMethod; label: string; description: string }[] = [
  { id: "prototype", label: "Prototype usability", description: "Instrumented GitHub Pages prototype, task timing, click paths and success signals" },
  { id: "ab_test", label: "A/B implementation test", description: "Randomly assign one of two or more live designs and compare actual task performance" },
  { id: "card_sort", label: "Card sorting", description: "Open, closed or hybrid information grouping" },
  { id: "tree_test", label: "Tree testing", description: "Findability using a text-only navigation hierarchy" },
  { id: "first_click", label: "First-click testing", description: "First interaction on a screenshot or mockup" },
  { id: "preference", label: "Preference testing", description: "Compare two or more alternative designs" },
  { id: "survey", label: "Survey", description: "Standalone, structured research questions" },
];

export const methodLabel = (method: StudyMethod) => STUDY_METHODS.find(item => item.id === method)?.label ?? method;

/** How results are collected. Research Studio has no database of its own for live studies. */
export type StudyCollection = "qualtrics-embed" | "qualtrics-links" | "undecided";
export type StudyDevices = "any" | "desktop";
export type StudySetup = { collection: StudyCollection; devices: StudyDevices };

export const STUDY_COLLECTIONS: readonly { id: StudyCollection; label: string; description: string }[] = [
  { id: "qualtrics-embed", label: "Qualtrics: Research Studio inside the survey", description: "One survey shows Research Studio on a page and stores every activity's results, the study's questions and the full session (route B)." },
  { id: "qualtrics-links", label: "Qualtrics: two surveys and links", description: "Survey 1 sends people to Research Studio and Survey 2 receives A/B results in the link. Other answers stay in the browser (route A)." },
  { id: "undecided", label: "Not decided yet", description: "Plan the activities now and choose how results are collected later." },
];

export const DEFAULT_STUDY_SETUP: StudySetup = { collection: "qualtrics-embed", devices: "any" };

export const GOALS: Partial<Record<StudyMethod, Partial<Record<StudyGoal, string>>>> = {
  prototype: { discover: "Find usability problems", measure: "Measure how many complete the task" },
  card_sort: { explore: "Explore how people group the content", validate: "Check whether people agree with our categories" },
};

/** One activity as the researcher edits it in Servant. Lists are typed one item per line. */
export type StudyActivity = {
  key: string;
  method: StudyMethod;
  title: string;
  instructions: string;
  objective: string;
  criteria: string;
  /** Prototype URL, or the first-click screenshot URL. */
  url: string;
  successSignal: string;
  goal: StudyGoal;
  perRound: number | null;
  rounds: number | null;
  benchmark: number | null;
  directBenchmark: number | null;
  margin: number | null;
  /** A/B designs (live prototype URLs) or preference options (image URLs). */
  designs: StudyDesign[];
  controlIndex: number;
  direction: HypothesisDirection;
  baseline: number | null;
  difference: number | null;
  power: number;
  stoppingRule: string;
  sortMode: "open" | "closed" | "hybrid";
  cards: string;
  categories: string;
  threshold: number | null;
  target: number | null;
  /** Indented outline, two spaces per level; end a correct destination with "*". */
  tree: string;
  split: number | null;
  questions: string;
  constructs: string;
};

export const MAX_STUDY_ACTIVITIES = 12;
const letter = (index: number) => String.fromCharCode(65 + index);

export function newStudyActivity(method: StudyMethod, key: string): StudyActivity {
  const designs = method === "ab_test"
    ? [{ label: "Current design", url: "" }, { label: "New design", url: "" }]
    : method === "preference"
      ? [{ label: "Option A", url: "" }, { label: "Option B", url: "" }]
      : [];
  return {
    key, method, title: "", instructions: "", objective: "", criteria: "",
    url: "", successSignal: "",
    goal: method === "card_sort" ? "explore" : method === "prototype" ? "discover" : "measure",
    perRound: 6, rounds: 2, benchmark: null, directBenchmark: null, margin: 10,
    designs, controlIndex: 0, direction: "higher", baseline: 50, difference: 15, power: 0.8, stoppingRule: "",
    sortMode: "open", cards: "", categories: "", threshold: 60, target: 20,
    tree: "", split: 60, questions: "", constructs: "",
  };
}

/** Changing an activity's method keeps what was typed and resets method-specific defaults. */
export function changeActivityMethod(activity: StudyActivity, method: StudyMethod): StudyActivity {
  if (activity.method === method) return activity;
  const fresh = newStudyActivity(method, activity.key);
  return { ...fresh, title: activity.title, instructions: activity.instructions, objective: activity.objective, criteria: activity.criteria };
}

/** Card sorts start with the goal Research Studio picks for their sort mode. */
export function changeSortMode(activity: StudyActivity, sortMode: StudyActivity["sortMode"]): StudyActivity {
  return { ...activity, sortMode, goal: sortMode === "open" ? "explore" : "validate" };
}

// ---------- text helpers ----------
const clean = (value: unknown, limit: number) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
const lines = (value: string, limit = 200) => value.split(/\r?\n/).map(line => clean(line, limit)).filter(Boolean);
const SLUG = /^[a-z0-9-]{1,64}$/;
export function slugify(value: string, fallback: string, max = 64): string {
  const slug = value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
  return slug || fallback;
}
function uniqueSlug(base: string, used: Set<string>, max = 64): string {
  let candidate = base.slice(0, max), n = 2;
  while (used.has(candidate)) { const suffix = `-${n++}`; candidate = `${base.slice(0, max - suffix.length)}${suffix}`; }
  used.add(candidate);
  return candidate;
}
const numberOrNull = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? value : null;
// A field the current goal hides can't be corrected on screen, so the file uses a safe value for it.
const hidden = (value: number | null, lo: number, hi: number, fallback: number | null) => {
  const n = numberOrNull(value);
  return n != null && n >= lo && n <= hi ? n : fallback;
};

/** Same rule as Research Studio: HTTPS, or local HTTP for development. */
export function studyUrlProblem(value: string): string | null {
  const text = value.trim();
  if (!text) return "needs a link";
  try {
    const url = new URL(text);
    if (url.protocol === "https:") return null;
    if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
    return "must be an HTTPS link";
  } catch {
    return "must be a full link starting with https://";
  }
}

// ---------- tree outline ----------
export type TreeNode = { id: string; label: string; children?: TreeNode[] };
export function parseTreeOutline(outline: string): { tree: TreeNode[]; correctNodeIds: string[]; nodes: number } {
  const used = new Set<string>();
  const roots: TreeNode[] = [];
  const stack: { indent: number; node: TreeNode }[] = [];
  const correct: string[] = [];
  let nodes = 0;
  for (const raw of outline.replace(/\t/g, "  ").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    let label = clean(raw, 200);
    const isCorrect = /\*\s*$/.test(label);
    label = label.replace(/\s*\*+\s*$/, "").trim();
    if (!label) continue;
    const node: TreeNode = { id: uniqueSlug(slugify(label, `node-${nodes + 1}`), used), label };
    nodes++;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    if (parent) (parent.children ||= []).push(node); else roots.push(node);
    stack.push({ indent, node });
    if (isCorrect) correct.push(node.id);
  }
  return { tree: roots, correctNodeIds: correct, nodes };
}

// ---------- Research Studio shapes ----------
type RsVariant = { id: string; label: string; prototypeUrl?: string; imageUrl?: string };
type RsQuestion = { id: string; type: "textarea"; text: string; required: boolean };
export type ResearchStudioTask = {
  id: string; method: StudyMethod; title: string; instructions: string; questions: RsQuestion[];
  prototypeUrl?: string; successSignal?: string; experimentId?: string; variants?: RsVariant[];
  sortMode?: StudyActivity["sortMode"]; cards?: { id: string; label: string }[]; categories?: { id: string; label: string }[];
  tree?: TreeNode[]; correctNodeIds?: string[]; imageUrl?: string; targetAreas?: unknown[];
};
export type ResearchStudioActivityPlan = {
  method: StudyMethod; objective: string; rqs: number[]; criteria: string; margin: number | null;
  goal?: StudyGoal; measure?: "success" | "self"; benchmark?: number | null; rounds?: number | null; perRound?: number | null;
  directBenchmark?: number | null; threshold?: number | null; target?: number | null; split?: number | null; power?: number; constructs?: string;
};
export type ResearchStudioExperimentPlan = {
  controlId: string; treatments: Record<string, string>;
  hypotheses: { id: string; treatmentId: string; direction: HypothesisDirection; measure: "success" | "self"; rationale: string }[];
  primaryMeasure: "success" | "self"; secondary: string[];
  baseline: number | null; difference: number | null; power: number; stoppingRule: string;
};
type Converted = { activity: StudyActivity; task: ResearchStudioTask; plan?: ResearchStudioActivityPlan; experiment?: ResearchStudioExperimentPlan };

const signalOf = (activity: StudyActivity) => {
  const signal = activity.successSignal.trim();
  return SLUG.test(signal) ? signal : "";
};

/** Converts every activity into Research Studio's task and plan shapes. */
export function convertActivities(activities: readonly StudyActivity[]): Converted[] {
  const usedTasks = new Set<string>();
  const methodCount: Partial<Record<StudyMethod, number>> = {};
  return activities.map(activity => {
    methodCount[activity.method] = (methodCount[activity.method] ?? 0) + 1;
    const fallback = `${activity.method.replace(/_/g, "-")}-${methodCount[activity.method]}`;
    const id = uniqueSlug(slugify(activity.title, fallback), usedTasks);
    const base: ResearchStudioTask = { id, method: activity.method, title: clean(activity.title, 160), instructions: clean(activity.instructions, 2_000), questions: [] };
    const objective = clean(activity.objective, 3_000), criteria = clean(activity.criteria, 3_000);
    const planBase = { method: activity.method, objective, rqs: [] as number[], criteria, margin: numberOrNull(activity.margin) };
    const signal = signalOf(activity);
    switch (activity.method) {
      case "prototype":
        return { activity, task: { ...base, prototypeUrl: activity.url.trim(), ...(signal ? { successSignal: signal } : {}) },
          plan: activity.goal === "measure"
            ? { ...planBase, goal: "measure", measure: signal ? "success" : "self", benchmark: numberOrNull(activity.benchmark), rounds: numberOrNull(activity.rounds), perRound: numberOrNull(activity.perRound) }
            : { ...planBase, margin: hidden(activity.margin, 1, 49, 10), goal: "discover", measure: signal ? "success" : "self", benchmark: hidden(activity.benchmark, 1, 99, null), rounds: numberOrNull(activity.rounds), perRound: numberOrNull(activity.perRound) } };
      case "ab_test": {
        // Research Studio treats the first design as the control; IDs follow the typed order.
        const indexed = activity.designs.map((design, index) => ({ design, index }));
        const control = indexed[activity.controlIndex] ?? indexed[0];
        const ordered = control ? [control, ...indexed.filter(item => item !== control)] : indexed;
        const variants: RsVariant[] = ordered.map(({ design, index }) => ({ id: `design-${letter(index).toLowerCase()}`, label: clean(design.label, 120) || `Design ${letter(index)}`, prototypeUrl: design.url.trim() }));
        const measure = signal ? "success" : "self";
        const controlId = variants[0]?.id ?? "";
        return { activity, task: { ...base, experimentId: id, variants, ...(signal ? { successSignal: signal } : {}) },
          experiment: {
            controlId, treatments: {},
            hypotheses: variants.slice(1).map((variant, index) => ({ id: `h${index + 1}`, treatmentId: variant.id, direction: activity.direction, measure, rationale: "" })),
            primaryMeasure: measure, secondary: ["measured", "self", "time", "dropout"],
            baseline: numberOrNull(activity.baseline), difference: numberOrNull(activity.difference), power: activity.power === 0.9 ? 0.9 : 0.8,
            stoppingRule: clean(activity.stoppingRule, 2_000),
          } };
      }
      case "card_sort": {
        const usedCards = new Set<string>(), usedCats = new Set<string>();
        const cards = lines(activity.cards, 120).map((label, index) => ({ id: uniqueSlug(slugify(label, `card-${index + 1}`), usedCards), label }));
        const categories = activity.sortMode === "open" ? [] : lines(activity.categories, 120).map((label, index) => ({ id: uniqueSlug(slugify(label, `category-${index + 1}`), usedCats), label }));
        return { activity, task: { ...base, sortMode: activity.sortMode, cards, categories },
          plan: activity.goal === "validate"
            ? { ...planBase, goal: "validate", threshold: numberOrNull(activity.threshold), target: hidden(activity.target, 5, 500, 20) }
            : { ...planBase, margin: hidden(activity.margin, 1, 49, 10), goal: "explore", threshold: numberOrNull(activity.threshold), target: numberOrNull(activity.target) } };
      }
      case "tree_test": {
        const parsed = parseTreeOutline(activity.tree);
        return { activity, task: { ...base, tree: parsed.tree, correctNodeIds: parsed.correctNodeIds },
          plan: { ...planBase, benchmark: numberOrNull(activity.benchmark), directBenchmark: numberOrNull(activity.directBenchmark) } };
      }
      case "first_click":
        return { activity, task: { ...base, imageUrl: activity.url.trim(), targetAreas: [] }, plan: { ...planBase, benchmark: numberOrNull(activity.benchmark) } };
      case "preference":
        return { activity, task: { ...base, variants: activity.designs.map((design, index) => ({ id: `option-${letter(index).toLowerCase()}`, label: clean(design.label, 120) || `Option ${letter(index)}`, imageUrl: design.url.trim() })) },
          plan: { ...planBase, split: numberOrNull(activity.split), power: activity.power === 0.9 ? 0.9 : 0.8 } };
      case "survey":
        return { activity, task: { ...base, questions: lines(activity.questions, 500).map((text, index) => ({ id: `q${index + 1}`, type: "textarea" as const, text, required: false })) },
          plan: { ...planBase, constructs: clean(activity.constructs, 3_000) } };
    }
  });
}

// ---------- sample size and standard analysis (method-plans.js) ----------
const BENCH_LABEL: Partial<Record<StudyMethod, string>> = { prototype: "task success", tree_test: "task success (correct destination)", first_click: "first-click success (click in a target area)" };
export type ActivitySize = { n: number | null; total?: number; text: string };

export function activitySize(task: ResearchStudioTask, ap: ResearchStudioActivityPlan): ActivitySize {
  const m = task.method, margin = (numberOrNull(ap.margin) || 10) / 100;
  const p = numberOrNull(ap.benchmark) != null ? Math.min(0.95, Math.max(0.05, numberOrNull(ap.benchmark)! / 100)) : 0.5;
  if (m === "prototype" && ap.goal === "discover") {
    const per = Math.max(1, numberOrNull(ap.perRound) || 6), rounds = Math.max(1, numberOrNull(ap.rounds) || 2);
    return { n: per, total: per * rounds, text: `${per} people per round, ${rounds} round${rounds === 1 ? "" : "s"} (${per * rounds} in total), fixing problems between rounds. Small rounds find many of the most common problems; problems few people meet need more participants. Results describe problems, not rates for the whole population.` };
  }
  if (m === "card_sort" && ap.goal === "explore") {
    const n = Math.max(5, numberOrNull(ap.target) || 20);
    return { n, text: `About ${n} people completing the sort. For open card sorts, 15–30 is common practice; similarity scores tend to settle at around 15–20 participants (Tullis & Wood, 2004).` };
  }
  if (m === "preference") {
    const split = (numberOrNull(ap.split) || 60) / 100, power = Number(ap.power) || 0.8, n = sampleSizeVsHalf(split, { power });
    return n ? { n, text: `About ${n} people choosing between two options, to tell a ${Math.round(split * 100)}/${100 - Math.round(split * 100)} split from 50/50 with ${Math.round(power * 100)}% power. "No preference" answers and a third option need more people.` } : { n: null, text: "Enter a split other than 50%." };
  }
  const n = sampleSizeForMargin(p, margin);
  if (!n) return { n: null, text: "Enter a margin between 1 and 49 points." };
  const what = m === "card_sort" ? "the share placing a card in a category" : m === "survey" ? "a percentage answer" : `${BENCH_LABEL[m] || "the rate"}`;
  const extra = m === "tree_test" ? " Many teams recruit about 50 per tree." : "";
  return { n, text: `About ${n} people completing the activity, so that ${what} near ${Math.round(p * 100)}% is estimated to within about ±${Math.round(margin * 100)} points (95% interval).${extra} Recruit extra for drop-out.` };
}

export function activityAnalysis(task: ResearchStudioTask, ap: ResearchStudioActivityPlan): string {
  const m = task.method, b = numberOrNull(ap.benchmark);
  const bench = b != null ? ` Compare with the benchmark of ${b}%: above if the whole 95% interval is above it, below if the whole interval is below it, otherwise inconclusive.` : "";
  const denom = "People who started the activity but did not finish count as not successful.";
  if (m === "prototype") return ap.goal === "discover"
    ? "List usability problems from click histories and follow-up answers, with the number of participants who met each and its severity. Counts describe this sample and are not population rates. Report self-reported completion and time for context."
    : `Report the share who completed the task (${ap.measure === "success" ? `success signal "${task.successSignal}"` : "self-reported completion"}) with a 95% Wilson interval. ${denom}${bench} Report median active time and follow-up answers for context.`;
  if (m === "tree_test") return `Report task success (ended at a correct destination) with a 95% Wilson interval, directness (no backtracking), first-level choices and the most common wrong destinations. ${denom}${bench}${numberOrNull(ap.directBenchmark) != null ? ` Compare directness with ${numberOrNull(ap.directBenchmark)}% the same way.` : ""}`;
  if (m === "first_click") return `Report the share whose first click landed in a target area ("Not sure" counts as a miss) with a 95% Wilson interval, the click map and the most common wrong areas. ${denom}${bench}`;
  if (m === "card_sort") return ap.goal === "explore"
    ? `Use completed sorts. Report the similarity matrix (share of participants who grouped each pair together), common group names and cards with no clear home (no partner grouped with it by at least ${numberOrNull(ap.threshold) ?? 60}% of participants). Group names are not merged automatically.`
    : `Use completed sorts. For each card, report the share placing it in each category with 95% intervals. Cards whose most common category falls below ${numberOrNull(ap.threshold) ?? 60}% agreement are flagged for review.`;
  if (m === "preference") return "Report the share choosing each option with 95% Wilson intervals. With two options, report whether the interval for the leading option excludes 50%. Summarise reasons from follow-up answers. Preference is not performance: compare with task results where available. Presentation order is randomised.";
  if (m === "survey") return `Summarise each question: distribution and median for scales, counts and percentages with 95% intervals for choices, and themes for open text.${ap.constructs?.trim() ? ` Questions are grouped by what they measure: ${ap.constructs.trim()}.` : ""}`;
  return "";
}

// ---------- A/B experiments (plan.js) ----------
const PRIMARY = { success: "Task success (success signal)", self: "Self-reported completion" };
const SECONDARY: Record<string, string> = { measured: "Success among finishers with success measured", self: "Self-reported completion", time: "Active time on task", success_time: "Time for successful attempts", clicks: "Clicks in the design", dropout: "Drop-out by design", followup: "Follow-up question answers" };
const STOP_DEFAULT = "Field until the target sample is reached in every design, then analyse once. No early stopping based on results.";

export function plannedSize(e: ResearchStudioExperimentPlan, designs: number) {
  return planStudy({ baseline: Number(e.baseline) / 100, difference: Number(e.difference) / 100, designs, power: Number(e.power) || 0.8 });
}
const designLabel = (task: ResearchStudioTask, id: string) => {
  const variants = task.variants ?? [];
  const i = variants.findIndex(v => v.id === id);
  return i < 0 ? id : `Design ${letter(i)} (${variants[i].label})`;
};
export function hypothesisSentence(task: ResearchStudioTask, e: ResearchStudioExperimentPlan, h: ResearchStudioExperimentPlan["hypotheses"][number]): string {
  const control = designLabel(task, e.controlId), treat = designLabel(task, h.treatmentId);
  return `Compared with ${control}, the control, ${treat} will have a ${h.direction} ${h.measure === "self" ? "self-reported completion rate" : "task success rate"}.`;
}
export function sizeText(e: ResearchStudioExperimentPlan, designs: number): string {
  const s = plannedSize(e, designs);
  if (!s) return "Enter an expected control rate between 1 and 99% and a difference that keeps the target between 0 and 100%.";
  return `Recruit about ${s.perDesign} people assigned per design (${s.total} in total), plus extra for drop-out. This gives ${Math.round(s.power * 100) === 80 ? "an" : "a"} ${Math.round(s.power * 100)}% chance of detecting a change from ${e.baseline}% to ${Math.round(s.target * 100)}%${s.direction === "down" && Number(e.baseline) + Number(e.difference) >= 100 ? ` (planned as a drop, since ${Number(e.baseline) + Number(e.difference)}% is not possible)` : ""}${designs > 2 ? `, with significance adjusted for ${designs - 1} comparisons with the control` : ""}.`;
}
export function abAnalysis(task: ResearchStudioTask, e: ResearchStudioExperimentPlan, experiments = 1): string {
  const n = task.variants?.length ?? 0, s = plannedSize(e, n);
  const control = designLabel(task, e.controlId), measure = PRIMARY[e.primaryMeasure] || PRIMARY.success;
  const sec = (e.secondary || []).map(k => SECONDARY[k]).filter(Boolean);
  return [
    `${experiments > 1 ? `Experiment ${task.experimentId || task.id}. ` : ""}Primary analysis: compare each treatment design with ${control}, the control, on ${measure.toLowerCase()}. Everyone assigned to a design is included in its denominator; people who drop out${e.primaryMeasure === "success" ? " or whose success cannot be measured" : ""} count as not successful.`,
    `Report each design's rate with a 95% Wilson score interval and the difference from the control with a Newcombe hybrid score interval${n > 2 ? `, at 97.5% (Bonferroni) because ${n - 1} treatments are each compared with the control` : ""}. An interval that excludes zero is reported as a clear difference; an interval that includes zero is reported as inconclusive, not as evidence that the designs perform the same. No winner is declared automatically: the team judges whether a difference matters in practice.`,
    s ? `Target sample: ${s.perDesign} people assigned per design (${s.total} in total) to detect a change from ${e.baseline}% to ${Math.round(s.target * 100)}% with ${Math.round(s.power * 100)}% power.` : "Target sample: to be set.",
    `Stopping rule: ${e.stoppingRule?.trim() || STOP_DEFAULT}`,
    "Before interpreting outcomes, check: group sizes (sample-ratio check), drop-out by design, success-tracking coverage by design and device mix. Any problem is reported with the results.",
    sec.length ? `Secondary measures (${sec.join("; ").toLowerCase()}) are reported descriptively with intervals for context and are not used to decide between designs.` : "",
  ].filter(Boolean).join("\n");
}

/** What the activity editor shows: sample size and standard analysis, as Research Studio computes them. */
export type ActivitySummary = { size: string; analysis: string; recruit: number | null; hypotheses: string[] };
export function summarizeActivities(activities: readonly StudyActivity[]): { items: ActivitySummary[]; largest: { title: string; n: number } | null } {
  const converted = convertActivities(activities);
  const experiments = converted.filter(item => item.experiment).length;
  let largest: { title: string; n: number } | null = null;
  const items = converted.map((item, index) => {
    const name = item.task.title || `Activity ${index + 1}`;
    let summary: ActivitySummary;
    if (item.experiment) {
      const s = plannedSize(item.experiment, item.task.variants?.length ?? 0);
      summary = { size: sizeText(item.experiment, item.task.variants?.length ?? 0), analysis: abAnalysis(item.task, item.experiment, experiments), recruit: s?.total ?? null,
        hypotheses: item.experiment.hypotheses.map(h => hypothesisSentence(item.task, item.experiment!, h)) };
    } else {
      const s = activitySize(item.task, item.plan!);
      summary = { size: s.text, analysis: activityAnalysis(item.task, item.plan!), recruit: s.total || s.n, hypotheses: [] };
    }
    if (summary.recruit && (!largest || summary.recruit > largest.n)) largest = { title: name, n: summary.recruit };
    return summary;
  });
  return { items, largest };
}

// ---------- what the Research Studio file needs ----------
const RANGES: [keyof StudyActivity, number, number, string][] = [
  ["benchmark", 1, 99, "Benchmark"], ["directBenchmark", 1, 99, "Directness benchmark"], ["margin", 1, 49, "Precision"],
  ["threshold", 10, 100, "Agreement threshold"], ["split", 51, 95, "Smallest split"], ["target", 5, 500, "Target participants"],
];
const RANGE_METHODS: Record<string, StudyMethod[]> = {
  benchmark: ["prototype", "tree_test", "first_click"], directBenchmark: ["tree_test"], margin: ["prototype", "tree_test", "first_click", "card_sort", "survey"],
  threshold: ["card_sort"], split: ["preference"], target: ["card_sort"],
};

/**
 * Everything Research Studio's import would reject, in plain language. Mirrors
 * validateStudy, validateActivity and validatePlan from Research Studio v0.3.24.
 */
export function researchStudioFileProblems(title: string, activities: readonly StudyActivity[]): string[] {
  const problems: string[] = [];
  if (slugify(title, "").length < 3) problems.push("Add a working title of at least three letters or numbers");
  if (!activities.length) problems.push("Add at least one study activity");
  activities.forEach((activity, index) => {
    const name = `Activity ${index + 1} (${methodLabel(activity.method)})`;
    const add = (detail: string) => problems.push(`${name}: ${detail}`);
    if (!activity.instructions.trim()) add("add instructions for participants");
    // Stricter than Research Studio on purpose: an invalid signal would otherwise be left out of the file silently.
    const signal = activity.successSignal.trim();
    if (signal && !SLUG.test(signal)) add("the success signal can use only lowercase letters, numbers and hyphens");
    if (activity.method === "prototype") { const p = studyUrlProblem(activity.url); if (p) add(`the prototype ${p}`); }
    if (activity.method === "first_click") { const p = studyUrlProblem(activity.url); if (p) add(`the screenshot ${p}`); }
    if (activity.method === "ab_test" || activity.method === "preference") {
      const what = activity.method === "ab_test" ? "design" : "option";
      if (activity.designs.length < 2) add(`add at least two ${what}s`);
      activity.designs.forEach((design, i) => {
        if (!design.label.trim()) add(`name ${what} ${letter(i)}`);
        const p = studyUrlProblem(design.url);
        if (p) add(`${what} ${letter(i)} ${activity.method === "ab_test" ? "prototype" : "image"} ${p}`);
      });
    }
    if (activity.method === "card_sort") {
      if (lines(activity.cards).length < 2) add("add at least two cards");
      if (activity.sortMode === "closed" && lines(activity.categories).length < 2) add("closed sorts need at least two categories");
    }
    if (activity.method === "tree_test") {
      const parsed = parseTreeOutline(activity.tree);
      if (!parsed.nodes) add("add the tree");
      else if (!parsed.correctNodeIds.length) add("mark at least one correct destination with *");
    }
    if (activity.method === "survey" && !lines(activity.questions).length) add("add at least one question");
    for (const [field, lo, hi, label] of RANGES) {
      if (!RANGE_METHODS[field].includes(activity.method)) continue;
      // Fields the current goal hides are replaced with safe values in the file.
      if (["margin", "benchmark"].includes(field) && activity.method === "prototype" && activity.goal === "discover") continue;
      if (field === "margin" && activity.method === "card_sort" && activity.goal === "explore") continue;
      if (field === "target" && activity.goal !== "explore") continue;
      const value = activity[field] as number | null;
      if (value != null && (value < lo || value > hi)) add(`${label.toLowerCase()} must be between ${lo} and ${hi}`);
    }
  });
  return problems;
}

// ---------- the working copy file ----------
export type StudyFileContext = {
  title: string;
  /** Decision, research question(s), audience and prior knowledge from the study form. */
  decision?: string;
  question?: string;
  participants?: string;
  background?: string;
  setup: StudySetup;
  activities: readonly StudyActivity[];
};

/**
 * A Research Studio working copy (study plus plan) for its builder's Import
 * JSON. Built only from what the researcher typed into this form: never from
 * Research Hub records, chats, or other workspace data. Welcome and consent
 * text are left for the researcher to write in Research Studio.
 */
export function buildResearchStudioWorkingCopy(context: StudyFileContext) {
  const converted = convertActivities(context.activities);
  const qualtrics = context.setup.collection !== "undecided";
  const desktop = context.setup.devices === "desktop";
  const questions = (context.question ?? "").split(/\r?\n/).map(line => clean(line, 1_000)).filter(Boolean).slice(0, 30);
  return {
    schemaVersion: 3,
    id: slugify(context.title, "research-study").slice(0, 64),
    version: "1.0.0",
    title: clean(context.title, 160),
    description: "",
    prototypeUrl: "",
    welcome: "",
    consent: "",
    ...(qualtrics ? { consentMode: "external" as const } : {}),
    ...(desktop ? { allowedDevices: "desktop" as const } : {}),
    preQuestions: [],
    tasks: converted.map(item => item.task),
    postQuestions: [],
    plan: {
      background: clean(context.background, 5_000),
      researchQuestions: questions.length ? questions : [""],
      participants: { audience: clean(context.participants, 2_000), recruitment: "", exclusions: "", devices: desktop ? "desktop" : "any" },
      experiments: Object.fromEntries(converted.filter(item => item.experiment).map(item => [item.task.experimentId!, item.experiment!])),
      activities: Object.fromEntries(converted.filter(item => item.plan).map(item => [item.task.id, item.plan!])),
      analysis: "",
      decisions: clean(context.decision, 5_000),
      locked: null,
      changes: [],
    },
  };
}

export function researchStudioFileName(title: string): string {
  return `${slugify(title, "research-study").slice(0, 64)}.working-copy.json`;
}

// ---------- Researcher agent prompt ----------
function activityDetails(item: Converted): string[] {
  const { activity, task } = item;
  const out: string[] = [];
  if (task.instructions) out.push(`Participant instructions: ${task.instructions}`);
  if (activity.objective.trim()) out.push(`What it should tell us: ${clean(activity.objective, 600)}`);
  const goal = GOALS[activity.method]?.[activity.goal];
  if (goal) out.push(`Goal: ${goal}`);
  if (task.prototypeUrl) out.push(`Prototype: ${task.prototypeUrl}`);
  if (task.imageUrl) out.push(`Screenshot: ${task.imageUrl} (target areas are drawn later in Research Studio)`);
  if (task.successSignal) out.push(`Success signal: ${task.successSignal}`);
  if (task.method === "ab_test") out.push(`Designs (Qualtrics design IDs): ${(task.variants ?? []).map((v, i) => `${v.id} = ${v.label}${i === 0 ? " (control)" : ""}`).join("; ")}`);
  if (task.method === "preference") out.push(`Options: ${(task.variants ?? []).map(v => v.label).join("; ")}`);
  if (task.method === "card_sort") out.push(`${task.sortMode} sort with ${task.cards?.length ?? 0} cards${task.categories?.length ? ` and categories ${task.categories.map(c => c.label).join(", ")}` : ""}`);
  if (task.method === "tree_test") out.push(`Tree with ${parseTreeOutline(activity.tree).nodes} labels; correct destinations: ${(task.correctNodeIds ?? []).join(", ") || "none marked yet"}`);
  if (task.method === "survey") out.push(`Questions: ${task.questions.map(q => q.text).join(" | ")}`);
  if (activity.criteria.trim()) out.push(`Good enough, and what we would do: ${clean(activity.criteria, 600)}`);
  return out;
}

export function studyActivitiesPrompt(setup: StudySetup, activities: readonly StudyActivity[]): string[] {
  if (!activities.length) return [];
  const converted = convertActivities(activities);
  const summary = summarizeActivities(activities);
  const collection = STUDY_COLLECTIONS.find(item => item.id === setup.collection)!;
  return [
    "",
    `Civic Research Studio activities (unmoderated; planned with Research Studio ${RESEARCH_STUDIO_VERSION} rules):`,
    ...converted.flatMap((item, index) => {
      const s = summary.items[index];
      return [
        `${index + 1}. ${item.task.title || `Activity ${index + 1}`} — ${methodLabel(item.task.method)}`,
        ...activityDetails(item).map(line => `   - ${line}`),
        ...s.hypotheses.map(line => `   - Hypothesis: ${line}`),
        `   - Sample size: ${s.size}`,
        `   - Standard analysis: ${s.analysis.replace(/\n+/g, " ")}`,
      ];
    }),
    ...(summary.largest ? [`Everyone takes every activity, so recruit for the largest need: about ${summary.largest.n} people (${summary.largest.title}), plus extra for drop-out.`] : []),
    `Devices: ${setup.devices === "desktop" ? "laptops and desktops only" : "any device"}.`,
    `Data collection: ${collection.label}. ${collection.description}`,
    "",
    "For these activities:",
    "- Use the sample sizes and standard analyses above exactly as given; they come from Research Studio's planner. Explain them in plain language, but do not recompute or replace them.",
    "- Write tasks, prompts and follow-up questions for each activity, and say what each result would change.",
    ...(setup.collection === "qualtrics-embed" ? [
      "- Produce a Qualtrics setup checklist for Research Studio inside the survey (route B): consent and PRA notice, screener, a randomizer that sets rs_variant for each A/B design ID, the Research Studio page with the script and embedded-data fields from qualtrics-embed.html (or the starter .qsf), follow-up and thank-you pages, and importing the export back with Import Qualtrics results.",
    ] : setup.collection === "qualtrics-links" ? [
      "- Produce a Qualtrics setup checklist for two surveys and links (route A): Survey 1 consent, PRA notice, screener and randomizer; the Research Studio link; Survey 2 receiving rs_ results; and which questions must be asked in Qualtrics because route A does not return them.",
    ] : [
      "- Explain the data-collection options (Qualtrics routes A and B) and what each would store, so the researcher can choose.",
    ]),
    ...(setup.devices === "desktop" ? ["- Include device screening for a laptop- and desktop-only study."] : []),
    ...(setup.collection === "undecided" ? [] : ["- Consent is collected in the Qualtrics survey, not in Research Studio. Flag what the consent, PRA notice and welcome text must cover."]),
    "- Do not set up, publish, or field anything, and do not claim that any activity was run.",
  ];
}
