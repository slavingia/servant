import type { Chat, NewChatOptions, ServerError } from "./server";

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

export function designStatus(chat: Pick<Chat, "archived" | "latestTurn" | "lastMessage" | "previewUrl" | "previewReady">): DesignStatus {
  if (chat.archived) return "Archived";
  if ((chat.latestTurn && ACTIVE_TURNS.has(chat.latestTurn.status)) || chat.lastMessage?.pending) return "Building";
  // Updated servers confirm that the hosted index file exists. Missing means
  // an older server, where the established preview URL remains the signal.
  return chat.previewUrl && chat.previewReady !== false ? "Ready for review" : "Draft";
}

/** Only the server's design-capable tiers may create a prototype workspace. */
export function canCreateDesign(agentTier: unknown, available: unknown): boolean {
  return available === true && (agentTier === undefined || agentTier === 2 || agentTier === 3 || agentTier === 4);
}

/** Tier 4 uses an explicit second lane; ordinary Researcher chats stay restricted. */
export function designChatOptions(agentTier: unknown): NewChatOptions {
  return agentTier === 4 ? { mode: "vibe", requiredAgentRole: "prototype" } : { mode: "vibe" };
}

/** Older servers may ignore vibe mode, so callers verify before navigation. */
export function isVerifiedDesignChat(chat: Pick<Chat, "mode" | "agentRole">, agentTier: unknown): boolean {
  return chat.mode === "vibe" && (agentTier !== 4 || chat.agentRole === "prototype");
}

/** A previous server may advertise generic vibe support without the scoped Researcher lane. */
export function designCreationErrorMessage(agentTier: unknown, error?: Pick<ServerError, "message" | "status">): string {
  if (agentTier === 4 && (error?.status === 400 || error?.status === 403)) {
    return "Researcher prototype access couldn't be verified by this server. Ask a workspace owner to update Servant and confirm your access.";
  }
  return error?.message || "Couldn't start a design";
}

export function designCreationAccess(agentTier: unknown, available: unknown): DesignCreationAccess {
  if (!canCreateDesign(agentTier, available)) return {
    canCreate: false,
    explanation: available !== true
      ? "Design creation is not set up on this workspace yet."
      : "You can review shared designs. Ask a workspace owner for Design prototyper, Design engineer, or Researcher access to create one.",
  };
  // Servers from before named agent tiers exposed only the general vibe
  // capability and accepted an explicit mode request from full users. Let the
  // server decide, then verify the returned chat is actually a design.
  if (agentTier === undefined) return {
    canCreate: true,
    explanation: "This workspace will verify design access when you create one.",
  };
  if (agentTier === 2 || agentTier === 3 || agentTier === 4) return {
    canCreate: true,
    explanation: agentTier === 4
      ? "Your prototype agent can create interactive designs while Researcher chats stay restricted."
      : "Your agent can create interactive designs.",
  };
  return {
    canCreate: false,
    explanation: "You can review shared designs. Ask a workspace owner for Design prototyper, Design engineer, or Researcher access to create one.",
  };
}

/**
 * Plain text on purpose: every Servant build can render and thread this card,
 * even before it knows about the Designs library.
 */
export function designReviewText(chat: Pick<Chat, "title" | "archived" | "latestTurn" | "lastMessage" | "previewUrl" | "previewReady">, focus = "") {
  const lines = [
    `Design review: ${designTitle(chat)}`,
    `Status: ${designStatus(chat)}`,
    `Preview: ${chat.previewUrl?.trim() || "Not published yet"}`,
  ];
  if (focus.trim()) lines.push(`Review focus: ${focus.trim()}`);
  lines.push("Please leave feedback in this message's thread.");
  return lines.join("\n");
}
