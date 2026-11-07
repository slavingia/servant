import type { Chat, CollaboratorAccess, Person, ResearchCollaborator } from "./server";
import { researchChatKind } from "./research-studio.ts";

/** Matches the server's cap on one research plan. */
export const MAX_RESEARCH_COLLABORATORS = 10;

/** For callers that must not import the server client (the local preview). */
export type PlanCollaborator = ResearchCollaborator;

export type CollaboratorCandidate = { id: string; name: string; eligible: boolean; reason?: string };

/** Collaborators apply to Research Studio study plans only. */
export function isResearchPlan(chat: Pick<Chat, "title">): boolean {
  return researchChatKind(chat) === "study";
}

/**
 * People the author could add. Eligibility mirrors the server (Researcher
 * tier, not an admin) so the picker can explain why someone is unavailable,
 * but the server still decides on every save.
 */
export function collaboratorCandidates(
  people: readonly Pick<Person, "id" | "name" | "owner" | "agentTier" | "agent">[],
  options: { me: string; authorId?: string; current: readonly Pick<ResearchCollaborator, "id">[] },
): CollaboratorCandidate[] {
  const taken = new Set([options.me, options.authorId ?? options.me, ...options.current.map(person => person.id)]);
  return people
    .filter(person => !person.agent && !taken.has(person.id))
    .map(person => {
      if (person.owner) return { id: person.id, name: person.name, eligible: false, reason: "Admins can already view every plan" };
      if (person.agentTier !== 4) return { id: person.id, name: person.name, eligible: false, reason: "Needs Researcher access" };
      return { id: person.id, name: person.name, eligible: true };
    })
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.name.localeCompare(b.name));
}

export function filterCandidates(candidates: readonly CollaboratorCandidate[], query: string): CollaboratorCandidate[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? candidates.filter(person => person.name.toLocaleLowerCase().includes(needle)) : [...candidates];
}

/** Adds someone, or changes their access if already listed. */
export function withCollaborator(
  current: readonly ResearchCollaborator[],
  person: { id: string; name: string },
  access: CollaboratorAccess,
): ResearchCollaborator[] {
  const existing = current.find(item => item.id === person.id);
  if (existing) return current.map(item => item.id === person.id ? { ...item, access } : item);
  if (current.length >= MAX_RESEARCH_COLLABORATORS) return [...current];
  return [...current, { id: person.id, name: person.name, access, active: true }];
}

export function withoutCollaborator(current: readonly ResearchCollaborator[], id: string): ResearchCollaborator[] {
  return current.filter(item => item.id !== id);
}

/** Only ids and access go to the server; names and status come back from it. */
export function collaboratorPayload(current: readonly ResearchCollaborator[]): { id: string; access: CollaboratorAccess }[] {
  return current.map(({ id, access }) => ({ id, access }));
}

export function accessLabel(access: CollaboratorAccess): string {
  return access === "edit" ? "Can edit" : "Can view";
}

/** The banner a collaborator sees at the top of someone else's plan. */
export function collaborationNotice(access: CollaboratorAccess, authorName: string): { title: string; body: string } {
  return access === "edit"
    ? {
      title: `${authorName} invited you to edit this research plan`,
      body: "Messages you send here go to the restricted Researcher agent, use your own token allowance, and are visible to everyone on this plan.",
    }
    : {
      title: `${authorName} shared this research plan with you`,
      body: "You can read this plan. Give feedback in a channel or DM.",
    };
}

/** Plans other people opened to you, newest activity first. */
export function sharedResearchPlans(others: readonly Chat[]): Chat[] {
  return others
    .filter(chat => !!chat.collaboration && isResearchPlan(chat))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
