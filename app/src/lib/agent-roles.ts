// What a person's agent may do, as the owner chooses it on People. The numbers are the server's tiers (usage.mjs
// AGENT_TIERS); they are labels, not ranks, so the list is in the order an owner reads it: least access first.
export type AgentRole = { tier: number; label: string; hint: string };

export const AGENT_ROLES: AgentRole[] = [
  { tier: 0, label: "No agent", hint: "" },
  { tier: 1, label: "Tester", hint: "File GitHub issues only" },
  { tier: 2, label: "Business owner", hint: "Build prototypes only" },
  { tier: 5, label: "Product manager", hint: "GitHub issues and research; no code changes" },
  { tier: 4, label: "User researcher", hint: "Web and skills; no GitHub, files or commands" },
  { tier: 3, label: "Software engineer", hint: "Full access" },
];

export const roleLabel = (tier: number | undefined) => AGENT_ROLES.find(role => role.tier === (tier ?? 0))?.label ?? "Member";
