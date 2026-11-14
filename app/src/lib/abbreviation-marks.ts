import { findAbbreviations, type GlossaryEntry } from "./abbreviations.ts";

/** A run of message text, and what it stands for when it is a known abbreviation. */
export type AbbreviationPart = { text: string; title?: string };

/** What a hover or tap shows, like Wikipedia's <abbr>: "API: Application programming interface".
 * A term with several meanings lists them all, so nobody is told the wrong one. */
export function abbreviationTitle(token: string, entries: readonly GlossaryEntry[]): string {
  const meanings = [...new Set(entries.map(entry => entry.fullName.trim()).filter(Boolean))];
  return `${token}: ${meanings.join(" or ")}`;
}

/** Split text into plain runs and known abbreviations. The words are never changed: joining every part's
 * text gives back exactly what was written. */
export function abbreviationParts(text: string, entries: readonly GlossaryEntry[]): AbbreviationPart[] {
  // A message is marked each time its row is drawn: opening a conversation again, scrolling back to it. The
  // same words against the same glossary give the same parts, so they are kept instead of worked out again.
  let known = keptParts.get(entries);
  if (!known) keptParts.set(entries, known = new Map());
  const kept = known.get(text);
  if (kept) return kept;
  const parts = markParts(text, entries);
  if (known.size >= MAX_KEPT) known.clear();
  known.set(text, parts);
  return parts;
}

// Per glossary (a new glossary is a new list), up to this many pieces of text.
const MAX_KEPT = 2000;
const keptParts = new WeakMap<readonly GlossaryEntry[], Map<string, AbbreviationPart[]>>();

function markParts(text: string, entries: readonly GlossaryEntry[]): AbbreviationPart[] {
  const parts: AbbreviationPart[] = [];
  let cursor = 0;
  for (const match of findAbbreviations(text, entries)) {
    if (match.start > cursor) parts.push({ text: text.slice(cursor, match.start) });
    parts.push({ text: match.token, title: abbreviationTitle(match.token, match.entries) });
    cursor = match.end;
  }
  if (cursor < text.length || !parts.length) parts.push({ text: text.slice(cursor) });
  return parts;
}
