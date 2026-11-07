import type { Chat } from "./server";

export type ResearchTaskKind = "study" | "synthesis" | "design-review";
export type ResearchFieldId = "decision" | "question" | "participants" | "method" | "inputs" | "focus" | "constraints";

export type ResearchTaskField = {
  id: ResearchFieldId;
  label: string;
  placeholder: string;
  required?: boolean;
  multiline?: boolean;
};

export type ResearchTaskDefinition = {
  kind: ResearchTaskKind;
  label: string;
  actionLabel: string;
  description: string;
  titlePrefix: string;
  fields: readonly ResearchTaskField[];
  requestedOutput: readonly string[];
};

export type ResearchBrief = {
  kind: ResearchTaskKind;
  title: string;
  answers: Partial<Record<ResearchFieldId, string>>;
};

export const RESEARCH_TASKS: readonly ResearchTaskDefinition[] = [
  {
    kind: "study",
    label: "Research study",
    actionLabel: "Build a research study",
    description: "Turn a decision and research question into a practical, responsible study plan.",
    titlePrefix: "[Research study] ",
    fields: [
      { id: "decision", label: "Decision this study should inform", placeholder: "What will the team decide or change with this evidence?", required: true, multiline: true },
      { id: "question", label: "Research question", placeholder: "What do you need to learn?", required: true, multiline: true },
      { id: "participants", label: "People to learn from", placeholder: "Relevant audiences, behaviors, experience, or accessibility needs", required: true, multiline: true },
      { id: "method", label: "Method ideas", placeholder: "Optional — interviews, usability testing, survey, card sort, or ask the agent to recommend one", multiline: true },
      { id: "inputs", label: "What you already know", placeholder: "Existing evidence, assumptions, links, or prior findings", multiline: true },
      { id: "constraints", label: "Constraints", placeholder: "Timeline, sample size, policy, consent, recruiting, or other limits", multiline: true },
    ],
    requestedOutput: [
      "objectives and testable research questions",
      "a recommended method with rationale and realistic alternatives",
      "participant criteria, recruiting considerations, and an ethical consent approach",
      "a session or activity plan, analysis approach, risks, timeline, and next steps",
    ],
  },
  {
    kind: "synthesis",
    label: "Evidence synthesis",
    actionLabel: "Synthesize existing evidence",
    description: "Frame evidence, gaps, and a decision so the researcher can build a defensible synthesis plan.",
    titlePrefix: "[Research synthesis] ",
    fields: [
      { id: "decision", label: "Decision this synthesis should inform", placeholder: "What needs to be decided or prioritized?", required: true, multiline: true },
      { id: "inputs", label: "Evidence to synthesize", placeholder: "Describe the interviews, surveys, analytics, support themes, or documents you have", required: true, multiline: true },
      { id: "question", label: "Synthesis question", placeholder: "What should the evidence help the team understand?", required: true, multiline: true },
      { id: "participants", label: "Audiences or segments", placeholder: "Optional — which groups should be compared or kept distinct?", multiline: true },
      { id: "focus", label: "Desired output", placeholder: "Optional — themes, opportunity areas, journey, research readout, or decision brief", multiline: true },
      { id: "constraints", label: "Evidence limits", placeholder: "Known gaps, dates, confidence concerns, privacy limits, or deadlines", multiline: true },
    ],
    requestedOutput: [
      "a synthesis approach that preserves source, date, segment, and confidence",
      "candidate themes, contradictions, outliers, and evidence gaps to test",
      "a useful output structure with traceable findings and clearly labeled inference",
      "recommended next steps without treating missing evidence as proof",
    ],
  },
  {
    kind: "design-review",
    label: "Design research review",
    actionLabel: "Run a research-informed design review",
    description: "Compare a design with Research Hub evidence, identify alignment or conflicts with known user needs, and recommend what to investigate or change.",
    titlePrefix: "[Research design review] ",
    fields: [
      { id: "inputs", label: "Design or experience", placeholder: "Describe the concept, flow, prototype, content, or link to review", required: true, multiline: true },
      { id: "decision", label: "Decision this review should inform", placeholder: "What might the team change after the review?", required: true, multiline: true },
      { id: "participants", label: "Intended audience", placeholder: "Who needs to use this, including relevant contexts and accessibility needs", required: true, multiline: true },
      { id: "focus", label: "Review focus", placeholder: "Comprehension, findability, task success, trust, accessibility, or another concern", multiline: true },
      { id: "question", label: "What is uncertain?", placeholder: "Optional — assumptions or questions the design has not answered", multiline: true },
      { id: "constraints", label: "Constraints", placeholder: "Fidelity, platform, timeline, policy, technical, or recruiting limits", multiline: true },
    ],
    requestedOutput: [
      "the most important assumptions and risks to investigate",
      "an evidence-led review plan that separates inspection from participant research",
      "tasks, prompts, success signals, accessibility considerations, and severity criteria",
      "prioritized recommendations and what evidence would increase confidence",
    ],
  },
] as const;

export function isResearchTaskKind(value: unknown): value is ResearchTaskKind {
  return RESEARCH_TASKS.some(task => task.kind === value);
}

export function researchTask(kind: ResearchTaskKind): ResearchTaskDefinition {
  return RESEARCH_TASKS.find(task => task.kind === kind)!;
}

const cleanLine = (value: string) => value.replace(/\s+/g, " ").trim();

/** A human-readable prefix doubles as the backwards-compatible research-work marker. */
export function researchChatTitle(kind: ResearchTaskKind, title: string): string {
  const task = researchTask(kind);
  const subject = cleanLine(title) || task.label;
  return `${task.titlePrefix}${subject}`.slice(0, 80).trimEnd();
}

export function researchChatKind(chat: Pick<Chat, "title">): ResearchTaskKind | null {
  return RESEARCH_TASKS.find(task => chat.title.startsWith(task.titlePrefix))?.kind ?? null;
}

export function researchDisplayTitle(chat: Pick<Chat, "title">): string {
  const kind = researchChatKind(chat);
  if (!kind) return cleanLine(chat.title) || "Untitled research";
  return cleanLine(chat.title.slice(researchTask(kind).titlePrefix.length)) || researchTask(kind).label;
}

export function researchChats(chats: Chat[]): Chat[] {
  return chats.filter(chat => researchChatKind(chat) !== null).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function missingResearchFields(brief: ResearchBrief): string[] {
  const task = researchTask(brief.kind);
  const missing = cleanLine(brief.title) ? [] : ["Working title"];
  for (const field of task.fields) {
    if (field.required && !cleanLine(brief.answers[field.id] ?? "")) missing.push(field.label);
  }
  return missing;
}

/**
 * Plain text on purpose: it becomes the first ordinary Servant message, so the
 * original app can read, share, archive, and continue the work with no new API.
 */
export function buildResearchPrompt(brief: ResearchBrief): string {
  const task = researchTask(brief.kind);
  const title = researchChatTitle(brief.kind, brief.title);
  const details = task.fields.flatMap(field => {
    const answer = (brief.answers[field.id] ?? "").trim();
    return answer ? [`${field.label}: ${answer}`] : [];
  });
  const evidenceRequirements = brief.kind === "design-review" ? [
    "",
    "Evidence requirements for this design review:",
    "- Search the Research Hub and other authorized research sources for relevant existing evidence.",
    "- Cite each source's title, link or catalog reference, and publication or data date.",
    "- Clearly label evidence gaps and separate expert inspection from participant evidence.",
    "- Never claim that the design is validated or approved.",
  ] : [];
  return [
    title,
    "",
    `Task: ${task.actionLabel}`,
    ...details,
    "",
    "Please produce:",
    ...task.requestedOutput.map(item => `- ${item}`),
    ...evidenceRequirements,
    "",
    "Working agreement:",
    "- Ask concise clarifying questions when an unknown could materially change the plan.",
    "- Label assumptions, evidence, inference, and recommendations separately.",
    "- Flag privacy, consent, accessibility, sampling, and research-ethics concerns.",
    "- Do not contact participants, publish anything, or claim that research has been conducted.",
  ].join("\n");
}
