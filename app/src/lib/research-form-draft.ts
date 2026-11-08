// What a research form keeps as a draft on this device, and how a saved draft
// is checked before it's put back. Only what the researcher typed or chose is
// kept: never Research Hub evidence, Hub metadata or design guidance (those are
// fetched and reviewed again), and prototypes only by id (rechecked on restore).
import { DEFAULT_STUDY_SETUP, MAX_STUDY_ACTIVITIES, newStudyActivity, STUDY_COLLECTIONS, STUDY_METHODS, type StudyActivity, type StudySetup } from "./research-methods.ts";
import type { ResearchFieldId, ResearchTaskKind } from "./research-studio.ts";

export const RESEARCH_FORM_DRAFT_VERSION = 1;
export type DraftPrototypeMode = "none" | "new" | "existing";

export type ResearchFormDraft = {
  version: typeof RESEARCH_FORM_DRAFT_VERSION;
  kind: ResearchTaskKind;
  title: string;
  answers: Partial<Record<ResearchFieldId, string>>;
  activities: StudyActivity[];
  setup: StudySetup;
  prototypeMode: DraftPrototypeMode;
  prototypePurpose: string;
  researchFindings: string;
  /** A ready prototype chosen for the study; rechecked before it's used again. */
  selectedPrototypeId: string | null;
  /** A prototype workspace this form created, and the prompt it was created with. */
  createdPrototypeId: string | null;
  createdPrototypePrompt: string | null;
};

const FIELD_IDS: readonly ResearchFieldId[] = ["decision", "question", "participants", "method", "inputs", "focus", "constraints"];
const MAX_TEXT = 20_000;
const text = (value: unknown, max = MAX_TEXT) => typeof value === "string" ? value.slice(0, max) : "";
const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null;

/** The draft form of what's on screen. */
export function researchFormDraft(form: Omit<ResearchFormDraft, "version">): ResearchFormDraft {
  return { version: RESEARCH_FORM_DRAFT_VERSION, ...form };
}

/** Nothing worth keeping: an untouched form. */
export function researchFormDraftEmpty(draft: ResearchFormDraft): boolean {
  return !draft.title.trim()
    && FIELD_IDS.every(field => !(draft.answers[field] ?? "").trim())
    && !draft.activities.length
    && JSON.stringify(draft.setup) === JSON.stringify(DEFAULT_STUDY_SETUP)
    && draft.prototypeMode === "none"
    && !draft.prototypePurpose.trim()
    && !draft.researchFindings.trim()
    && !draft.selectedPrototypeId
    && !draft.createdPrototypeId;
}

// Each saved activity is laid over a fresh one of its method, field by field,
// keeping only values of the expected type, so an old or damaged draft can't
// put something the activity editor doesn't expect on screen.
function activity(value: unknown, index: number): StudyActivity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const saved = value as Record<string, unknown>;
  const method = STUDY_METHODS.find(item => item.id === saved.method)?.id;
  if (!method) return null;
  const key = id(saved.key) ?? `activity-${index + 1}`;
  const fresh = newStudyActivity(method, key) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...fresh };
  for (const [field, initial] of Object.entries(fresh)) {
    if (field === "key" || field === "method") continue;
    const candidate = saved[field];
    if (field === "designs") {
      if (Array.isArray(candidate)) out.designs = candidate.slice(0, 8).filter(item => item && typeof item === "object")
        .map(item => ({ label: text((item as Record<string, unknown>).label, 200), url: text((item as Record<string, unknown>).url, 2_000) }));
      continue;
    }
    if (typeof initial === "string" && typeof candidate === "string") out[field] = candidate.slice(0, MAX_TEXT);
    else if (typeof initial === "boolean" && typeof candidate === "boolean") out[field] = candidate;
    else if ((typeof initial === "number" || initial === null) && (candidate === null || (typeof candidate === "number" && Number.isFinite(candidate)))) out[field] = candidate;
  }
  // Enumerated fields keep their default unless the saved value is one the editor offers.
  for (const [field, allowed] of [["goal", ["discover", "measure", "explore", "validate"]], ["primary", ["success", "self"]], ["direction", ["higher", "lower", "different"]], ["sortMode", ["open", "closed", "hybrid"]]] as const) {
    if (!(allowed as readonly string[]).includes(out[field] as string)) out[field] = fresh[field];
  }
  return out as unknown as StudyActivity;
}

function setup(value: unknown): StudySetup {
  if (!value || typeof value !== "object") return DEFAULT_STUDY_SETUP;
  const saved = value as Record<string, unknown>;
  return {
    collection: STUDY_COLLECTIONS.some(item => item.id === saved.collection) ? saved.collection as StudySetup["collection"] : DEFAULT_STUDY_SETUP.collection,
    devices: saved.devices === "any" || saved.devices === "desktop" ? saved.devices : DEFAULT_STUDY_SETUP.devices,
    lossAllowance: saved.lossAllowance === null || (typeof saved.lossAllowance === "number" && Number.isFinite(saved.lossAllowance)) ? saved.lossAllowance as number | null : DEFAULT_STUDY_SETUP.lossAllowance,
  };
}

/** A saved draft for this form, checked field by field, or null when it isn't one. */
export function parseResearchFormDraft(value: unknown, kind: ResearchTaskKind): ResearchFormDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const saved = value as Record<string, unknown>;
  if (saved.version !== RESEARCH_FORM_DRAFT_VERSION || saved.kind !== kind) return null;
  const answers: Partial<Record<ResearchFieldId, string>> = {};
  if (saved.answers && typeof saved.answers === "object") {
    for (const field of FIELD_IDS) {
      const answer = (saved.answers as Record<string, unknown>)[field];
      if (typeof answer === "string" && answer) answers[field] = answer.slice(0, MAX_TEXT);
    }
  }
  const study = kind === "study";
  const activities = study && Array.isArray(saved.activities)
    ? saved.activities.slice(0, MAX_STUDY_ACTIVITIES).map(activity).filter((item): item is StudyActivity => !!item)
    : [];
  // Two activities can't share a key (the editor tells them apart by it).
  const seen = new Set<string>();
  for (const [index, item] of activities.entries()) {
    if (seen.has(item.key)) { let n = index + 1; while (seen.has(`activity-${n}`)) n++; item.key = `activity-${n}`; }
    seen.add(item.key);
  }
  const prototypeMode: DraftPrototypeMode = study && (saved.prototypeMode === "new" || saved.prototypeMode === "existing") ? saved.prototypeMode : "none";
  return researchFormDraft({
    kind,
    title: text(saved.title, 200),
    answers,
    activities,
    setup: study ? setup(saved.setup) : DEFAULT_STUDY_SETUP,
    prototypeMode,
    prototypePurpose: study ? text(saved.prototypePurpose, 1_000) : "",
    researchFindings: study ? text(saved.researchFindings, 4_000) : "",
    selectedPrototypeId: study ? id(saved.selectedPrototypeId) : null,
    createdPrototypeId: study ? id(saved.createdPrototypeId) : null,
    createdPrototypePrompt: study && id(saved.createdPrototypeId) ? text(saved.createdPrototypePrompt) || null : null,
  });
}
