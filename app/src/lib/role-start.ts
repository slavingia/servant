import type { OnboardingAccess, UXGoal, UXOnboardingState, UXRole } from "./onboarding";

export type RoleStartTask = {
  id: string;
  title: string;
  description: string;
  href: string;
  /** Onboarding goals that make this task a recommended first step. */
  goals: readonly UXGoal[];
  recommended: boolean;
  /** Locked tasks stay visible so people can understand what access unlocks. */
  locked: boolean;
  reason?: string;
};

type TaskRequirement = "researcher" | "advanced-agent" | "design-creation";
type TaskSpec = Omit<RoleStartTask, "locked" | "reason" | "recommended"> & { requirement?: TaskRequirement };
type RoleState = Pick<UXOnboardingState, "role" | "goals">;

const TASKS: Record<UXRole, readonly TaskSpec[]> = {
  "ux-researcher": [
    {
      id: "research-study",
      title: "Build a research study",
      description: "Plan the study, activities, consent, and participant flow.",
      href: "/research-new?kind=study",
      goals: ["plan-research"],
      requirement: "researcher",
    },
    {
      id: "research-synthesis",
      title: "Synthesize existing evidence",
      description: "Turn findings into themes, evidence, and actionable next steps.",
      href: "/research-new?kind=synthesis",
      goals: ["synthesize"],
      requirement: "researcher",
    },
    {
      id: "research-prototype",
      title: "Create an interactive prototype",
      description: "Use the prototype agent to build a live design for a study or concept review.",
      href: "/designs",
      goals: ["prototype"],
      requirement: "design-creation",
    },
    {
      id: "research-design-review",
      title: "Run a research-informed design review",
      description: "Compare a design with Research Hub evidence, identify alignment or conflicts with known user needs, and recommend what to investigate or change.",
      href: "/research-new?kind=design-review",
      goals: ["research-design-review", "prototype", "content", "accessibility", "share"],
      requirement: "researcher",
    },
  ],
  "product-designer": [
    {
      id: "product-prototype",
      title: "Create an interactive design",
      description: "Turn an idea into a live prototype you can refine with the agent.",
      href: "/designs",
      goals: ["prototype", "content"],
      requirement: "design-creation",
    },
    {
      id: "product-review",
      title: "Review evidence and accessibility",
      description: "Use the agent to identify evidence, risks, and accessibility improvements.",
      href: "/agent",
      goals: ["plan-research", "synthesize", "research-design-review", "accessibility"],
      requirement: "advanced-agent",
    },
    {
      id: "product-share",
      title: "Share a design for feedback",
      description: "Bring work into a team conversation and keep feedback in its thread.",
      href: "/channels",
      goals: ["share"],
    },
  ],
  "content-designer": [
    {
      id: "content-draft",
      title: "Draft interface content",
      description: "Explore a flow and draft clear interface language with the agent.",
      href: "/agent",
      goals: ["content", "prototype"],
      requirement: "advanced-agent",
    },
    {
      id: "content-review",
      title: "Review content in team designs",
      description: "Inspect shared designs for evidence, clarity, and accessibility opportunities.",
      href: "/designs",
      goals: ["plan-research", "synthesize", "research-design-review", "accessibility"],
    },
    {
      id: "content-share",
      title: "Share content for feedback",
      description: "Start a team conversation and gather feedback in one thread.",
      href: "/channels",
      goals: ["share"],
    },
  ],
  "design-engineer": [
    {
      id: "engineer-prototype",
      title: "Build an interactive prototype",
      description: "Create a working design and refine its implementation details.",
      href: "/designs",
      goals: ["prototype", "content"],
      requirement: "design-creation",
    },
    {
      id: "engineer-review",
      title: "Review evidence and accessibility",
      description: "Use the agent to turn evidence and accessibility findings into next steps.",
      href: "/agent",
      goals: ["plan-research", "synthesize", "research-design-review", "accessibility"],
      requirement: "advanced-agent",
    },
    {
      id: "engineer-project",
      title: "Coordinate project work",
      description: "Open shared projects, releases, notes, and team conversations.",
      href: "/channels",
      goals: ["share"],
    },
  ],
};

const unlocked = { locked: false } as const;

function accessFor(requirement: TaskRequirement | undefined, access: OnboardingAccess): Pick<RoleStartTask, "locked" | "reason"> {
  if (!requirement) return unlocked;
  if (requirement === "design-creation") {
    if (access.canCreateDesign === undefined || access.canCreateDesign === true) return unlocked;
    if (access.canCreateDesign === null) return {
      locked: true,
      reason: "Design creation access couldn't be verified. Check your connection and try again.",
    };
    return {
      locked: true,
      reason: "Design creation requires Design prototyper, Design engineer, or Researcher access and a configured Design Studio.",
    };
  }

  // Undefined means the caller deliberately omitted an access check. Null means
  // a check was attempted but could not establish the current server tier.
  if (access.agentTier === undefined) return unlocked;
  if (access.agentTier === null) return {
    locked: true,
    reason: "Agent access couldn't be verified. Check your connection and try again.",
  };
  if (requirement === "researcher" && access.agentTier !== 4) return {
    locked: true,
    reason: "Researcher access is required. Ask a workspace owner to grant it.",
  };
  if (requirement === "advanced-agent" && access.agentTier !== 3 && access.agentTier !== 4) return {
    locked: true,
    reason: "Design engineer or Researcher access is required. Ask a workspace owner to grant it.",
  };
  return unlocked;
}

/**
 * Role-specific activation tasks. Goal matches move to the front while the
 * role's authored order remains stable within recommended and other tasks.
 */
export function roleStartTasks(state: RoleState | null | undefined, access: OnboardingAccess = {}): RoleStartTask[] {
  if (!state?.role) return [];
  const selected = new Set(state.goals);
  return TASKS[state.role]
    .map((spec, index) => {
      const { requirement, ...task } = spec;
      const recommended = task.goals.some(goal => selected.has(goal));
      return {
        task: { ...task, recommended, ...accessFor(requirement, access) },
        index,
        recommended,
      };
    })
    .sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.index - b.index)
    .map(({ task }) => task);
}
