import {
  buildStudyPrototypePrompt,
  RESEARCH_TASKS,
  type ResearchFieldId,
  type ResearchTaskKind,
} from "./research-studio.ts";
import { changeSortMode, newStudyActivity, type StudyActivity } from "./research-methods.ts";

/**
 * Synthetic study activities. Links use the reserved example.com domain. The
 * A/B stopping rule is written but not yet confirmed, so the preview shows the
 * confirmation step; the prototype task has no link of its own and uses the
 * study's prototype.
 */
export function researchPreviewActivities(): StudyActivity[] {
  return [
    { ...newStudyActivity("ab_test", "preview-ab"), title: "Make a one-time payment", instructions: "Pay a balance of $50 using the sample account.",
      objective: "Whether the new payment flow helps more people finish", successSignal: "payment-submitted", baseline: 60, difference: 15,
      stoppingRule: "Field until both designs reach the target sample, then analyse once. No early stopping based on results.", stoppingRuleConfirmed: false,
      designs: [{ label: "Current flow", url: "https://example.com/prototypes/current/" }, { label: "New flow", url: "https://example.com/prototypes/new/" }] },
    { ...newStudyActivity("prototype", "preview-prototype"), title: "Find your balance", instructions: "Find how much the sample account owes.",
      goal: "measure", successSignal: "balance-found", benchmark: 80, url: "" },
    { ...newStudyActivity("tree_test", "preview-tree"), title: "Find a transcript", instructions: "Where would you go to get a copy of your tax transcript?",
      tree: "Home\nPayments\n  Make a payment\n  Payment history\nRecords\n  Tax transcripts *\n  Tax documents\nHelp", benchmark: 70 },
    changeSortMode({ ...newStudyActivity("card_sort", "preview-sort"), title: "Group account features", instructions: "Group these features in a way that makes sense to you.",
      cards: "Make a payment\nPayment activity\nTax documents\nAccount notices\nRefund status" }, "open"),
    { ...newStudyActivity("survey", "preview-survey"), title: "Confidence check", instructions: "Answer a few short questions.",
      questions: "How confident are you that your payment went through?\nWhat, if anything, was confusing?", constructs: "confidence, clarity" },
  ];
}

/** Synthetic Design Studio prototypes for "Choose an existing prototype". */
export type ResearchPreviewPrototype = { id: string; title: string; author: string; previewUrl: string };
export const RESEARCH_PREVIEW_PROTOTYPES: readonly ResearchPreviewPrototype[] = [
  { id: "preview-prototype-payment", title: "Sample payment flow", author: "Sample Designer", previewUrl: "https://example.com/prototypes/payment/" },
  { id: "preview-prototype-notices", title: "Sample notices inbox", author: "Sample Researcher A", previewUrl: "https://example.com/prototypes/notices/" },
];

/** Synthetic teammates for the collaborator picker. Never real people or accounts. */
export const RESEARCH_PREVIEW_ME = "preview-you";
export const RESEARCH_PREVIEW_PEOPLE: readonly { id: string; name: string; agentTier: number; owner?: boolean }[] = [
  { id: "preview-researcher-a", name: "Sample Researcher A", agentTier: 4 },
  { id: "preview-researcher-b", name: "Sample Researcher B", agentTier: 4 },
  { id: "preview-member", name: "Sample Member", agentTier: 1 },
  { id: "preview-admin", name: "Sample Admin", agentTier: 4, owner: true },
];

export type ResearchPreviewEvidence = {
  id: string;
  kind: "Theme" | "Issue";
  title: string;
  summary: string;
};

export type ResearchPreviewDirection = {
  id: string;
  title: string;
  summary: string;
  addresses: readonly string[];
  tradeoff: string;
  accessibility: string;
  recommended?: boolean;
};

export type ResearchPreviewDraft = {
  title: string;
  answers: Partial<Record<ResearchFieldId, string>>;
  purpose: string;
  guidance: string;
  approved: boolean;
};

export type ResearchPreviewState = {
  guidance: string;
  approved: boolean;
  handoffOpen: boolean;
  directionId: string | null;
};

export type ResearchPreviewAction =
  | { type: "prepare-guidance" }
  | { type: "invalidate-guidance" }
  | { type: "edit-guidance"; value: string }
  | { type: "approve-guidance" }
  | { type: "open-handoff" }
  | { type: "choose-direction"; id: string }
  | { type: "reset" };

const LOCAL_PREVIEW_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function researchPreviewAllowed({ dev, platform, hostname }: {
  dev: boolean;
  platform: string;
  hostname: string;
}): boolean {
  return dev && platform === "web" && LOCAL_PREVIEW_HOSTS.has(hostname.trim().toLowerCase());
}

export const RESEARCH_PREVIEW_TASKS: readonly {
  kind: ResearchTaskKind;
  label: string;
  actionLabel: string;
  description: string;
}[] = RESEARCH_TASKS.map(({ kind, label, actionLabel, description }) => ({ kind, label, actionLabel, description }));

export const RESEARCH_PREVIEW_STUDY = {
  title: "Find the right account task",
  answers: {
    decision: "Choose which task-finding concept should move into usability testing.",
    question: "Can people confidently find the action that matches what they came to do?",
    participants: "People managing an account on their own, including keyboard and screen-reader users.",
    method: "Moderated usability sessions with a short confidence check after each task.",
    inputs: "Prior research suggests that unfamiliar labels and similar-looking actions can slow people down.",
    constraints: "Mobile-first, plain language, no production or personally identifying data.",
  } satisfies Partial<Record<ResearchFieldId, string>>,
  purpose: "Compare a small set of task-finding patterns before the team commits to a navigation direction.",
  // Synthetic, generalized findings a researcher might write themselves.
  findings: [
    "People weren't sure which action matched what they came to do.",
    "Similar-looking actions made people hesitate before choosing.",
    "It's still unknown whether grouping tasks by goal helps screen-reader users.",
  ].join("\n"),
} as const;

export const RESEARCH_PREVIEW_EVIDENCE: readonly ResearchPreviewEvidence[] = [
  {
    id: "preview-theme-clear-next-step",
    kind: "Theme",
    title: "Clear next steps",
    summary: "People need to understand what each action will help them accomplish before they select it.",
  },
  {
    id: "preview-issue-similar-actions",
    kind: "Issue",
    title: "Similar actions are difficult to distinguish",
    summary: "Options that sound alike can increase hesitation and make recovery from a wrong choice less obvious.",
  },
  {
    id: "preview-theme-orientation",
    kind: "Theme",
    title: "Orientation and progress",
    summary: "People benefit from knowing where they are, what information is needed, and what will happen next.",
  },
] as const;

export const RESEARCH_PREVIEW_GUIDANCE = [
  "User needs",
  "- N1: People need to understand the outcome of an action before committing to it.",
  "- N2: People need clear orientation, progress, and recovery cues throughout the task.",
  "",
  "Pain points",
  "- P1: Similar-looking actions may be difficult to distinguish at the moment of choice.",
  "- P2: A wrong selection may leave people uncertain about how to recover without losing work.",
  "",
  "Design opportunities",
  "- O1: Hypothesis: organize actions around the outcome a person is trying to reach.",
  "- O2: Hypothesis: explain what happens next before asking for a commitment.",
  "",
  "Unknowns and evidence limits",
  "- U1: The available evidence does not establish which interaction pattern will work best.",
  "- U2: Participant research is still needed to compare comprehension, confidence, and recovery.",
].join("\n");

export const RESEARCH_PREVIEW_DIRECTIONS: readonly ResearchPreviewDirection[] = [
  {
    id: "guided-outcomes",
    title: "Outcome-guided task list",
    summary: "Group actions by the result a person wants, with a short explanation beneath each choice.",
    addresses: ["N1", "P1"],
    tradeoff: "Fast to scan, but the grouping language must match how people describe their goals.",
    accessibility: "Use descriptive headings, a predictable reading order, and one clear focus target per action.",
    recommended: true,
  },
  {
    id: "guided-questions",
    title: "Progressive question flow",
    summary: "Ask a few plain-language questions and narrow the available actions as the person answers.",
    addresses: ["N2", "P1", "P2"],
    tradeoff: "Offers more guidance, but adds steps and may feel slow for returning users.",
    accessibility: "Announce progress, preserve earlier answers, and make Back behavior predictable.",
  },
  {
    id: "compare-actions",
    title: "Side-by-side action comparison",
    summary: "Show the closest matching actions together with concise differences and expected next steps.",
    addresses: ["N1", "N2", "P1"],
    tradeoff: "Makes distinctions explicit, but can become dense on small screens.",
    accessibility: "Keep comparisons linear on mobile and avoid relying on position or color alone.",
  },
] as const;

export function createResearchPreviewState(): ResearchPreviewState {
  return { guidance: "", approved: false, handoffOpen: false, directionId: null };
}

export function researchPreviewReducer(state: ResearchPreviewState, action: ResearchPreviewAction): ResearchPreviewState {
  switch (action.type) {
    case "prepare-guidance":
      return { guidance: RESEARCH_PREVIEW_GUIDANCE, approved: false, handoffOpen: false, directionId: null };
    case "invalidate-guidance":
      return createResearchPreviewState();
    case "edit-guidance":
      return { guidance: action.value, approved: false, handoffOpen: false, directionId: null };
    case "approve-guidance":
      return state.guidance.trim() ? { ...state, approved: true, handoffOpen: false, directionId: null } : state;
    case "open-handoff":
      return state.approved ? { ...state, handoffOpen: true } : state;
    case "choose-direction":
      return state.handoffOpen && RESEARCH_PREVIEW_DIRECTIONS.some(direction => direction.id === action.id)
        ? { ...state, directionId: action.id }
        : state;
    case "reset":
      return createResearchPreviewState();
  }
}

export function buildResearchPreviewPrompt(draft: ResearchPreviewDraft): string {
  if (!draft.approved || !draft.guidance.trim()) throw new Error("Preview guidance must be explicitly approved");
  return buildStudyPrototypePrompt({
    kind: "study",
    title: draft.title,
    answers: draft.answers,
    prototype: { kind: "new", purpose: draft.purpose },
    designGuidance: { text: draft.guidance, approved: true },
  });
}
