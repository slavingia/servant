import type { RoleStartTask } from "./role-start";

// The optional role tour: one page per starting point on the start page, each
// with a small drawn example and two plain lines on how it works. The pages
// come from roleStartTasks, so the tour and the start page always agree on
// what a role has and what is locked. Wording is checked against the screens
// it describes (Research Studio, Design Studio, Adjust design, projects).

export type TourVisual =
  | "study" | "synthesis" | "prototype" | "design-review" | "accessibility"
  | "evidence" | "share" | "content-draft" | "content-review" | "project";

export type TourDemo = {
  visual: TourVisual;
  /** One short line under the title. */
  lead: string;
  /** Two short "how it works" lines. */
  how: readonly [string, string];
  /** Paused while the server's research hold is on (docs/ux-client.md, Research pilot build). */
  held?: boolean;
};

const prototype: TourDemo = {
  visual: "prototype",
  lead: "Describe a page. Get a working prototype.",
  how: ["Describe the page in plain words", "Refine it by chatting, then share a live preview"],
};
const accessibility: TourDemo = {
  visual: "accessibility",
  lead: "Find accessibility problems before anyone else does.",
  how: ["Open a design, choose Adjust design, then Accessibility", "Check contrast, labels, headings and tap sizes, and ask the agent to fix them"],
};
const evidence: TourDemo = {
  visual: "evidence",
  lead: "Ask what's known before you decide.",
  how: ["Ask the agent what supports a design decision", "Get risks and next steps in a private chat"],
};
const share: TourDemo = {
  visual: "share",
  lead: "Get feedback in one place.",
  how: ["Post your work in a team channel", "Keep feedback in its thread, and ask @agent to sum it up"],
};

/** Keyed by RoleStartTask id (role-start.ts). */
export const TOUR_DEMOS: Record<string, TourDemo> = {
  "research-study": {
    visual: "study",
    lead: "Plan and build a study in one place.",
    how: ["Pick a method, like tree testing or card sorting", "Preview it as a participant before anyone sees it"],
  },
  "research-synthesis": {
    visual: "synthesis",
    lead: "Turn scattered evidence into themes.",
    how: ["Point it at interviews, surveys or Research Hub records", "Get themes, contradictions and gaps, with every source kept"],
    held: true,
  },
  "research-prototype": prototype,
  "research-design-review": {
    visual: "design-review",
    lead: "Check a design against what research already knows.",
    how: ["Compare a design with Research Hub evidence", "See what fits, what conflicts and what to test next"],
    held: true,
  },
  "product-prototype": prototype,
  "product-accessibility": accessibility,
  "product-review": evidence,
  "product-share": share,
  "content-draft": {
    visual: "content-draft",
    lead: "Draft plainer words, faster.",
    how: ["Paste a screen's text or describe the flow", "Get plainer wording to compare with the original"],
  },
  "content-review": {
    visual: "content-review",
    lead: "Suggest wording right on the design.",
    how: ["Open a teammate's shared design", "Suggest changes on the page, for them to accept or not"],
  },
  "content-share": share,
  "engineer-prototype": prototype,
  "engineer-accessibility": accessibility,
  "engineer-review": evidence,
  "engineer-project": {
    visual: "project",
    lead: "See who owns what, at every stage.",
    how: ["Open a shared project: releases, notes and chats", "Every stage of a release has an owner"],
  },
};

export type TourStatus = "ready" | "locked" | "held";

export type TourPage = {
  task: RoleStartTask;
  demo: TourDemo;
  status: TourStatus;
  /** What the status note says. */
  note: string;
};

export const HELD_NOTE = "Paused in this pilot build. Your workspace owner can turn it on.";
export const READY_NOTE = "You can use this now.";

/**
 * The tour's pages, in the start page's order. A task with no demo is left
 * out rather than shown without an example.
 */
export function tourPages(tasks: readonly RoleStartTask[], researchHold: boolean): TourPage[] {
  return tasks.flatMap((task): TourPage[] => {
    const demo = TOUR_DEMOS[task.id];
    if (!demo) return [];
    if (task.locked) return [{ task, demo, status: "locked", note: task.reason ?? "Ask a workspace owner for access." }];
    if (demo.held && researchHold) return [{ task, demo, status: "held", note: HELD_NOTE }];
    return [{ task, demo, status: "ready", note: READY_NOTE }];
  });
}

/** Clamp a page index into the tour. */
export function tourPage(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.trunc(index)));
}
