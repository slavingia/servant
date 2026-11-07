export const ONBOARDING_VERSION = 1 as const;

export const UX_ROLES = [
  { id: "product-designer", label: "Product designer", description: "Shape flows, screens, prototypes, and interaction details." },
  { id: "ux-researcher", label: "UX researcher", description: "Plan studies, gather evidence, and synthesize what people need." },
  { id: "content-designer", label: "Content designer", description: "Make journeys and interfaces clearer through language." },
  { id: "design-engineer", label: "Design engineer", description: "Connect design intent to working, accessible experiences." },
] as const;

export type UXRole = (typeof UX_ROLES)[number]["id"];

export const UX_GOALS = [
  { id: "prototype", label: "Prototype an idea" },
  { id: "plan-research", label: "Plan a research study" },
  { id: "synthesize", label: "Synthesize evidence" },
  { id: "research-design-review", label: "Run a research-informed design review" },
  { id: "content", label: "Improve interface content" },
  { id: "accessibility", label: "Review accessibility" },
  { id: "share", label: "Share work with my team" },
] as const;

export type UXGoal = (typeof UX_GOALS)[number]["id"];
export type OnboardingStep = "role" | "goals" | "ready";

export type UXOnboardingState = {
  version: typeof ONBOARDING_VERSION;
  step: OnboardingStep;
  role: UXRole | null;
  goals: UXGoal[];
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  roleIntroCompletedAt?: number;
};

export type OnboardingFirstAction = {
  label: string;
  description: string;
  href: "/agent" | "/channels" | "/designs" | "/research";
};

export type OnboardingAccess = {
  /** Omit only when no access check is intended; null means access could not be verified. */
  agentTier?: number | null;
  canCreateDesign?: boolean | null;
};

const ACCESS_LABELS: Record<number, string> = {
  0: "No agent",
  1: "Tester",
  2: "Design prototyper",
  3: "Design engineer",
  4: "Researcher",
};

const roles = new Set<string>(UX_ROLES.map(role => role.id));
const goals = new Set<string>(UX_GOALS.map(goal => goal.id));
const steps = new Set<string>(["role", "goals", "ready"]);

const timestamp = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;

export function startOnboarding(now = Date.now()): UXOnboardingState {
  return { version: ONBOARDING_VERSION, step: "role", role: null, goals: [], startedAt: now, updatedAt: now };
}

/**
 * Reads persisted state defensively. An unknown version starts the current flow
 * again instead of guessing how a future or obsolete shape should behave.
 */
export function normalizeOnboarding(value: unknown, now = Date.now()): UXOnboardingState {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== ONBOARDING_VERSION) return startOnboarding(now);
  const raw = value as Partial<UXOnboardingState>;
  const role = typeof raw.role === "string" && roles.has(raw.role) ? raw.role as UXRole : null;
  const selected = Array.isArray(raw.goals)
    ? [...new Set(raw.goals.filter((goal): goal is UXGoal => typeof goal === "string" && goals.has(goal)))]
    : [];
  let step = typeof raw.step === "string" && steps.has(raw.step) ? raw.step as OnboardingStep : role ? "goals" : "role";
  if (!role) step = "role";
  else if (step === "ready" && selected.length === 0) step = "goals";
  const startedAt = timestamp(raw.startedAt, now);
  const updatedAt = Math.max(startedAt, timestamp(raw.updatedAt, startedAt));
  const completedAt = typeof raw.completedAt === "number" && Number.isFinite(raw.completedAt) && raw.completedAt >= 0
    ? Math.max(updatedAt, raw.completedAt)
    : undefined;
  const roleIntroCompletedAt = completedAt !== undefined && typeof raw.roleIntroCompletedAt === "number" && Number.isFinite(raw.roleIntroCompletedAt) && raw.roleIntroCompletedAt >= 0
    ? Math.max(completedAt, raw.roleIntroCompletedAt)
    : undefined;
  return {
    version: ONBOARDING_VERSION,
    step,
    role,
    goals: selected,
    startedAt,
    updatedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(roleIntroCompletedAt === undefined ? {} : { roleIntroCompletedAt }),
  };
}

/** Missing state means a legacy account and does not interrupt its next launch. */
export function onboardingRequired(value: unknown): boolean {
  return value !== undefined && normalizeOnboarding(value).completedAt === undefined;
}

/** Legacy accounts are left alone; milestone-one accounts get the new role handoff once. */
export function roleIntroRequired(value: unknown): boolean {
  if (value === undefined) return false;
  const current = normalizeOnboarding(value);
  return current.completedAt !== undefined && current.roleIntroCompletedAt === undefined;
}

export function chooseRole(state: UXOnboardingState, role: UXRole, now = Date.now()): UXOnboardingState {
  return { ...normalizeOnboarding(state, now), role, updatedAt: now, completedAt: undefined, roleIntroCompletedAt: undefined };
}

export function toggleGoal(state: UXOnboardingState, goal: UXGoal, now = Date.now()): UXOnboardingState {
  const current = normalizeOnboarding(state, now);
  const selected = current.goals.includes(goal) ? current.goals.filter(value => value !== goal) : [...current.goals, goal];
  return { ...current, goals: selected, updatedAt: now, completedAt: undefined, roleIntroCompletedAt: undefined };
}

export function moveOnboarding(state: UXOnboardingState, step: OnboardingStep, now = Date.now()): UXOnboardingState {
  const current = normalizeOnboarding(state, now);
  const safeStep = !current.role ? "role" : step === "ready" && current.goals.length === 0 ? "goals" : step;
  return { ...current, step: safeStep, updatedAt: now, completedAt: undefined, roleIntroCompletedAt: undefined };
}

export function completeOnboarding(state: UXOnboardingState, now = Date.now()): UXOnboardingState {
  const current = normalizeOnboarding(state, now);
  if (!current.role || current.goals.length === 0) return current;
  return { ...current, step: "ready", updatedAt: now, completedAt: now, roleIntroCompletedAt: undefined };
}

export function completeRoleIntro(state: UXOnboardingState, now = Date.now()): UXOnboardingState {
  const current = normalizeOnboarding(state, now);
  if (current.completedAt === undefined) return current;
  return { ...current, roleIntroCompletedAt: now };
}

export function roleLabel(role: UXRole | null): string {
  return UX_ROLES.find(option => option.id === role)?.label ?? "UX teammate";
}

export function goalLabels(selected: UXGoal[]): string[] {
  return UX_GOALS.filter(goal => selected.includes(goal.id)).map(goal => goal.label);
}

export function agentAccessLabel(tier: unknown): string | null {
  return typeof tier === "number" && Number.isInteger(tier) ? ACCESS_LABELS[tier] ?? null : null;
}

export function firstActionForRole(role: UXRole | null, access: OnboardingAccess = {}): OnboardingFirstAction {
  const accessKnown = access.agentTier !== undefined;
  if (role === "ux-researcher") return !accessKnown || access.agentTier === 4 ? {
    label: "Open Research Studio",
    description: "Plan studies and synthesize evidence with the Researcher agent, and build study prototypes with the prototype agent.",
    href: "/research",
  } : {
    label: "Explore Research Studio",
    description: "Preview research workflows and shared work while a workspace owner grants Researcher access.",
    href: "/research",
  };
  if (role === "content-designer") return !accessKnown || access.agentTier === 3 || access.agentTier === 4 ? {
    label: "Start a content draft",
    description: "Use your agent to explore a flow, draft interface language, or prepare work to share.",
    href: "/agent",
  } : {
    label: "Go to your workspace",
    description: "Browse shared work while a workspace owner grants Design engineer or Researcher access for drafting.",
    href: "/channels",
  };
  if (role === "design-engineer") return {
    label: "Open project work",
    description: "Choose a shared project to review its briefs, rules, releases, and active work.",
    href: "/channels",
  };
  if (access.canCreateDesign === false) return {
    label: "Open team designs",
    description: "Review designs shared with your team. A workspace owner can grant Design prototyper, Design engineer, or Researcher access when you need to create one.",
    href: "/designs",
  };
  return {
    label: "Create your first design",
    description: "Open Design Studio to start an interactive prototype and shape it through conversation.",
    href: "/designs",
  };
}
