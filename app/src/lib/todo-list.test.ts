import test from "node:test";
import assert from "node:assert/strict";
import { editableTodos, mergeTodoUpdates, sortTodos } from "./todo-list.ts";
import type { TodoItem } from "./server.ts";

const todo = (id: string, patch: Partial<TodoItem> = {}): TodoItem => ({
  id, text: `Task ${id}`, status: "open", position: Number(id), assignee: null,
  projectId: null, projectName: null, releaseId: null, releaseName: null,
  channelId: null, channelName: null, source: null, chatId: null, withAgent: false,
  createdBy: "pat", createdByName: "Pat Tester", createdAt: 100, updatedAt: 100,
  doneAt: null, doneBy: null, canEdit: true, ...patch,
});

test("successive Agent responses retain earlier chat associations and unrelated latest edits", () => {
  const initial = [todo("1"), todo("2"), todo("3")];
  const first = mergeTodoUpdates(initial, [todo("1", { chatId: "chat_1", withAgent: true, updatedAt: 200 })]);
  const latest = first.map(t => t.id === "3" ? { ...t, text: "Updated elsewhere", updatedAt: 250 } : t);
  const next = mergeTodoUpdates(latest, [todo("2", { chatId: "chat_2", withAgent: true, updatedAt: 300 })]);
  assert.equal(next[0].chatId, "chat_1");
  assert.equal(next[1].chatId, "chat_2");
  assert.equal(next[2].text, "Updated elsewhere");
  assert.equal(initial[0].chatId, null);
});

test("late writes cannot resurrect unavailable tasks or overwrite a newer source", () => {
  const latest = [todo("2", { text: "Current source", canEdit: false, updatedAt: 500 })];
  const stale = [todo("1", { chatId: "chat_removed", updatedAt: 200 }), todo("2", { text: "Old source", updatedAt: 200 })];
  assert.deepEqual(mergeTodoUpdates(latest, stale), latest);
  assert.deepEqual(mergeTodoUpdates([], stale), []);
});

test("batch selection contains only editable tasks, including when permissions change", () => {
  const initial = [todo("1"), todo("2", { canEdit: false }), todo("3", { status: "done" })];
  assert.deepEqual(editableTodos(initial).map(t => t.id), ["1", "3"]);
  const refreshed = initial.map(t => t.id === "1" ? { ...t, canEdit: false } : t);
  assert.deepEqual(editableTodos(refreshed).map(t => t.id), ["3"]);
  assert.equal(initial[0].canEdit, true);
});

test("completion moves a task after open items while preserving saved positions and inputs", () => {
  const initial = [todo("3"), todo("1"), todo("2")];
  assert.deepEqual(sortTodos(initial).map(t => t.id), ["1", "2", "3"]);
  const updated = mergeTodoUpdates(initial, [todo("1", { status: "done", updatedAt: 200, doneAt: 200 })]);
  assert.deepEqual(updated.map(t => t.id), ["2", "3", "1"]);
  assert.deepEqual(initial.map(t => t.id), ["3", "1", "2"]);
  assert.equal(initial[1].status, "open");
});
