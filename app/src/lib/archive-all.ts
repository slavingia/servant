// Hold Archive on a swiped row to archive every row in that list (or hold Restore to restore every archived one).
// Each row moves at once and the server is asked for them a few at a time; the ones it refuses come back.

/** The rows a hold would move: the ones in the list not already where the hold sends them. */
export function rowsToMove<T extends { id: string; archived?: boolean }>(rows: readonly T[], archive: boolean): T[] {
  return rows.filter(row => !!row.archived !== archive);
}

/** "Archive all", "Restore all": what the held button does, spoken and in the hint. */
export function allLabel(archived: boolean) {
  return archived ? "Restore all" : "Archive all";
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const count = (n: number) => n < 10 ? WORDS[n] : String(n);

/** What to say when the server refused some: "Couldn't archive two of 12 conversations. Try again." */
export function allFailed(failed: number, total: number, archive: boolean, noun = "conversations") {
  return `Couldn't ${archive ? "archive" : "restore"} ${count(failed)} of ${count(total)} ${noun}. Try again.`;
}

/** Runs `call` for every row, `width` at a time. Resolves with the rows it failed for, in list order. */
export async function forEachRow<T>(rows: readonly T[], call: (row: T) => Promise<unknown>, width = 4): Promise<T[]> {
  const failed = new Set<T>();
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      try { await call(row); } catch { failed.add(row); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, rows.length) }, worker));
  return rows.filter(row => failed.has(row));
}
