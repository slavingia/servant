import type { TodoItem, TodoPriority, TodoStage, TodoType } from "./server.ts";
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

// The tracker: what kind of work a to-do is, how much it matters and how big it is.
export const TODO_TYPES: TodoType[] = ["task", "bug", "story", "epic"];
export const TYPE_LABEL: Record<TodoType, string> = { task: "Task", bug: "Bug", story: "Story", epic: "Epic" };
export const TODO_PRIORITIES: TodoPriority[] = ["high", "medium", "low"];
export const PRIORITY_LABEL: Record<TodoPriority, string> = { high: "High", medium: "Medium", low: "Low" };
/** "3 pts", "1 pt", "0.5 pts"; nothing without an estimate. */
export const pointsText = (estimate: number | null | undefined): string => estimate === null || estimate === undefined ? "" : `${estimate} ${estimate === 1 ? "pt" : "pts"}`;

/**
 * The tracker's part of a card's quiet line: "EA-42 · Bug · High · 3 pts · Guest mode · 2 comments". A plain task
 * says only its key, so a list of ordinary to-dos stays as quiet as it was.
 */
export function trackerMeta(todo: Pick<TodoItem, "key" | "type" | "priority" | "estimate" | "parentText" | "commentCount">): { lead: string; tail: string } {
  const lead = [
    todo.key, todo.type && todo.type !== "task" ? TYPE_LABEL[todo.type] : "", todo.priority ? PRIORITY_LABEL[todo.priority] : "",
    pointsText(todo.estimate), todo.parentText,
  ].filter(Boolean).join(" · ");
  const count = todo.commentCount ?? 0;
  return { lead, tail: count ? `${count} ${count === 1 ? "comment" : "comments"}` : "" };
}

export type BoardSort = "manual" | "priority" | "due";
export const SORT_LABEL: Record<BoardSort, string> = { manual: "My order", priority: "Priority", due: "Due date" };
/** Order a column: as dragged, most important first, or soonest due first. Ties keep the dragged order. */
export function sortColumn(todos: readonly TodoItem[], by: BoardSort): TodoItem[] {
  if (by === "manual") return [...todos];
  const rank = (todo: TodoItem) => by === "priority" ? (todo.priority ? TODO_PRIORITIES.indexOf(todo.priority) : TODO_PRIORITIES.length) : 0;
  const due = (todo: TodoItem) => todo.due || "9999-99-99";
  return todos.map((todo, index) => ({ todo, index })).sort((a, b) =>
    (by === "priority" ? rank(a.todo) - rank(b.todo) : due(a.todo).localeCompare(due(b.todo))) || a.index - b.index).map(item => item.todo);
}
/** How many points a column holds, for its heading: "8 pts". Nothing when no to-do in it has an estimate. */
export function columnPoints(todos: readonly TodoItem[]): string {
  const sized = todos.filter(todo => typeof todo.estimate === "number");
  return sized.length ? pointsText(Math.round(sized.reduce((sum, todo) => sum + (todo.estimate ?? 0), 0) * 100) / 100) : "";
}
