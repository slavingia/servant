import type { TodoItem, TodoStage } from "./server.ts";
import { DATE_SHAPE, localDate, releaseDate } from "./releases.ts";

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

// The board: three columns by status. To do and In progress are both open to-dos; In progress is one that has begun.
export const TODO_STAGES: TodoStage[] = ["todo", "doing", "done"];
export const STAGE_LABEL: Record<TodoStage, string> = { todo: "To do", doing: "In progress", done: "Done" };
/** A to-do's column. A server from before the board sends none: open is To do. */
export const todoStage = (todo: Pick<TodoItem, "status" | "stage">): TodoStage => todo.status === "done" ? "done" : todo.stage === "doing" ? "doing" : "todo";

/** The columns of the board: open to-dos in their own order, finished ones newest first. */
export function boardColumns(todos: readonly TodoItem[]): Record<TodoStage, TodoItem[]> {
  const columns: Record<TodoStage, TodoItem[]> = { todo: [], doing: [], done: [] };
  for (const todo of [...todos].sort((a, b) => a.position - b.position)) columns[todoStage(todo)].push(todo);
  columns.done.sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  return columns;
}

/**
 * When a to-do is due, in a few words: "Due Nov 20", "Due today", or "Overdue, Nov 10" once the day has passed.
 * The day is its own, or its release's when it has none. A finished to-do is not due any more.
 */
export function dueLine(todo: Pick<TodoItem, "status" | "due">, today = localDate(), now = new Date()): { text: string; overdue: boolean } | null {
  if (todo.status === "done" || !todo.due || !DATE_SHAPE.test(todo.due)) return null;
  if (todo.due === today) return { text: "Due today", overdue: false };
  const day = releaseDate(todo.due, now);
  return todo.due < today ? { text: `Overdue, ${day}`, overdue: true } : { text: `Due ${day}`, overdue: false };
}
