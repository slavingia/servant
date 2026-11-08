import type { Chat, NewChatOptions, ServerError } from "./server";

export type DesignStatus = "Draft" | "Building" | "Published" | "Archived";
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
    !!chat.previewUrl?.trim() && designStatus(chat) === "Published"
  );
}

export function designTitle(chat: Pick<Chat, "title">) {
  const title = chat.title.replace(/`/g, "").replace(/\s+/g, " ").trim();
  // The server names every new conversation "New chat" until its first message.
  return title && title !== "New chat" ? title : "Untitled design";
}

/** The header for a conversation: a design nobody has named yet is an "Untitled design". */
export function designHeading(heading: string, design: boolean) {
  return design && heading === "New chat" ? "Untitled design" : heading;
}

/** Starting descriptions for a new design. They only fill the message box; nothing is sent. */
export const DESIGN_STARTERS: readonly { label: string; text: string; attach?: true }[] = [
  { label: "Sign-in page", text: "Build a sign-in page with email and password fields, a \"Forgot password?\" link and clear error messages." },
  { label: "Pricing page", text: "Build a pricing page that compares three plans side by side, with one marked as recommended." },
  { label: "Mobile checkout", text: "Build a three-step mobile checkout: cart, delivery details, then a review screen before paying." },
  { label: "Settings screen", text: "Build a settings screen with grouped options, on/off switches and a confirmation when changes are saved." },
  // Also opens the photo picker, so the sketch or screenshot it mentions gets attached.
  { label: "From a sketch or screenshot", text: "Build this from the sketch or screenshot I've attached. Keep its layout and wording, and make it clean and accessible.", attach: true },
];

export function designStatus(chat: Pick<Chat, "archived" | "latestTurn" | "lastMessage" | "previewUrl" | "previewReady">): DesignStatus {
  if (chat.archived) return "Archived";
  if ((chat.latestTurn && ACTIVE_TURNS.has(chat.latestTurn.status)) || chat.lastMessage?.pending) return "Building";
  // Updated servers confirm that the hosted index file exists. Missing means
  // an older server, where the established preview URL remains the signal.
  return chat.previewUrl && chat.previewReady !== false ? "Published" : "Draft";
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
export function designCreationErrorMessage(agentTier: unknown, error?: Pick<ServerError, "message" | "status"> & { code?: string }): string {
  if (error?.code === "research_paused") return error.message;
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
/**
 * Whether the design has a live preview page to link to. Updated servers say
 * whether the hosted page exists (previewReady); older ones only give the link.
 */
export function designPreviewPublished(chat: Pick<Chat, "previewUrl" | "previewReady">) {
  return !!chat.previewUrl?.trim() && chat.previewReady !== false;
}

export function designReviewText(chat: Pick<Chat, "title" | "archived" | "latestTurn" | "lastMessage" | "previewUrl" | "previewReady">, focus = "") {
  const lines = [
    `Design review: ${designTitle(chat)}`,
    `Status: ${designStatus(chat)}`,
    `Preview: ${designPreviewPublished(chat) ? chat.previewUrl!.trim() : "Not published yet"}`,
  ];
  if (focus.trim()) lines.push(`Review focus: ${focus.trim()}`);
  lines.push("Please leave feedback in this message's thread.");
  return lines.join("\n");
}

export type DesignFilter = "all" | "mine" | "shared" | "archived";
export const DESIGN_FILTERS: readonly { id: DesignFilter; label: string }[] = [
  { id: "all", label: "All" }, { id: "mine", label: "Mine" }, { id: "shared", label: "Shared with me" }, { id: "archived", label: "Archived" },
];
/**
 * The designs a library view shows: archived ones only under Archived (and only
 * your own can be archived), then a search over the title and author's name.
 */
export function filterDesigns(designs: readonly Chat[], { query = "", filter = "all", mine }: { query?: string; filter?: DesignFilter; mine: ReadonlySet<string> }) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return designs.filter(design => {
    const own = mine.has(design.id);
    if (filter === "archived" ? !(own && design.archived) : own && design.archived) return false;
    if (filter === "mine" && !own) return false;
    if (filter === "shared" && own) return false;
    const haystack = `${designTitle(design)} ${design.author?.name ?? ""}`.toLowerCase();
    return words.every(word => haystack.includes(word));
  });
}
/** The name a duplicate starts with. */
export const duplicateTitle = (chat: Pick<Chat, "title">) => `Copy of ${designTitle(chat)}`.slice(0, 80);
