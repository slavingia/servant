// Dictated words land at the cursor, with a space on either side when needed.
export function insertDictation(text: string, at: number, spoken: string) {
  const words = spoken.trim();
  if (!words) return { text, cursor: at };
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^[\s,.!?;:)]/.test(after) ? " " : "";
  const inserted = lead + words + trail;
  return { text: before + inserted + after, cursor: at + lead.length + words.length };
}
