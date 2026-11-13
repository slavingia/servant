import type { TodoItem } from "./server.ts";

export const sortTodos = (todos: readonly TodoItem[]): TodoItem[] => [...todos].sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || a.position - b.position);

/** Apply each response to the latest visible list. Never resurrect an item removed by an access refresh. */
export function mergeTodoUpdates(current: readonly TodoItem[], updates: readonly TodoItem[]): TodoItem[] {
  const byId = new Map(updates.map(todo => [todo.id, todo]));
  return sortTodos(current.map(todo => {
    const update = byId.get(todo.id);
    return update && update.updatedAt >= todo.updatedAt ? update : todo;
  }));
}

export function editableTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos.filter(todo => todo.canEdit);
}

/** "5 to do", "5 to do · 2 done", "All 3 done", with the filters that are on after it. Empty when there is nothing to count. */
export function todoCountLine(open: number, done: number, filters = ""): string {
  const count = open ? `${open} to do${done ? ` · ${done} done` : ""}` : done ? `All ${done} done` : "";
  return [count, filters].filter(Boolean).join(" · ");
}

/**
 * Who a to-do is for and where it belongs, as one quiet line under its words: "Ana Ruiz · Example app · Spring
 * release · #launch". It was a row of colored chips, which made every line of the list as loud as its words.
 */
export function todoMeta(todo: { assignee?: { name: string } | null; projectName?: string | null; releaseName?: string | null; channelName?: string | null; withAgent?: boolean; status: string; doneBy?: string | null }): string {
  return [
    todo.assignee?.name, todo.projectName, todo.releaseName, todo.channelName ? `#${todo.channelName}` : "",
    todo.withAgent ? "With Agent" : "",
    todo.status === "done" && todo.doneBy ? (todo.doneBy === "agent" ? "Done by Agent" : `Done by ${todo.doneBy}`) : "",
  ].filter(Boolean).join(" · ");
}

/** The filters that are on, in a few words, for the line above the list. Nothing when the list is everyone's open to-dos. */
export function todoFilterSummary(on: { mine: boolean; project?: string; release?: string; done: boolean }): string {
  return [on.mine ? "Mine" : "", on.project ?? "", on.release ?? "", on.done ? "With done" : ""].filter(Boolean).join(" · ");
}
