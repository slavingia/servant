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

export function mentionMatches(members: MentionPerson[], me: string, query: string) {
  const q = fold(query).replace(/-/g, " ");
  return members.filter(p => p.id !== me && !p.agent && fold(p.name).includes(q)).sort((a, b) => a.name.localeCompare(b.name));
}

export function insertMention(text: string, match: MentionQuery, name: string) {
  const suffix = text.slice(match.end);
  const inserted = mentionText(name) + (/^[,!?;:)]/.test(suffix) ? "" : " ");
  return { text: text.slice(0, match.start) + inserted + suffix.replace(/^ /, ""), cursor: match.start + inserted.length };
}
