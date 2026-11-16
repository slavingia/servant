// A conversation you just read stays read in the list, even if a list the server answered a moment before
// arrives afterwards. Without this, opening a chat and going back showed it unread again for a second, and
// the app icon could be set back to the old count by the same late answer.
//
// What is kept is a small note per conversation: the last message you had seen, as a message id, and when.
// A server list loses to the note while it still says you had read less than that. Once the server says you
// read that far (`readThrough`), or a newer message arrives, or two minutes pass, the note is dropped and the
// server is believed again.
export type ReadNote = { through: number; at: number };
export type ReadNotes = Map<string, ReadNote>;
type Row = { id: string; unread: number; readThrough?: string; lastMessage?: { id: string } | null };

const KEEP_MS = 120000;
const place = (value: unknown) => typeof value === "string" && /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

/** Remember that `id` has been read through message `through`. An older place never replaces a newer one. */
export function noteRead(notes: ReadNotes, id: string, through: unknown, now: number) {
  const seq = typeof through === "number" ? through : place(through);
  if (seq === null) return;
  const before = notes.get(id);
  if (before && before.through > seq && now - before.at < KEEP_MS) return;
  notes.set(id, { through: seq, at: now });
}

/** The server's list with what you have read since it was asked for put back. Returns the same rows when no note applies. */
export function applyReadNotes<T extends Row>(list: T[], notes: ReadNotes, now: number): T[] {
  if (!notes.size) return list;
  let changed = false;
  const merged = list.map(row => {
    const note = notes.get(row.id);
    if (!note) return row;
    const server = place(row.readThrough);
    const last = place(row.lastMessage?.id);
    // The server has caught up, a newer message came in, or the note is old: the server is right.
    if (now - note.at >= KEEP_MS || (server !== null && server >= note.through) || (last !== null && last > note.through)) {
      notes.delete(row.id);
      return row;
    }
    if (!row.unread && String(note.through) === row.readThrough) return row;
    changed = true;
    return { ...row, unread: 0, readThrough: String(Math.max(note.through, server ?? 0)) };
  });
  return changed ? merged : list;
}

/** One set of notes for the whole app, shared by the conversation list and the app icon. */
export const readNotes: ReadNotes = new Map();
