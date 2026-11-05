import type { Projects } from "./projects-store";

// What a new agent chat is about: just the agent (null), vibe coding (a prototype with a
// preview link), or a project you're in (its id). The last choice sticks per person, so the
// Agent tab starts a chat in one tap; the new chat offers the change right above its message box.
export const VIBE_CHOICE = "vibe";

export type NewChatChoice = string | null;

// The storage key for a person's remembered choice ("" means just the agent).
export const choiceKey = (userId: string) => `servant.project.${userId}`;

// A choice the server no longer offers (vibe coding off, a project you left) means "Just the agent".
export function offered(projects: Projects | null, choice: NewChatChoice): boolean {
  if (!projects || !choice) return false;
  return choice === VIBE_CHOICE ? projects.vibe !== false : projects.list.some(p => p.id === choice);
}

export function choiceName(projects: Projects | null, choice: NewChatChoice): string {
  if (!offered(projects, choice)) return "Just the agent";
  return choice === VIBE_CHOICE ? "Vibe coding" : projects?.list.find(p => p.id === choice)?.name ?? "Just the agent";
}

// The POST /v1/chats body for a choice. Vibe coders always build prototypes, whatever they send.
export function newChatOptions(choice: NewChatChoice): { projectId?: string; mode?: "vibe" } {
  return choice === VIBE_CHOICE ? { mode: "vibe" } : choice ? { projectId: choice } : {};
}

// Vibe coding is fixed when a chat is made, so switching to or from it needs a fresh chat;
// moving between projects (or to just the agent) is a PATCH on the same chat.
export function needsNewChat(current: NewChatChoice, next: NewChatChoice): boolean {
  return (current === VIBE_CHOICE) !== (next === VIBE_CHOICE);
}
