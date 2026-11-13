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
