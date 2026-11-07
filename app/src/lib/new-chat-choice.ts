import type { Projects } from "./projects-store";
import { designChatOptions, isVerifiedDesignChat } from "./designs.ts";
import type { Chat, NewChatOptions } from "./server";

// What a new agent chat is about: just the agent (null), prototyping (a prototype with a
// preview link), or a project you're in (its id). The last choice sticks per person, so the
// Agent tab starts a chat in one tap; the new chat offers the change right above its message box.
export const VIBE_CHOICE = "vibe";

export type NewChatChoice = string | null;

// The storage key for a person's remembered choice ("" means just the agent).
export const choiceKey = (userId: string) => `servant.project.${userId}`;

// A choice the server no longer offers (prototyping off, a project you left) means "Just the agent".
export function offered(projects: Projects | null, choice: NewChatChoice): boolean {
  if (!projects || !choice) return false;
  return choice === VIBE_CHOICE ? projects.vibe !== false : projects.list.some(p => p.id === choice);
}

export function choiceName(projects: Projects | null, choice: NewChatChoice): string {
  if (!offered(projects, choice)) return "Just the agent";
  return choice === VIBE_CHOICE ? "Design Studio" : projects?.list.find(p => p.id === choice)?.name ?? "Just the agent";
}

// The POST /v1/chats body for a choice. Tier 4 names the lane explicitly so a
// Researcher chat can never silently stand in for the prototype agent.
export function newChatOptions(choice: NewChatChoice, agentTier?: number | null): NewChatOptions {
  if (choice === VIBE_CHOICE) return designChatOptions(agentTier);
  return {
    ...(choice ? { projectId: choice } : {}),
    ...(agentTier === 4 ? { requiredAgentRole: "researcher" as const } : {}),
  };
}

/** A newly created replacement must match the lane requested before the old chat is removed. */
export function newChatMatchesChoice(chat: Pick<Chat, "mode" | "agentRole">, choice: NewChatChoice, agentTier?: number | null): boolean {
  if (choice === VIBE_CHOICE) return isVerifiedDesignChat(chat, agentTier);
  return chat.mode !== "vibe" && (agentTier !== 4 || chat.agentRole === "researcher");
}

/** Prototype chats are folder-scoped workspaces; their project context is immutable. */
export function canChangeChatAbout(current: NewChatChoice): boolean {
  return current !== VIBE_CHOICE;
}

// Crossing the prototype boundary would require a fresh chat; the UI separately
// keeps an existing scoped prototype out of the generic picker entirely.
export function needsNewChat(current: NewChatChoice, next: NewChatChoice): boolean {
  return (current === VIBE_CHOICE) !== (next === VIBE_CHOICE);
}

// The agent chat you were last in; the Agent tab reopens it (message box focused) once per app launch.
export const lastChatKey = (userId: string) => `servant.lastChat.${userId}`;
