// Archiving, restoring or deleting a row shows at once: the change is laid over the list until the
// server has answered. Every copy of the list that arrives meanwhile (a poll, a refresh) gets the
// same change laid over it, so the row does not flicker back. If the server refuses, the change is
// taken off and the row is where it was, with the error shown.
export type RowChange = { archived: boolean } | { deleted: true };
export type RowChanges = ReadonlyMap<string, RowChange>;

/** The list as it reads with the waiting changes applied. The same list when none of them touch it. */
export function withRowChanges<T extends { id: string; archived?: boolean }>(rows: T[], changes: RowChanges): T[] {
  if (!changes.size || !rows.some(row => changes.has(row.id))) return rows;
  const shown: T[] = [];
  for (const row of rows) {
    const change = changes.get(row.id);
    if (!change) shown.push(row);
    else if ("deleted" in change) continue;
    else shown.push(!!row.archived === change.archived ? row : { ...row, archived: change.archived });
  }
  return shown;
}

/** The waiting changes with one added, or taken off when `change` is null. The same map when that changes nothing. */
export function setRowChange(changes: RowChanges, id: string, change: RowChange | null): RowChanges {
  if (!change && !changes.has(id)) return changes;
  const next = new Map(changes);
  if (change) next.set(id, change); else next.delete(id);
  return next;
}
