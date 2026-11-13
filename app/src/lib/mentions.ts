export type MentionPerson = { id: string; name: string; agent?: boolean };
export type MentionQuery = { start: number; end: number; query: string };

const token = /^[\p{L}\p{M}\p{N}_'’.-]*$/u;
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
export const mentionText = (name: string) => `@${name.trim().replace(/\s+/g, "-")}`;

export function activeMention(text: string, selection: { start: number; end: number }): MentionQuery | null {
  if (selection.start !== selection.end || selection.start > text.length) return null;
  const before = text.slice(0, selection.start);
  const start = before.lastIndexOf("@");
  if (start < 0 || (start > 0 && !/[\s([{]/.test(text[start - 1]!))) return null;
  const query = before.slice(start + 1);
  if (!token.test(query)) return null;
  let end = selection.end;
  while (end < text.length && token.test(text[end]!)) end++;
  return { start, end, query };
}

// The agent isn't a conversation member, but people call it with @agent, so it is offered first, as its own
// special row, whenever the conversation can reach it and what's typed could still become that name.
// @agent is the only name that reaches it. Keep AGENT_HANDLES in step with server/messaging.mjs.
export const AGENT_HANDLES = ["agent"] as const;
export const AGENT_HANDLE = "agent";                  // what picking the row inserts
export const AGENT_MENTION: MentionPerson = { id: "agent", name: AGENT_HANDLE, agent: true };

/** True when the text typed after "@" could still become one of the agent's handles. */
export const matchesAgentHandle = (query: string) => {
  const q = fold(query);
  return AGENT_HANDLES.some(handle => handle.startsWith(q));
};

export function mentionMatches(members: MentionPerson[], me: string, query: string, withAgent = false) {
  const q = fold(query).replace(/-/g, " ");
  const people = members.filter(p => p.id !== me && !p.agent && fold(p.name).includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  return withAgent && matchesAgentHandle(query) ? [AGENT_MENTION, ...people] : people;
}

/** All the ways a message can name the agent, lower case with the @, for highlighting what's typed. */
export const agentMentionNames = () => AGENT_HANDLES.map(handle => `@${handle}`);

export function insertMention(text: string, match: MentionQuery, name: string) {
  const suffix = text.slice(match.end);
  const inserted = mentionText(name) + (/^[,!?;:)]/.test(suffix) ? "" : " ");
  return { text: text.slice(0, match.start) + inserted + suffix.replace(/^ /, ""), cursor: match.start + inserted.length };
}
