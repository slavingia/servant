// Study activities for Research Studio studies: the seven Civic Research Studio
// methods, their planner defaults, sample-size guidance, standard analysis, the
// Researcher agent prompt section, and an importable Research Studio working copy.
//
// Planner text and rules are ported from Civic Research Studio v0.3.24
// (ash-webb/research-studio, CC0): src/methods.js, src/method-plans.js and
// src/plan.js. Keep them in step so a plan drafted here matches what the
// researcher sees after importing the file into Research Studio's builder.
import { researchStudioImportChanges, type WorkingDraft } from "./research-studio-compat.ts";
import { allowingForLoss, DEFAULT_LOSS_ALLOWANCE, MAX_LOSS_ALLOWANCE, planStudy, sampleSizeForMargin, sampleSizeVsHalf } from "./research-stats.ts";

export const RESEARCH_STUDIO_VERSION = "0.3.24";

export type StudyMethod = "prototype" | "ab_test" | "card_sort" | "tree_test" | "first_click" | "preference" | "survey";
export type StudyGoal = "discover" | "measure" | "explore" | "validate";
export type StudyDesign = { label: string; url: string };
export type HypothesisDirection = "higher" | "lower" | "different";

export const STUDY_METHODS: readonly { id: StudyMethod; label: string; description: string }[] = [
  { id: "prototype", label: "Prototype usability", description: "Instrumented GitHub Pages prototype, task timing, click paths and success signals" },
  { id: "ab_test", label: "A/B implementation test", description: "Randomly assign one of exactly two live designs, a control and one alternative, and compare actual task performance" },
  { id: "card_sort", label: "Card sorting", description: "Open, closed or hybrid information grouping" },
  { id: "tree_test", label: "Tree testing", description: "Findability using a text-only navigation hierarchy" },
  { id: "first_click", label: "First-click testing", description: "First interaction on a screenshot or mockup" },
  { id: "preference", label: "Preference testing", description: "Compare two or more alternative designs" },
  { id: "survey", label: "Survey", description: "Standalone, structured research questions" },
];

/** What participants do in each method, in a sentence, shown with its illustration. */
export const METHOD_PARTICIPANT_VIEW: Readonly<Record<StudyMethod, string>> = {
  prototype: "Participants try a task in a working prototype. Research Studio records time, clicks and whether they reach the success signal.",
  ab_test: "Each participant is randomly given one of the two designs and tries the same task. Results are compared between designs.",
  card_sort: "Participants sort cards into groups and name them, or use groups you provide.",
  tree_test: "Participants click through a text-only menu to where they'd expect to find something.",
  first_click: "Participants see a screenshot or mockup and click where they'd go first.",
  preference: "Participants see the options and choose one, or say they have no preference.",
  survey: "Participants answer questions. There's no design or task.",
};

export const methodLabel = (method: StudyMethod) => STUDY_METHODS.find(item => item.id === method)?.label ?? method;

/** How results are collected. Research Studio has no database of its own for live studies. */
export type StudyCollection = "qualtrics-embed" | "qualtrics-links" | "undecided";
export type StudyDevices = "any" | "desktop";
/**
 * lossAllowance: percent of recruits expected to be lost before randomization
 * (A/B) or before an activity starts: screen-outs and technical failures. It
 * is separate from noncompletion after randomization, which the analysis
 * counts as not successful.
 */
export type StudySetup = { collection: StudyCollection; devices: StudyDevices; lossAllowance: number | null };

export const STUDY_COLLECTIONS: readonly { id: StudyCollection; label: string; description: string }[] = [
  { id: "qualtrics-embed", label: "Qualtrics: Research Studio inside the survey", description: "One survey shows Research Studio on a page and stores every activity's results, the study's questions and the full session (route B)." },
  { id: "qualtrics-links", label: "Qualtrics: two surveys and links", description: "Survey 1 sends people to Research Studio and Survey 2 receives A/B results in the link. Other answers stay in the browser (route A)." },
  { id: "undecided", label: "Not decided yet", description: "Plan the activities now and choose how results are collected later." },
];

export const DEFAULT_STUDY_SETUP: StudySetup = { collection: "qualtrics-embed", devices: "any", lossAllowance: DEFAULT_LOSS_ALLOWANCE };
export const lossAllowanceProblem = (value: number | null | undefined) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_LOSS_ALLOWANCE ? null : `Enter a loss allowance from 0 to ${MAX_LOSS_ALLOWANCE}%`;

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
  /** A/B: the one prespecified primary outcome. Task success needs a success signal. */
  primary: "success" | "self";
  /** A/B: the planning direction. The test itself is two-sided. */
  direction: HypothesisDirection;
  baseline: number | null;
  difference: number | null;
  power: number;
  stoppingRule: string;
  /** The researcher has reviewed and confirmed the stopping rule as written. Editing it clears this. */
  stoppingRuleConfirmed: boolean;
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
/** Research pilot: A/B tests compare exactly two designs, a control and one alternative. */
export const AB_DESIGNS = 2;
/** Preference tests support powered claims only with exactly two options; more are exploratory. */
export const POWERED_PREFERENCE_OPTIONS = 2;
/** Offered as a starting point. It is never filled in or accepted without the researcher choosing it. */
export const STOP_DEFAULT = "Field until the target sample is reached in every design, then analyse once. No early stopping based on results.";
const letter = (index: number) => String.fromCharCode(65 + index);
/**
 * Choosing the control moves that design to Design A, as Research Studio
 * shows it: the editor, the plan and the file always agree on the letters.
 */
export function chooseControl(activity: StudyActivity, index: number): StudyActivity {
  const chosen = activity.designs[index];
  if (!chosen) return activity;
  return { ...activity, designs: [chosen, ...activity.designs.filter((_, i) => i !== index)], controlIndex: 0 };
}
/** Labels for the planning direction, in the words of the chosen primary outcome. */
export function directionOptions(primary: StudyActivity["primary"]): { value: HypothesisDirection; label: string }[] {
  const outcome = primary === "self" ? "self-reported completion" : "task success";
  return [{ value: "higher", label: `Higher ${outcome}` }, { value: "lower", label: `Lower ${outcome}` }, { value: "different", label: "Different (either way)" }];
}

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
    designs, controlIndex: 0, primary: "success", direction: "higher", baseline: 50, difference: 15, power: 0.8, stoppingRule: "", stoppingRuleConfirmed: false,
    sortMode: "open", cards: "", categories: "", threshold: 60, target: 20,
    tree: "", split: 60, questions: "", constructs: "",
  };
}

// ---------- starting templates ----------
/**
 * Starting text for each method, filled in when the method is chosen so the
 * researcher edits a plan instead of starting from blank fields. Anything that
 * must be made specific is in [square brackets], and a working draft isn't
 * saved while any is left (templateTextProblem). Planning decisions are never
 * filled in: no stopping rule, success signal, links, cards, categories or tree.
 */
type TemplateText = Partial<Pick<StudyActivity, "instructions" | "objective" | "criteria" | "questions" | "constructs">>;
const TASK_GOAL = "[what they're trying to do, in their words]";
export const METHOD_TEMPLATES: Readonly<Record<StudyMethod, TemplateText>> = {
  prototype: {
    instructions: `Imagine you need to ${TASK_GOAL}. Use the prototype the way you would on your own. When you've finished, or if you would stop trying, move on.`,
    objective: "Where people get stuck or confused, and why.",
    criteria: "Fix the problems that stop people from finishing before the next round.",
  },
  ab_test: {
    instructions: `Imagine you need to ${TASK_GOAL}. Do it the way you normally would. When you've finished, or if you would stop trying, move on.`,
    objective: "Whether the new design changes how many people complete the task, compared with the current design.",
    criteria: "If the range for the difference is above zero, consider the new design. If it includes zero, this test doesn't show a difference: look at where people struggled before deciding.",
  },
  card_sort: {
    instructions: "Sort these cards into groups that make sense to you, then give each group a name. There are no right or wrong answers.",
    objective: "How people group and name this content, to inform navigation and labels.",
    criteria: "Start navigation from the groups most people agree on, and look again at cards people split between groups.",
  },
  tree_test: {
    instructions: "Where would you look to [find something, in their words]? Click through the menu, then choose the place you'd expect to find it.",
    objective: "Whether people can find the item in this navigation, and which branch they try first.",
    criteria: "Relabel or move items that fewer people than the benchmark find.",
  },
  first_click: {
    instructions: `Look at this page. Where would you click first to ${TASK_GOAL}?`,
    objective: "Whether people's first click heads toward the right place.",
    criteria: "Make the target clearer or more prominent if many first clicks miss it.",
  },
  preference: {
    instructions: `Look at each design. Which would you rather use to ${TASK_GOAL}? You can also say you have no preference.`,
    objective: "Which design people prefer, as one input alongside how well they can use each one.",
    criteria: "Treat preference as one signal: don't choose a design on preference alone.",
  },
  survey: {
    instructions: "Answer a few questions about your experience. There are no right or wrong answers.",
    objective: "How people describe their experience, and what would make it easier.",
    questions: `How easy or difficult was it to ${TASK_GOAL}?\nWhat, if anything, was confusing?\nWhat would have made it easier?`,
    constructs: "ease, clarity",
  },
};

/** A new activity with its method's starting text, as the method picker adds it. */
export function templateActivity(method: StudyMethod, key: string): StudyActivity {
  return { ...newStudyActivity(method, key), ...METHOD_TEMPLATES[method] };
}
/** Anything changed since the template was added (removing it would lose work). */
export const activityEdited = (activity: StudyActivity) => JSON.stringify(activity) !== JSON.stringify(templateActivity(activity.method, activity.key));

const SHARED_FIELDS = ["title", "instructions", "objective", "criteria"] as const;
/**
 * The shared fields to keep when an activity changes method: what the
 * researcher wrote carries over, but a field that's empty or still the old
 * method's starting text takes the new method's value instead.
 */
function carryShared(from: StudyActivity, target: StudyActivity): Pick<StudyActivity, typeof SHARED_FIELDS[number]> {
  const untouched = (field: typeof SHARED_FIELDS[number]) => !from[field].trim() || from[field] === ((METHOD_TEMPLATES[from.method] as Partial<Record<string, string>>)[field] ?? "");
  return Object.fromEntries(SHARED_FIELDS.map(field => [field, untouched(field) ? target[field] : from[field]])) as Pick<StudyActivity, typeof SHARED_FIELDS[number]>;
}

/** Changing an activity's method keeps what was typed and resets method-specific details to the new method's template. */
export function changeActivityMethod(activity: StudyActivity, method: StudyMethod): StudyActivity {
  if (activity.method === method) return activity;
  const fresh = templateActivity(method, activity.key);
  return { ...fresh, ...carryShared(activity, fresh) };
}

/**
 * Changes an activity's method without losing what was entered for the old
 * one: the old method's details are set aside, and switching back restores
 * them. What was written in the shared fields (title, instructions, objective,
 * criteria) carries over. The set-aside details live only in the editor; they
 * aren't exported.
 */
export function switchActivityMethod(activity: StudyActivity, method: StudyMethod, setAside: Partial<Record<StudyMethod, StudyActivity>> = {}) {
  if (activity.method === method) return { activity, setAside };
  const earlier = setAside[method];
  const target = earlier ? { ...earlier, key: activity.key } : templateActivity(method, activity.key);
  const next = { ...target, ...carryShared(activity, target) };
  return { activity: next, setAside: { ...setAside, [activity.method]: activity } };
}

// ---------- methods run outside Research Studio ----------
/**
 * Moderated sessions, interviews and any custom method. They're part of the
 * study plan (the researcher prompt and the working draft's analysis plan)
 * but aren't Research Studio activities: they have no task, sample-size
 * planner or results in its file.
 */
export type OtherMethodPreset = "moderated" | "interviews" | "custom";
export type OtherMethod = {
  key: string;
  preset: OtherMethodPreset;
  name: string;
  /** What happens in a session, as the researcher would run it. */
  description: string;
  objective: string;
  /** How many people, if the researcher has decided. Nothing is calculated for it. */
  participants: number | null;
  criteria: string;
};
export const MAX_OTHER_METHODS = 6;
export const MAX_OTHER_METHOD_PARTICIPANTS = 1_000;
export const OTHER_METHOD_PRESETS: readonly { id: OtherMethodPreset; label: string; description: string }[] = [
  { id: "moderated", label: "Moderated usability sessions", description: "A facilitator watches each person try tasks live, usually over video, and asks follow-up questions" },
  { id: "interviews", label: "Interviews", description: "One-on-one conversations about how people do something today, what's hard, and what they need" },
  { id: "custom", label: "Custom method", description: "Name and describe any other method: a diary study, field visits, a focus group, an accessibility review…" },
];
/** What happens in each method run outside Research Studio, in a sentence, shown with its illustration. */
export const OTHER_METHOD_PARTICIPANT_VIEW: Readonly<Record<OtherMethodPreset, string>> = {
  moderated: "A facilitator watches each person try tasks live, usually over video, and asks follow-up questions.",
  interviews: "A researcher talks one-on-one with each person about their experience and needs.",
  custom: "Whatever you describe below.",
};
const OTHER_TEMPLATES: Readonly<Record<OtherMethodPreset, Omit<OtherMethod, "key" | "preset">>> = {
  moderated: {
    name: "Moderated usability sessions",
    description: `A facilitator watches each person try to ${TASK_GOAL} with the prototype, asks them to think aloud, and follows up on what they did.`,
    objective: "Why people get stuck, in their own words, and what they expected to happen.",
    participants: null,
    criteria: "Fix the problems seen most often, or that stop people from finishing.",
  },
  interviews: {
    name: "Interviews",
    description: "One-on-one conversations about [the task or topic]: how people handle it today, what's hard about it, and what would help.",
    objective: "People's needs, current workarounds and pain points.",
    participants: null,
    criteria: "Use the needs and pain points heard most often to decide what to design or test next.",
  },
  custom: { name: "", description: "", objective: "", participants: null, criteria: "" },
};
export const otherMethodLabel = (preset: OtherMethodPreset) => OTHER_METHOD_PRESETS.find(item => item.id === preset)?.label ?? "Custom method";
export function newOtherMethod(preset: OtherMethodPreset, key: string): OtherMethod {
  return { key, preset, ...OTHER_TEMPLATES[preset] };
}
export const otherMethodEdited = (method: OtherMethod) => JSON.stringify(method) !== JSON.stringify(newOtherMethod(method.preset, method.key));

/** A key unused by any activity or other method in the plan. */
export function nextPlanKey(prefix: string, used: Iterable<string>): string {
  const taken = new Set(used);
  let n = 1;
  while (taken.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

// ---------- template text left in place ----------
const PLACEHOLDER = /\[[^[\]\n]{1,80}\]/;
/** True when text still holds a template's [bracketed] placeholder. */
export const hasTemplatePlaceholder = (...values: readonly string[]) => values.some(value => PLACEHOLDER.test(value));
export const TEMPLATE_TEXT_PROBLEM = "replace the [bracketed] template text with your own";

export function otherMethodProblems(methods: readonly OtherMethod[]): string[] {
  const problems: string[] = [];
  methods.forEach((method, index) => {
    const add = (detail: string) => problems.push(`Other method ${index + 1}${method.name.trim() ? ` (${clean(method.name, 60)})` : ""}: ${detail}`);
    if (!method.name.trim()) add("name the method");
    if (!method.description.trim()) add("describe what happens");
    if (hasTemplatePlaceholder(method.name, method.description, method.objective, method.criteria)) add(TEMPLATE_TEXT_PROBLEM);
    if (method.participants != null && (method.participants < 1 || method.participants > MAX_OTHER_METHOD_PARTICIPANTS)) add(`the number of people must be between 1 and ${MAX_OTHER_METHOD_PARTICIPANTS}`);
  });
  return problems;
}

function otherMethodLines(method: OtherMethod): string[] {
  return [
    `What happens: ${clean(method.description, 2_000)}`,
    ...(method.objective.trim() ? [`What it should tell us: ${clean(method.objective, 600)}`] : []),
    method.participants != null ? `People: about ${method.participants}` : "People: not decided yet",
    ...(method.criteria.trim() ? [`Good enough, and what we would do: ${clean(method.criteria, 600)}`] : []),
  ];
}
/** The plan's other methods, for the end of the working draft's analysis plan. */
export function otherMethodsAnalysis(methods: readonly OtherMethod[]): string {
  if (!methods.length) return "";
  return `Other methods in this study (not run in Research Studio, and not counted in its sample sizes)\n${methods
    .map((method, index) => [`Other method ${index + 1}: ${clean(method.name, 120) || "Untitled method"}`, ...otherMethodLines(method)].join("\n")).join("\n\n")}`;
}
/** The plan's other methods, for the Researcher Agent prompt. */
export function otherMethodsPrompt(methods: readonly OtherMethod[]): string[] {
  if (!methods.length) return [];
  return [
    "",
    "Other methods (not run in Research Studio):",
    ...methods.flatMap((method, index) => [`${index + 1}. ${clean(method.name, 120) || "Untitled method"}`, ...otherMethodLines(method).map(line => `   - ${line}`)]),
    "",
    "For these methods:",
    "- Recommend how many people to include where it isn't decided, and give a session guide or protocol and an analysis approach for each.",
    "- Say how each fits with the other activities in this plan, and what it can and can't tell the team.",
    "- Do not schedule, recruit, or run anything, and do not claim that any session took place.",
  ];
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
        // Left blank, Research Studio uses the study's prototype (study.prototypeUrl).
        return { activity, task: { ...base, ...(activity.url.trim() ? { prototypeUrl: activity.url.trim() } : {}), ...(signal ? { successSignal: signal } : {}) },
          plan: activity.goal === "measure"
            ? { ...planBase, goal: "measure", measure: signal ? "success" : "self", benchmark: numberOrNull(activity.benchmark), rounds: numberOrNull(activity.rounds), perRound: numberOrNull(activity.perRound) }
            : { ...planBase, margin: hidden(activity.margin, 1, 49, 10), goal: "discover", measure: signal ? "success" : "self", benchmark: hidden(activity.benchmark, 1, 99, null), rounds: numberOrNull(activity.rounds), perRound: numberOrNull(activity.perRound) } };
      case "ab_test": {
        // The control is Design A (design-a), as in the editor and in Research Studio.
        const ordered = chooseControl(activity, activity.controlIndex).designs;
        const variants: RsVariant[] = ordered.map((design, index) => ({ id: `design-${letter(index).toLowerCase()}`, label: clean(design.label, 120) || `Design ${letter(index)}`, prototypeUrl: design.url.trim() }));
        const measure = activity.primary === "success" && signal ? "success" : "self";
        const controlId = variants[0]?.id ?? "";
        return { activity, task: { ...base, experimentId: id, variants, ...(signal ? { successSignal: signal } : {}) },
          experiment: {
            controlId, treatments: {},
            hypotheses: variants.slice(1).map((variant, index) => ({ id: `h${index + 1}`, treatmentId: variant.id, direction: activity.direction, measure, rationale: "" })),
            // Measured success needs a valid success signal; self-report is secondary only when it isn't primary.
            primaryMeasure: measure, secondary: [...(signal ? ["measured"] : []), ...(measure === "success" ? ["self"] : []), "time", "dropout"],
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
          // Three or more options are exploratory: no split, no sample-size claim.
          plan: { ...planBase, split: activity.designs.length === POWERED_PREFERENCE_OPTIONS ? numberOrNull(activity.split) : null, power: activity.power === 0.9 ? 0.9 : 0.8 } };
      case "survey":
        return { activity, task: { ...base, questions: lines(activity.questions, 500).map((text, index) => ({ id: `q${index + 1}`, type: "textarea" as const, text, required: false })) },
          plan: { ...planBase, constructs: clean(activity.constructs, 3_000) } };
    }
  });
}

// ---------- sample size and standard analysis (method-plans.js) ----------
const BENCH_LABEL: Partial<Record<StudyMethod, string>> = { prototype: "task success", tree_test: "task success (correct destination)", first_click: "first-click success (click in a target area)" };
/**
 * n: the analysis denominator the estimate is for (per round for discovery,
 * per design for A/B). recruit: everyone to recruit, allowing for loss.
 */
export type ActivitySize = { n: number | null; total?: number; text: string; recruit?: number; recruitPerRound?: number };

/**
 * Each method's analysis denominator, and who the loss allowance covers: the
 * share of recruits expected not to reach that denominator.
 */
export type Denominator = { what: string; short: string; lost: string };
export function methodDenominator(method: StudyMethod, goal: StudyGoal | undefined, measure: "success" | "self" = "success"): Denominator {
  switch (method) {
    case "ab_test": return {
      what: `every eligible participant randomized to each design; anyone randomized who doesn't finish${measure === "success" ? ", or whose success can't be measured," : ""} stays in it and counts as not successful`,
      short: "eligible participants randomized to each design",
      lost: "screen-outs, ineligible people and technical failures before randomization",
    };
    case "prototype": if (goal === "discover") return {
      what: "people who complete a usable session in each round",
      short: "people completing a usable session, per round",
      lost: "no-shows, screen-outs, technical failures and unusable sessions",
    };
    // falls through: measuring a prototype task counts starters, like tree tests and first clicks
    case "tree_test":
    case "first_click": return {
      what: "everyone who starts the activity; anyone who starts but doesn't finish stays in it and counts as not successful",
      short: "people who start the activity",
      lost: "recruits who never start it: screen-outs and technical failures",
    };
    case "card_sort": return { what: "completed sorts", short: "completed sorts", lost: "recruits who don't complete the sort" };
    case "preference": return { what: "people who choose an option", short: "people who choose an option", lost: "recruits who don't make a choice" };
    case "survey": return { what: "completed responses", short: "completed responses", lost: "recruits who don't complete the survey" };
  }
}
const allowanceSentence = (lossPercent: number, d: Denominator) =>
  `allowing for ${lossPercent}% of recruits not reaching the analysis (${d.lost})`;
/** "Recruit about 125 (100 ÷ (1 − 0.20)), allowing for 20% of recruits not reaching the analysis (…)." Applied once, to the final target. */
export const NO_LOSS_ALLOWANCE_TEXT = `How many to recruit appears once the loss allowance is a whole number from 0 to ${MAX_LOSS_ALLOWANCE}%.`;
/** The loss allowance when it's usable; null when it's blank or out of range, so no recruit number is shown. */
export const usableLoss = (lossPercent: number | null | undefined): number | null => lossAllowanceProblem(lossPercent) ? null : lossPercent!;
export function recruitText(n: number, lossPercent: number | null | undefined, d: Denominator): string {
  if (usableLoss(lossPercent) == null) return NO_LOSS_ALLOWANCE_TEXT;
  if (!lossPercent) return `No loss allowance is set, so recruit ${n}.`;
  return `Recruit about ${allowingForLoss(n, lossPercent)} (${n} ÷ (1 − ${(lossPercent / 100).toFixed(2)})), ${allowanceSentence(lossPercent, d)}.`;
}

export function activitySize(task: ResearchStudioTask, ap: ResearchStudioActivityPlan, lossPercent: number | null | undefined = DEFAULT_LOSS_ALLOWANCE): ActivitySize {
  const loss = usableLoss(lossPercent);
  const recruitFor = (n: number) => loss == null ? undefined : allowingForLoss(n, loss);
  const m = task.method, margin = (numberOrNull(ap.margin) || 10) / 100;
  const p = numberOrNull(ap.benchmark) != null ? Math.min(0.95, Math.max(0.05, numberOrNull(ap.benchmark)! / 100)) : 0.5;
  const d = methodDenominator(m, ap.goal, ap.measure);
  const denominator = `Analysis denominator: ${d.what}.`;
  if (m === "prototype" && ap.goal === "discover") {
    const per = Math.max(1, numberOrNull(ap.perRound) || 6), rounds = Math.max(1, numberOrNull(ap.rounds) || 2);
    const perRound = loss == null ? undefined : allowingForLoss(per, loss);
    const recruit = loss == null ? NO_LOSS_ALLOWANCE_TEXT : loss && perRound ? `Recruit about ${perRound} per round (${per} ÷ (1 − ${(loss / 100).toFixed(2)})), ${perRound * rounds} in total, ${allowanceSentence(loss, d)}.` : `No loss allowance is set, so recruit ${per} per round (${per * rounds} in total).`;
    return { n: per, total: per * rounds, recruit: perRound == null ? undefined : perRound * rounds, recruitPerRound: perRound,
      text: `${per} people per round, ${rounds} round${rounds === 1 ? "" : "s"} (${per * rounds} in total), fixing problems between rounds. ${denominator} ${recruit} Small rounds find many of the most common problems; problems few people meet need more participants. Results describe problems, not rates for the whole population.` };
  }
  if (m === "card_sort" && ap.goal === "explore") {
    const n = Math.max(5, numberOrNull(ap.target) || 20);
    return { n, recruit: recruitFor(n), text: `About ${n} completed sorts. For open card sorts, 15–30 is common practice; similarity scores tend to settle at around 15–20 participants (Tullis & Wood, 2004). ${denominator} ${recruitText(n, lossPercent, d)}` };
  }
  if (m === "preference") {
    if ((task.variants?.length ?? 0) !== POWERED_PREFERENCE_OPTIONS) {
      return { n: null, text: "Exploratory: with three or more options this plan makes no sample-size claim and declares no winner. Report the share choosing each option with intervals." };
    }
    const split = numberOrNull(ap.split) != null ? numberOrNull(ap.split)! / 100 : null, power = Number(ap.power) || 0.8, n = split ? sampleSizeVsHalf(split, { power }) : null;
    return n && split ? { n, recruit: recruitFor(n), text: `Estimate: about ${n} people choosing an option, to tell a ${Math.round(split * 100)}/${100 - Math.round(split * 100)} split from 50/50 with ${Math.round(power * 100)}% power (two-sided, 95%). ${denominator} ${recruitText(n, lossPercent, d)} "No preference" answers need more people.` } : { n: null, text: "No estimate yet. Enter the smallest split worth finding (51–95%)." };
  }
  const n = sampleSizeForMargin(p, margin);
  if (!n) return { n: null, text: "No estimate yet. Enter a precision between 1 and 49 points." };
  const what = m === "card_sort" ? "the share placing a card in a category" : m === "survey" ? "a percentage answer" : `${BENCH_LABEL[m] || "the rate"}`;
  const extra = m === "tree_test" ? " Many teams recruit about 50 per tree." : "";
  return { n, recruit: recruitFor(n), text: `Estimate: about ${n} people in the analysis, so that ${what} near ${Math.round(p * 100)}% is estimated to within about ±${Math.round(margin * 100)} points (95% interval). ${denominator}${extra} ${recruitText(n, lossPercent, d)}` };
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
  if (m === "preference" && (task.variants?.length ?? 0) !== POWERED_PREFERENCE_OPTIONS) return "Exploratory: report the share choosing each option with 95% Wilson intervals and summarise reasons from follow-up answers. Don't declare a winner or claim a difference between options. Preference is not performance. Presentation order is randomised.";
  if (m === "preference") return "Report the share choosing each option with 95% Wilson intervals, and whether the interval for the leading option excludes 50%. Summarise reasons from follow-up answers. Preference is not performance: compare with task results where available. Presentation order is randomised.";
  if (m === "survey") return `Summarise each question: distribution and median for scales, counts and percentages with 95% intervals for choices, and themes for open text.${ap.constructs?.trim() ? ` Questions are grouped by what they measure: ${ap.constructs.trim()}.` : ""}`;
  return "";
}

// ---------- A/B experiments (plan.js) ----------
const PRIMARY = { success: "Task success (success signal)", self: "Self-reported completion" };
const SECONDARY: Record<string, string> = { measured: "Success among finishers with success measured", self: "Self-reported completion", time: "Active time on task", success_time: "Time for successful attempts", clicks: "Clicks in the design", dropout: "Drop-out by design", followup: "Follow-up question answers" };

export function plannedSize(e: ResearchStudioExperimentPlan, designs: number) {
  return planStudy({ baseline: Number(e.baseline) / 100, difference: Number(e.difference) / 100, designs, power: Number(e.power) || 0.8, direction: e.hypotheses[0]?.direction ?? "higher" });
}
const pct = (value: number) => `${Math.round(value * 1000) / 10}%`;
// Letters follow position, with the control first: the same as Research Studio.
const designLabel = (task: ResearchStudioTask, id: string) => {
  const variants = task.variants ?? [];
  const i = variants.findIndex(v => v.id === id);
  return i < 0 ? id : `Design ${letter(i)} (${variants[i].label})`;
};
export function hypothesisSentence(task: ResearchStudioTask, e: ResearchStudioExperimentPlan, h: ResearchStudioExperimentPlan["hypotheses"][number]): string {
  const control = designLabel(task, e.controlId), treat = designLabel(task, h.treatmentId);
  const rate = h.measure === "self" ? "self-reported completion rate" : "task success rate";
  return h.direction === "different"
    ? `Compared with ${control}, the control, ${treat} will have a different ${rate} (higher or lower). Tested two-sided.`
    : `Compared with ${control}, the control, ${treat} will have a ${h.direction} ${rate}. Planned for that direction; tested two-sided.`;
}
export function sizeText(e: ResearchStudioExperimentPlan, designs: number, lossPercent: number | null | undefined = DEFAULT_LOSS_ALLOWANCE): string {
  const s = plannedSize(e, designs);
  if (!s) return "No estimate yet. Enter an expected control rate (1–99%) and a difference whose planned target stays between 0% and 100% in the planning direction.";
  const why = e.hypotheses[0]?.direction === "different" ? " (the harder of a rise or a drop to detect)" : "";
  const d = methodDenominator("ab_test", undefined, e.primaryMeasure);
  return `Estimate: about ${s.perDesign} randomized eligible participants per design (${s.total} in total) give ${Math.round(s.power * 100) === 80 ? "an" : "a"} ${Math.round(s.power * 100)}% chance of detecting a change from ${e.baseline}% to ${Math.round(s.target * 100)}%${why} with a two-sided test at ${pct(s.confidence)} confidence. Analysis denominator: ${d.what}, so the expected control rate should already include them. ${recruitText(s.total, lossPercent, d)} This is a planning estimate, not a guarantee.`;
}
export function abAnalysis(task: ResearchStudioTask, e: ResearchStudioExperimentPlan, experiments = 1, lossPercent: number | null | undefined = DEFAULT_LOSS_ALLOWANCE): string {
  const n = task.variants?.length ?? 0, s = plannedSize(e, n);
  const control = designLabel(task, e.controlId), measure = PRIMARY[e.primaryMeasure] || PRIMARY.success;
  const sec = (e.secondary || []).map(k => SECONDARY[k]).filter(Boolean);
  return [
    `${experiments > 1 ? `Experiment ${task.experimentId || task.id}. ` : ""}Primary analysis: compare ${n === 2 ? "the alternative" : "each treatment design"} with ${control}, the control, on ${measure.toLowerCase()}. Each design's denominator is every eligible participant randomized to it. Anyone randomized who drops out${e.primaryMeasure === "success" ? " or whose success cannot be measured" : ""} counts as not successful; nobody is removed after randomization. People screened out or lost to technical failures before randomization are in no denominator.`,
    `Report each design's rate with a 95% Wilson score interval and the difference from the control with a two-sided Newcombe hybrid score interval${n > 2 ? `, at ${pct(1 - 0.05 / (n - 1))} (Bonferroni) because ${n - 1} treatments are each compared with the control` : " at 95%"}. An interval that excludes zero is reported as a clear difference; an interval that includes zero is reported as inconclusive, not as evidence that the designs perform the same. No winner is declared automatically: the team judges whether a difference matters in practice.`,
    s ? `Target sample (estimate): ${s.perDesign} randomized eligible participants per design (${s.total} in total) to detect a change from ${e.baseline}% to ${Math.round(s.target * 100)}% with ${Math.round(s.power * 100)}% power. ${recruitText(s.total, lossPercent, methodDenominator("ab_test", undefined, e.primaryMeasure))}` : "Target sample: to be set.",
    `Stopping rule: ${e.stoppingRule?.trim() || "not set yet"}`,
    "Before interpreting outcomes, check: group sizes (sample-ratio check), drop-out by design, success-tracking coverage by design and device mix. Any problem is reported with the results.",
    sec.length ? `Secondary measures (${sec.join("; ").toLowerCase()}) are reported descriptively with intervals for context and are not used to decide between designs.` : "",
  ].filter(Boolean).join("\n");
}

/** What the activity editor shows: sample size and standard analysis, as Research Studio computes them. */
export type ActivitySummary = { size: string; analysis: string; recruit: number | null; hypotheses: string[]; target: string | null; recruitLabel: string | null; denominator: Denominator | null;
  /** The analysis target as Research Studio's sample-size summary shows it: before the loss allowance, all rounds or designs together. */
  plannerN: number | null };
export function summarizeActivities(activities: readonly StudyActivity[], lossPercent: number | null | undefined = DEFAULT_LOSS_ALLOWANCE): { items: ActivitySummary[]; largest: { title: string; n: number } | null } {
  const converted = convertActivities(activities);
  const experiments = converted.filter(item => item.experiment).length;
  const loss = usableLoss(lossPercent);
  let largest: { title: string; n: number } | null = null;
  const items = converted.map((item, index) => {
    const name = item.task.title || `Activity ${index + 1}`;
    let summary: ActivitySummary;
    if (item.experiment) {
      const s = plannedSize(item.experiment, item.task.variants?.length ?? 0);
      summary = { size: sizeText(item.experiment, item.task.variants?.length ?? 0, lossPercent), analysis: abAnalysis(item.task, item.experiment, experiments, lossPercent), recruit: s && loss != null ? allowingForLoss(s.total, loss) : null,
        hypotheses: item.experiment.hypotheses.map(h => hypothesisSentence(item.task, item.experiment!, h)),
        target: s ? `${s.perDesign} per design (${s.total} in total)` : null, recruitLabel: s && loss != null ? `about ${allowingForLoss(s.total, loss)}` : null,
        denominator: methodDenominator("ab_test", undefined, item.experiment.primaryMeasure), plannerN: s?.total ?? null };
    } else {
      const s = activitySize(item.task, item.plan!, lossPercent);
      const discovery = item.task.method === "prototype" && item.plan!.goal === "discover";
      summary = { size: s.text, analysis: activityAnalysis(item.task, item.plan!), recruit: s.recruit ?? null, hypotheses: [],
        target: s.n == null ? null : discovery ? `${s.n} per round (${s.total} in total)` : String(s.n),
        recruitLabel: s.n == null || s.recruit == null ? null : discovery ? `about ${s.recruitPerRound} per round (${s.recruit} in total)` : `about ${s.recruit}`,
        denominator: s.n == null ? null : methodDenominator(item.task.method, item.plan!.goal, item.plan!.measure), plannerN: s.n == null ? null : s.total ?? s.n };
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
const NO_ACTIVITY_PROBLEM = "Add at least one study activity";
const NO_STUDIO_ACTIVITY_PROBLEM = "Add at least one Research Studio activity: other methods are listed in the working draft's plan, but Research Studio doesn't run them";
export function researchStudioFileProblems(title: string, activities: readonly StudyActivity[], { studyPrototypeUrl = "" }: { studyPrototypeUrl?: string } = {}): string[] {
  const problems: string[] = [];
  if (slugify(title, "").length < 3) problems.push("Add a working title of at least three letters or numbers");
  if (!activities.length) problems.push(NO_ACTIVITY_PROBLEM);
  activities.forEach((activity, index) => {
    const name = `Activity ${index + 1} (${methodLabel(activity.method)})`;
    const add = (detail: string) => problems.push(`${name}: ${detail}`);
    if (!activity.instructions.trim()) add("add instructions for participants");
    // Starting text left as it was would reach participants (instructions, questions) or the plan.
    if (hasTemplatePlaceholder(activity.title, activity.instructions, activity.objective, activity.criteria, activity.questions, activity.constructs,
      activity.cards, activity.categories, activity.stoppingRule, ...activity.designs.map(design => design.label))) add(TEMPLATE_TEXT_PROBLEM);
    // Stricter than Research Studio on purpose: an invalid signal would otherwise be left out of the file silently.
    const signal = activity.successSignal.trim();
    if (signal && !SLUG.test(signal)) add("the success signal can use only lowercase letters, numbers and hyphens");
    // Left blank, a prototype activity uses the study's prototype.
    if (activity.method === "prototype" && (activity.url.trim() || !studyPrototypeUrl)) {
      const p = studyUrlProblem(activity.url);
      if (p) add(p === "needs a link" ? "the prototype needs a link, or choose a study prototype" : `the prototype ${p}`);
    }
    if (activity.method === "first_click") { const p = studyUrlProblem(activity.url); if (p) add(`the screenshot ${p}`); }
    if (activity.method === "ab_test") {
      if (activity.designs.length !== AB_DESIGNS) add("use exactly two designs: a control and one alternative");
      if (activity.primary === "success" && !signal) add("add a success signal, or choose self-reported completion as the primary outcome");
      const baseline = activity.baseline, difference = activity.difference;
      if (baseline == null || baseline < 1 || baseline > 99) add("enter the expected control rate (1–99%)");
      if (difference == null || difference < 1 || difference > 98) add("enter the smallest difference worth detecting (1–98 points)");
      if (baseline != null && difference != null && baseline >= 1 && baseline <= 99 && difference >= 1 && difference <= 98
        && !planStudy({ baseline: baseline / 100, difference: difference / 100, designs: AB_DESIGNS, power: activity.power, direction: activity.direction })) {
        add(activity.direction === "higher" ? `a rise of ${difference} points from ${baseline}% would pass 100%: lower the difference or change the planning direction`
          : activity.direction === "lower" ? `a drop of ${difference} points from ${baseline}% would fall below 0%: lower the difference or change the planning direction`
          : "the difference is too large for this control rate");
      }
      if (!activity.stoppingRule.trim()) add("add a stopping rule");
      else if (!activity.stoppingRuleConfirmed) add("review the stopping rule and confirm it");
    }
    if (activity.method === "preference" && activity.designs.length === POWERED_PREFERENCE_OPTIONS && activity.split == null) add("enter the smallest split worth finding (51–95%)");
    if (activity.method === "prototype" && activity.goal === "discover" && (!activity.perRound || !activity.rounds)) add("enter the people per round and the number of rounds");
    if (activity.method === "prototype" && activity.goal === "measure" && activity.margin == null) add("enter the precision (± points)");
    if ((activity.method === "tree_test" || activity.method === "first_click") && activity.margin == null) add("enter the precision (± points)");
    if (activity.method === "card_sort" && activity.goal !== "explore" && activity.margin == null) add("enter the precision (± points)");
    if (activity.method === "card_sort" && activity.goal === "explore" && activity.target == null) add("enter the target number of participants");
    if (activity.method === "ab_test" || activity.method === "preference") {
      const what = activity.method === "ab_test" ? "design" : "option";
      if (activity.method === "preference" && activity.designs.length < 2) add(`add at least two ${what}s`);
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
      if (field === "split" && activity.designs.length !== POWERED_PREFERENCE_OPTIONS) continue;
      const value = activity[field] as number | null;
      if (value != null && (value < lo || value > hi)) add(`${label.toLowerCase()} must be between ${lo} and ${hi}`);
    }
  });
  return problems;
}

// ---------- everything needed before a working draft can be saved ----------
export type StudyDraftInput = {
  title: string;
  decision?: string;
  question?: string;
  participants?: string;
  setup: StudySetup;
  activities: readonly StudyActivity[];
  /** Methods run outside Research Studio: listed in the working draft's analysis plan. */
  otherMethods?: readonly OtherMethod[];
  /** "existing" with no prototype chosen yet blocks the draft. */
  prototype?: { mode: "none" } | { mode: "existing"; url: string | null };
};
export function studyDraftProblems(input: StudyDraftInput): string[] {
  const problems: string[] = [];
  if (!input.decision?.trim()) problems.push("Add the decision this study should inform");
  if (!input.question?.trim()) problems.push("Add the research question");
  if (!input.participants?.trim()) problems.push("Add the people to learn from (intended participants)");
  const loss = lossAllowanceProblem(input.setup.lossAllowance);
  if (loss) problems.push(loss);
  let studyPrototypeUrl = "";
  if (input.prototype?.mode === "existing") {
    if (!input.prototype.url) problems.push("Choose an existing prototype, or select No prototype");
    else if (studyUrlProblem(input.prototype.url)) problems.push("The chosen prototype's preview link can't be used in Research Studio (it must be HTTPS). Choose another prototype");
    else studyPrototypeUrl = input.prototype.url;
  }
  const others = input.otherMethods ?? [];
  const fileProblems = researchStudioFileProblems(input.title, input.activities, { studyPrototypeUrl })
    // Other methods alone don't make a Research Studio study.
    .map(problem => problem === NO_ACTIVITY_PROBLEM && others.length ? NO_STUDIO_ACTIVITY_PROBLEM : problem);
  // Plans Research Studio would change on import are not saved (research-studio-compat.ts).
  const draft = buildResearchStudioWorkingCopy({ title: input.title, setup: input.setup, activities: input.activities, otherMethods: others, prototypeUrl: studyPrototypeUrl });
  const changes = researchStudioImportChanges(draft as unknown as WorkingDraft).map(change => {
    const index = draft.tasks.findIndex(task => task.id === change.taskId);
    return `Activity ${index + 1} (${methodLabel(input.activities[index].method)}): ${change.problem}`;
  });
  const texts = studioPlanTexts(input.setup, input.activities, others);
  if (texts.recruitment.length > RS_PARTICIPANT_FIELD_LIMIT || texts.exclusions.length > RS_PARTICIPANT_FIELD_LIMIT) changes.push(`The recruitment summary is longer than Research Studio's ${RS_PARTICIPANT_FIELD_LIMIT.toLocaleString("en-US")}-character field. Use fewer activities or shorter titles`);
  if (texts.analysis.length > RS_ANALYSIS_LIMIT) changes.push(`The analysis plan is longer than Research Studio's ${RS_ANALYSIS_LIMIT.toLocaleString("en-US")}-character field. Use fewer activities`);
  // Title first, then the brief, then activities: the order the form reads in.
  const isTitle = (problem: string) => problem.startsWith("Add a working title");
  return [...fileProblems.filter(isTitle), ...problems, ...fileProblems.filter(problem => !isTitle(problem)), ...otherMethodProblems(others), ...changes];
}

/**
 * Rechecks the chosen prototype against the latest list of ready prototypes
 * (published, with a live preview) immediately before export. Fails closed.
 */
export function recheckStudyPrototype<T extends { id: string; previewUrl?: string | null }>(selectedId: string, latestReady: readonly T[]):
  { ok: true; prototype: T; url: string } | { ok: false; message: string } {
  const prototype = latestReady.find(item => item.id === selectedId);
  const url = prototype?.previewUrl?.trim() ?? "";
  if (!prototype || !url) return { ok: false, message: "That prototype is no longer available or published, so the working draft wasn't saved. Choose another prototype, or select No prototype." };
  if (studyUrlProblem(url)) return { ok: false, message: "That prototype's preview link can't be used in Research Studio (it must be HTTPS), so the working draft wasn't saved. Choose another prototype." };
  return { ok: true, prototype, url };
}

/** Problems that weren't there before, in order, for an assistive-technology announcement. */
export function newProblems(previous: readonly string[], current: readonly string[]): string[] {
  const before = new Set(previous);
  return current.filter(problem => !before.has(problem));
}
export function saveBlockedReason(problems: readonly string[]): string | null {
  if (!problems.length) return null;
  return `Save is unavailable until ${problems.length === 1 ? "1 item is" : `${problems.length} items are`} fixed: ${problems[0]}${problems.length > 1 ? `, and ${problems.length - 1} more listed above` : ""}.`;
}

// ---------- what Research Studio shows about recruitment and analysis ----------
export const RS_PARTICIPANT_FIELD_LIMIT = 2_000;
export const RS_ANALYSIS_LIMIT = 20_000;
/**
 * The plan's recruitment, exclusions and analysis as text for Research
 * Studio's participant and analysis fields, so the loss assumption, each
 * analysis denominator and the recruitment targets stay visible after import.
 */
/**
 * The plan text Research Studio shows in its Participants and Analysis plan
 * fields. Its plan editor shows Recruitment and Exclusions in one-line input
 * boxes (line breaks are dropped and long text is cut off from view), so each is
 * one short line. The per-activity detail, and how to read Research Studio's
 * own sample-size numbers, go in the analysis plan, which it shows as a
 * multi-line box and in full in the plan document.
 */
export function studioPlanTexts(setup: StudySetup, activities: readonly StudyActivity[], otherMethods: readonly OtherMethod[] = []): { recruitment: string; exclusions: string; analysis: string } {
  const loss = usableLoss(setup.lossAllowance);
  const summary = summarizeActivities(activities, setup.lossAllowance);
  const converted = convertActivities(activities);
  const title = (index: number) => converted[index].task.title || `Activity ${index + 1}`;
  const name = (index: number) => `${index + 1}. ${title(index)} (${methodLabel(converted[index].task.method)})`;
  // Research Studio's largest need: the first activity with the largest analysis target, as its sampleSummary picks it.
  const plannerTop = summary.items.reduce<number | null>((top, item, index) => item.plannerN && (top == null || item.plannerN > summary.items[top].plannerN!) ? index : top, null);
  const planner = plannerTop == null ? null : summary.items[plannerTop].plannerN!;
  const recruitTop = summary.items.reduce<number | null>((top, item, index) => item.recruit && (top == null || item.recruit > summary.items[top].recruit!) ? index : top, null);
  const starterMethods = converted.some(item => ["tree_test", "first_click"].includes(item.task.method) || (item.task.method === "prototype" && item.plan?.goal !== "discover"));
  const detail = "Each activity's target and analysis denominator are in the analysis plan.";
  let recruitment: string;
  if (planner == null) recruitment = `Recruitment target: no activity has a sample-size target. ${detail}`;
  else if (loss == null || recruitTop == null) recruitment = `Recruitment target: not set until the loss allowance is a whole number from 0 to ${MAX_LOSS_ALLOWANCE}%. ${detail}`;
  else {
    const recruit = summary.items[recruitTop].recruit!;
    const same = recruitTop === plannerTop;
    recruitment = [
      `Recruit about ${recruit} people for the largest need (${title(recruitTop)}), ${loss ? `allowing for ${loss}% of recruits lost before randomization or start` : "with no loss allowance"}. Everyone takes every activity.`,
      loss
        ? same
          ? `Research Studio's sample-size summary shows about ${planner} "plus extra for drop-out": that's the analysis target, and the ${recruit} here already includes the extra.`
          : `Research Studio's sample-size summary shows about ${planner} "plus extra for drop-out" for its largest analysis target (${title(plannerTop!)}); with the extra included, ${title(recruitTop)} needs the most recruits (${recruit}).`
        : `Research Studio's sample-size summary shows the same ${planner} "plus extra for drop-out"; with no loss allowance, none is added.`,
      detail,
    ].join(" ");
  }
  const methods = new Set(converted.map(item => item.task.method));
  const exclusions = [
    `${methods.has("ab_test") ? "Before randomization or start" : "Before an activity starts"}: screen-outs, ineligible people, no-shows and technical failures are in no denominator${loss ? " (the loss allowance covers them)" : ""}.`,
    methods.has("ab_test") || starterMethods ? `After ${methods.has("ab_test") ? "randomization or " : ""}start, nobody is excluded: anyone who doesn't finish counts as not successful.` : "",
    converted.some(item => item.task.method === "prototype" && item.plan?.goal === "discover") ? "Discovery rounds use completed, usable sessions." : "",
    ["card_sort", "preference", "survey"].some(method => methods.has(method as StudyMethod)) ? "Card sorts, preference tests and surveys use completed responses." : "",
  ].filter(Boolean).join(" ");
  const sampleSize = [
    "Sample size and recruitment",
    loss == null ? `Loss assumption: not set. ${NO_LOSS_ALLOWANCE_TEXT}` : loss ? `Loss assumption: ${loss}% of recruits won't reach each activity's analysis denominator, so each target is recruited as n ÷ (1 − ${(loss / 100).toFixed(2)}).` : "Loss assumption: none. Each target is recruited as it is.",
    ...(planner != null ? [`Research Studio's sample-size summary and size text show each analysis target "plus extra for drop-out"; the recruit numbers here already include that extra.`] : []),
    ...(starterMethods ? [`Research Studio's size text calls prototype-task, tree-test and first-click targets "people completing the activity": read them as people who start, as its standard analysis does.`] : []),
    ...summary.items.map((item, index) => item.target && item.denominator
      ? `${name(index)}: analysis denominator ${item.denominator.short}; target ${item.target}${item.plannerN != null && item.target !== String(item.plannerN) ? `, shown by Research Studio as ${item.plannerN}` : ""}; ${item.recruitLabel ? `recruit ${item.recruitLabel}` : "recruit number not set"}.`
      : `${name(index)}: exploratory, with no sample-size target.`),
  ].join("\n");
  const analysis = [sampleSize, ...converted.map((item, index) => {
    const d = methodDenominator(item.task.method, item.plan?.goal, item.experiment?.primaryMeasure ?? item.plan?.measure);
    return [name(index), summary.items[index].analysis, ...(item.experiment ? [] : [`Analysis denominator: ${d.what}.`])].join("\n");
  }), ...(otherMethods.length ? [otherMethodsAnalysis(otherMethods)] : [])].join("\n\n");
  return { recruitment, exclusions, analysis };
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
  /** Methods run outside Research Studio: described at the end of the analysis plan. */
  otherMethods?: readonly OtherMethod[];
  /** The chosen existing prototype's live preview. Prototype activities left blank use it. */
  prototypeUrl?: string;
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
  const texts = studioPlanTexts(context.setup, context.activities, context.otherMethods ?? []);
  return {
    schemaVersion: 3,
    id: slugify(context.title, "research-study").slice(0, 64),
    version: "1.0.0",
    title: clean(context.title, 160),
    description: "",
    prototypeUrl: (context.prototypeUrl ?? "").trim(),
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
      participants: { audience: clean(context.participants, 2_000), recruitment: texts.recruitment, exclusions: texts.exclusions, devices: desktop ? "desktop" : "any" },
      experiments: Object.fromEntries(converted.filter(item => item.experiment).map(item => [item.task.experimentId!, item.experiment!])),
      activities: Object.fromEntries(converted.filter(item => item.plan).map(item => [item.task.id, item.plan!])),
      // Replaces Research Studio's standard plan, which doesn't carry these denominators.
      analysis: texts.analysis,
      decisions: clean(context.decision, 5_000),
      locked: null,
      changes: [],
    },
  };
}

export function researchStudioFileName(title: string): string {
  return `${slugify(title, "research-study").slice(0, 64)}.working-draft.json`;
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
  const summary = summarizeActivities(activities, setup.lossAllowance);
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
    // The largest need already includes the loss allowance; it is never added twice.
    ...(summary.largest ? [`Everyone takes every activity, so recruit for the largest need: about ${summary.largest.n} people (${summary.largest.title}), ${setup.lossAllowance ? `which already allows for ${setup.lossAllowance}% loss` : "with no loss allowance"}.`] : []),
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
