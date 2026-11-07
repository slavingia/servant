import type { Chat } from "./server";

export type DesignStatus = "Draft" | "Building" | "Ready for review" | "Archived";
export type DesignCreationAccess = { canCreate: boolean; explanation: string };

const ACTIVE_TURNS = new Set(["queued", "running", "waiting_for_approval", "stopping"]);

/** Vibe chats are the existing durable prototype/design workspace. */
export function isDesign(chat: Chat) {
  return chat.mode === "vibe";
}

/** One library across your designs and designs teammates explicitly shared. */
export function designChats(mine: Chat[], shared: Chat[]) {
  const byId = new Map<string, Chat>();
  for (const chat of [...mine, ...shared]) if (isDesign(chat)) byId.set(chat.id, chat);
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Active prototypes that are eligible to attach to a study plan for final readiness checks. */
export function studyPrototypeChats(mine: Chat[], shared: Chat[]) {
  return designChats(mine, shared).filter(chat =>
    !!chat.previewUrl?.trim() && designStatus(chat) === "Ready for review"
  );
}

export function designTitle(chat: Pick<Chat, "title">) {
  return chat.title.replace(/`/g, "").replace(/\s+/g, " ").trim() || "Untitled design";
}

export function designStatus(chat: Pick<Chat, "archived" | "latestTurn" | "lastMessage" | "previewUrl">): DesignStatus {
  if (chat.archived) return "Archived";
  if ((chat.latestTurn && ACTIVE_TURNS.has(chat.latestTurn.status)) || chat.lastMessage?.pending) return "Building";
  return chat.previewUrl ? "Ready for review" : "Draft";
}

/** Only the server's design-capable tiers may create a prototype workspace. */
export function designCreationAccess(agentTier: unknown, available: unknown): DesignCreationAccess {
  if (available !== true) return {
    canCreate: false,
    explanation: "Design creation is not set up on this workspace yet.",
  };
  // Servers from before named agent tiers exposed only the general vibe
  // capability and accepted an explicit mode request from full users. Let the
  // server decide, then verify the returned chat is actually a design.
  if (agentTier === undefined) return {
    canCreate: true,
    explanation: "This workspace will verify design access when you create one.",
  };
  if (agentTier === 2 || agentTier === 3) return {
    canCreate: true,
    explanation: "Your agent can create interactive designs.",
  };
  if (agentTier === 4) return {
    canCreate: false,
    explanation: "Researcher access can review shared designs. Ask a workspace owner for Design prototyper or Design engineer access to create one.",
  };
  return {
    canCreate: false,
    explanation: "You can review shared designs. Ask a workspace owner for Design prototyper or Design engineer access to create one.",
  };
}

/**
 * Plain text on purpose: every Servant build can render and thread this card,
 * even before it knows about the Designs library.
 */
export function designReviewText(chat: Pick<Chat, "title" | "archived" | "latestTurn" | "lastMessage" | "previewUrl">, focus = "") {
  const lines = [
    `Design review: ${designTitle(chat)}`,
    `Status: ${designStatus(chat)}`,
    `Preview: ${chat.previewUrl?.trim() || "Not published yet"}`,
  ];
  if (focus.trim()) lines.push(`Review focus: ${focus.trim()}`);
  lines.push("Please leave feedback in this message's thread.");
  return lines.join("\n");
}
