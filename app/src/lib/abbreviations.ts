export type GlossaryFields = {
  abbreviation: string;
  fullName: string;
  description?: string;
  history?: string;
  wikiUrl?: string;
  repo?: string;
};
export type GlossaryEntry = GlossaryFields & {
  id: string; createdAt: number; updatedAt: number;
  /** Agent's guess for an abbreviation someone used before it was defined. Nobody has kept or corrected it yet. */
  guessed?: boolean;
};

/**
 * The entries that may rewrite what someone types. A guess is in the list, so nobody is asked about it twice, but
 * it changes no one's message until a person has kept or corrected it.
 */
export const confirmedEntries = <T extends { guessed?: boolean }>(entries: readonly T[]): T[] => entries.filter(entry => !entry.guessed);
export type AbbreviationMatch = { start: number; end: number; token: string; entries: GlossaryEntry[] };

export const normalizeAbbreviation = (value: string) => value.trim().toUpperCase();
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = /[\p{L}\p{M}\p{N}_+]/u;
type Range = { start: number; end: number };
const previousCharacter = (text: string, offset: number) => {
  const pair = offset > 1 ? text.codePointAt(offset - 2) : undefined;
  return pair !== undefined && pair > 0xffff ? String.fromCodePoint(pair) : text[offset - 1];
};
const wholeToken = (text: string, start: number, end: number) => {
  const before = previousCharacter(text, start);
  const nextPoint = text.codePointAt(end);
  const after = nextPoint === undefined ? undefined : String.fromCodePoint(nextPoint);
  return !(before && (word.test(before) || /[@/\\]/.test(before))) && !(after && (word.test(after) || /[/\\]/.test(after)));
};

function mergeRanges(ranges: Range[]): Range[] {
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Range[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

// The glossary changes rarely, and text is matched against it constantly: every part of every message row asks.
// What depends on the glossary alone (its terms grouped by their normal form, and the patterns made from every
// term and every full name) was rebuilt on each of those calls, three patterns compiled per piece of text. It
// is now built once per list of entries and kept for as long as that list is. A list is never changed in place:
// a new glossary is a new list.
const longestFirst = (values: Iterable<string>, flags: string) => new RegExp([...values].sort((a, b) => b.length - a.length).map(escapePattern).join("|"), flags);

/** Every match of a kept pattern, in order. A kept pattern remembers where it stopped, so it starts from the top each time. */
function every(pattern: RegExp, text: string): RegExpExecArray[] {
  const found: RegExpExecArray[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    found.push(match);
    if (match[0] === "") pattern.lastIndex++;
  }
  return found;
}

type Replacements = { replacements: RegExp; legacy: RegExp } | null;
const keptReplacements = new WeakMap<readonly GlossaryEntry[], { made: Replacements }>();
function replacementsOf(entries: readonly GlossaryEntry[]): Replacements {
  const kept = keptReplacements.get(entries);
  if (kept) return kept.made;
  const replacements = new Set<string>();
  const legacy = new Set<string>();
  for (const entry of entries) {
    if (!entry.abbreviation.trim() || !entry.fullName.trim()) continue;
    replacements.add(entry.fullName);
    legacy.add(`${entry.fullName.trim()} (${entry.abbreviation.trim()})`);
  }
  const made = replacements.size ? { replacements: longestFirst(replacements, "gu"), legacy: longestFirst(legacy, "giu") } : null;
  keptReplacements.set(entries, { made });
  return made;
}

// Replacement text is final output, even when it contains another shortcut.
// Keep legacy "Full Name (ABBR)" drafts intact as well.
function replacementRanges(text: string, entries: readonly GlossaryEntry[]): Range[] {
  const patterns = replacementsOf(entries);
  if (!text || !patterns) return [];
  const ranges: Range[] = [];
  for (const match of every(patterns.replacements, text)) {
    const start = match.index, end = start + match[0].length;
    const leading = match[0].length - match[0].trimStart().length;
    const trailing = match[0].length - match[0].trimEnd().length;
    if (wholeToken(text, start + leading, end - trailing)) ranges.push({ start, end });
  }
  for (const match of every(patterns.legacy, text)) ranges.push({ start: match.index, end: match.index + match[0].length });
  return ranges;
}

// Scan tokens before classifying links. An unanchored domain/email pattern can
// retry from every character of a long paste (quadratic work when no link exists).
// Here each candidate is scanned once; hostname checks are bounded by DNS limits.
function linkRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const schemeCharacter = /[a-z0-9+.-]/i;
  const emailLocal = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]/i;
  const emailHost = /[a-z0-9.-]/i;
  for (const chunk of text.matchAll(/[^\s<>"']+/g)) {
    const token = chunk[0];
    const add = (start: number, end: number) => ranges.push({ start: chunk.index + start, end: chunk.index + end });
    let explicitLink = false;
    for (let marker = token.indexOf("://"); marker >= 0; marker = token.indexOf("://", marker + 3)) {
      let start = marker;
      while (start > 0 && schemeCharacter.test(token[start - 1]!)) start--;
      if (/^[a-z]$/i.test(token[start] ?? "") && start < marker) {
        add(start, token.length); explicitLink = true; break;
      }
    }
    const lower = token.toLowerCase();
    for (let marker = lower.indexOf("www."); !explicitLink && marker >= 0; marker = lower.indexOf("www.", marker + 4)) {
      if (marker === 0 || !/[a-z0-9_]/i.test(token[marker - 1]!)) {
        add(marker, token.length); explicitLink = true;
      }
    }
    // Addresses may have surrounding punctuation, so find @ first and walk its
    // two sides. Missing @ never causes a scan from every possible local part.
    for (let marker = token.indexOf("@"); marker >= 0; marker = token.indexOf("@", marker + 1)) {
      let start = marker, end = marker + 1;
      while (start > 0 && emailLocal.test(token[start - 1]!)) start--;
      while (end < token.length && emailHost.test(token[end]!)) end++;
      if (start < marker && end > marker + 1) add(start, end);
    }
    if (explicitLink) continue;
    for (const candidate of token.matchAll(/[a-z0-9.-]+/gi)) {
      const raw = candidate[0];
      let begin = 0, finish = raw.length;
      while (begin < finish && raw[begin] === ".") begin++;
      while (finish > begin && raw[finish - 1] === ".") finish--;
      const length = finish - begin;
      if (length < 4 || length > 253) continue;
      const host = raw.slice(begin, finish);
      const labels = host.split(".");
      if (labels.length < 2 || !/^[a-z]{2,}$/i.test(labels.at(-1)!) || labels.some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) continue;
      const start = candidate.index + begin;
      let end = candidate.index + finish;
      if (token[end] === ":") {
        let portEnd = end + 1;
        while (portEnd < token.length && /[0-9]/.test(token[portEnd]!)) portEnd++;
        if (portEnd > end + 1) end = portEnd;
      }
      if (/[/?#]/.test(token[end] ?? "")) end = token.length;
      add(start, end);
    }
  }
  return ranges;
}

// Drafts often contain code or links. Looking up a glossary term must never
// rewrite their destinations, commands, addresses, or an expansion already made.
function protectedRanges(text: string, entries: readonly GlossaryEntry[]): Range[] {
  const ranges: Range[] = linkRanges(text);
  const protect = (pattern: RegExp) => {
    for (const match of text.matchAll(pattern)) ranges.push({ start: match.index, end: match.index + match[0].length });
  };
  protect(/@[^\s<>()\[\]{},;!?]+/g);
  protect(/^[ \t]*\/[^\s/][^\n]*/gm);
  protect(/^[ \t]{0,3}\[[^\]\n]+\]:[^\n]*/gm);

  // Backticks of any length (including unfinished code while typing).
  for (let start = text.indexOf("`"); start >= 0;) {
    let length = 1;
    while (text[start + length] === "`") length++;
    const delimiter = "`".repeat(length);
    let close = text.indexOf(delimiter, start + length);
    while (close >= 0 && (text[close - 1] === "`" || text[close + length] === "`")) close = text.indexOf(delimiter, close + length);
    const end = close < 0 ? text.length : close + length;
    ranges.push({ start, end });
    start = text.indexOf("`", end);
  }
  // Markdown also allows fenced code with tildes. An unclosed fence protects
  // the rest of the draft until its closing line is typed.
  const fences = [...text.matchAll(/^[ \t]{0,3}(~{3,})[^\n]*(?:\n|$)/gm)];
  for (let i = 0; i < fences.length; i++) {
    const open = fences[i]!;
    let close = i + 1;
    while (close < fences.length && (fences[close]![1]!.length < open[1]!.length || !/^[ \t]*~+[ \t]*(?:\n|$)$/.test(fences[close]![0]))) close++;
    const closing = fences[close];
    ranges.push({ start: open.index, end: closing ? closing.index + closing[0].length : text.length });
    i = close;
  }
  // Link labels remain ordinary prose; their balanced destination is protected.
  for (let start = text.indexOf("]("); start >= 0;) {
    let end = start + 2;
    let depth = 1;
    while (end < text.length && depth > 0) {
      if (text[end] === "\\") end++;
      else if (text[end] === "(") depth++;
      else if (text[end] === ")") depth--;
      end++;
    }
    ranges.push({ start: start + 1, end });
    start = text.indexOf("](", end);
  }
  ranges.push(...replacementRanges(text, entries));
  return mergeRanges(ranges);
}

type Terms = { groups: Map<string, GlossaryEntry[]>; defined: GlossaryEntry[]; pattern: RegExp | null };
const keptTerms = new WeakMap<readonly GlossaryEntry[], Terms>();
function termsOf(entries: readonly GlossaryEntry[]): Terms {
  const kept = keptTerms.get(entries);
  if (kept) return kept;
  const groups = new Map<string, GlossaryEntry[]>();
  for (const entry of entries) {
    const key = normalizeAbbreviation(entry.abbreviation);
    if (!key || !entry.fullName.trim()) continue;
    const group = groups.get(key) ?? [];
    if (!group.some(existing => existing.id === entry.id)) group.push(entry);
    groups.set(key, group);
  }
  // Longest first avoids matching the shorter term inside e.g. ABC/DEF.
  const made = { groups, defined: [...groups.values()].flat(), pattern: groups.size ? longestFirst(groups.keys(), "giu") : null };
  keptTerms.set(entries, made);
  return made;
}

/** Find complete terms in prose. Ambiguous terms retain every possible meaning. */
export function findAbbreviations(text: string, entries: readonly GlossaryEntry[]): AbbreviationMatch[] {
  const { groups, defined, pattern } = termsOf(entries);
  if (!text || !pattern) return [];
  const protectedText = protectedRanges(text, defined);
  const matches: AbbreviationMatch[] = [];
  let rangeIndex = 0;
  for (const match of every(pattern, text)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!wholeToken(text, start, end)) continue;
    while (rangeIndex < protectedText.length && protectedText[rangeIndex]!.end <= start) rangeIndex++;
    const protectedRange = protectedText[rangeIndex];
    if (protectedRange && protectedRange.start < end) continue;
    const choices = groups.get(normalizeAbbreviation(match[0]));
    if (choices) matches.push({ start, end, token: match[0], entries: choices });
  }
  return matches;
}

/** Expand known terms; leave ambiguous terms alone until a meaning is selected.
 * Choices map normalizeAbbreviation(term) to an entry id, and apply to every
 * occurrence of that term. Unknown text and spacing are preserved exactly.
 */
export function expandAbbreviations(text: string, entries: readonly GlossaryEntry[], choices: Readonly<Record<string, string>> = {}): string {
  let cursor = 0;
  let result = "";
  for (const match of findAbbreviations(text, entries)) {
    const choice = choices[normalizeAbbreviation(match.token)];
    const entry = choice !== undefined ? match.entries.find(candidate => candidate.id === choice) : match.entries.length === 1 ? match.entries[0] : undefined;
    if (!entry) continue;
    result += text.slice(cursor, match.start) + entry.fullName;
    cursor = match.end;
  }
  return result + text.slice(cursor);
}

/** Project definitions take precedence over global meanings of the same term.
 * Keep every meaning within the winning scope, so ambiguity remains explicit.
 */
export function mergeGlossaryEntries(globalEntries: readonly GlossaryEntry[], projectEntries: readonly GlossaryEntry[]): GlossaryEntry[] {
  const projectTerms = new Set(projectEntries.map(entry => normalizeAbbreviation(entry.abbreviation)));
  return [...globalEntries.filter(entry => !projectTerms.has(normalizeAbbreviation(entry.abbreviation))), ...projectEntries];
}

/** Fewest letters an unfamiliar term needs before it is raised as an abbreviation. */
export const MIN_UNKNOWN_LETTERS = 3;

const ordinaryUppercaseWords = new Set([
  "ALL", "AN", "AND", "ARE", "AS", "AT", "BE", "BUT", "BY", "FOR", "FROM", "IF", "IN", "IS", "IT",
  "NO", "NOT", "OF", "OK", "ON", "OR", "OUR", "PLEASE", "SO", "THAT", "THE", "THESE", "THIS", "TO",
  "THANKS", "WAS", "WE", "WERE", "WITH", "YES", "YOU", "YOUR",
]);

/** Suggest unfamiliar uppercase terms without treating prose, known meanings,
 * or protected syntax as definitions. False positives can be skipped by the user.
 */
export function findUnknownAbbreviations(text: string, entries: readonly GlossaryEntry[]): string[] {
  const protectedText = mergeRanges([...protectedRanges(text, entries), ...findAbbreviations(text, entries)]);
  const known = new Set(entries.map(entry => normalizeAbbreviation(entry.abbreviation)));
  const unknown = new Set<string>();
  let rangeIndex = 0;
  // Consume lowercase parts too; otherwise ABCinside would produce a false ABC.
  for (const match of text.matchAll(/[A-Za-z0-9][A-Za-z0-9_.+-]*/g)) {
    // A sentence-ending period is punctuation; single-letter dotted initials
    // such as U.S. retain their terminal period as part of the abbreviation.
    const token = /^(?:[A-Z]\.){2,}$/.test(match[0]) ? match[0] : match[0].replace(/\.+$/, "");
    // Abbreviations start at three letters: two-letter terms (QA, AB, U.S.) are too common to raise.
    if (token.length > 16 || !/^[A-Z0-9]+(?:[._-][A-Z0-9]+)*(?:\+\+?)?\.?$/.test(token) || (token.match(/[A-Z]/g)?.length ?? 0) < MIN_UNKNOWN_LETTERS) continue;
    const start = match.index, end = start + token.length;
    if (!wholeToken(text, start, end) || known.has(token) || ordinaryUppercaseWords.has(token)) continue;
    while (rangeIndex < protectedText.length && protectedText[rangeIndex]!.end <= start) rangeIndex++;
    if (protectedText[rangeIndex] && protectedText[rangeIndex]!.start < end) continue;
    unknown.add(token);
  }
  return [...unknown];
}
