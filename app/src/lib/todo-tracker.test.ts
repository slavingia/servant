// The owner: "Would like basically enough func to use to replace Jira". To-dos carry what a tracker needs: a key, a
// kind, a priority, an estimate, a description, comments and epics. Releases with dates are the sprints.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TodoItem } from "./server.ts";
import { columnPoints, pointsText, sortColumn, trackerMeta } from "./todo-list.ts";

const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
const list = read("components/TodoList.tsx");
const component = list.slice(0, list.indexOf("// Edit one to-do, or tag several at once"));
const editor = list.slice(list.indexOf("// Edit one to-do, or tag several at once"));
const item = (id: string, over: Partial<TodoItem> = {}): TodoItem => ({
  id, text: id, status: "open", position: 1, assignee: null, projectId: null, projectName: null, releaseId: null, releaseName: null,
  channelId: null, channelName: null, source: null, chatId: null, withAgent: false, createdBy: "pat", createdByName: "Pat Tester",
  createdAt: 1, updatedAt: 1, doneAt: null, doneBy: null, canEdit: true, ...over,
});

test("a card's quiet line leads with its key and says only what is set", () => {
  assert.deepEqual(trackerMeta({ key: "EA-42", type: "task", priority: null, estimate: null, parentText: null, commentCount: 0 }), { lead: "EA-42", tail: "" });
  assert.deepEqual(trackerMeta({ key: "EA-42", type: "bug", priority: "high", estimate: 3, parentText: "Guest mode", commentCount: 2 }), { lead: "EA-42 · Bug · High · 3 pts · Guest mode", tail: "2 comments" });
  assert.deepEqual(trackerMeta({ key: "EA-7", type: "epic", estimate: 1, commentCount: 1 }), { lead: "EA-7 · Epic · 1 pt", tail: "1 comment" });
  assert.deepEqual(trackerMeta({}), { lead: "", tail: "" }, "a server from before the tracker adds nothing");
  assert.deepEqual([pointsText(0.5), pointsText(0), pointsText(null), pointsText(undefined)], ["0.5 pts", "0 pts", "", ""]);
  // Only the board shows it: a meeting's follow-ups stay as they were.
  assert.match(component, /const tracker = board \? trackerMeta\(t\) : \{ lead: "", tail: "" \};/);
  assert.match(component, /\{tracker\.lead \? <Text testID="todo-key">\{tracker\.lead\}<\/Text> : null\}/);
});

test("the open columns sort by priority or due date, and a column says how many points it holds", () => {
  const todos = [
    item("none", { position: 1 }), item("low", { position: 2, priority: "low", due: "2026-11-20" }),
    item("high", { position: 3, priority: "high", due: "2026-12-01" }), item("high-too", { position: 4, priority: "high", due: "2026-11-10" }),
  ];
  assert.deepEqual(sortColumn(todos, "manual").map(t => t.id), ["none", "low", "high", "high-too"]);
  assert.deepEqual(sortColumn(todos, "priority").map(t => t.id), ["high", "high-too", "low", "none"], "ties keep the dragged order; no priority is last");
  assert.deepEqual(sortColumn(todos, "due").map(t => t.id), ["high-too", "low", "high", "none"], "no due date is last");
  assert.equal(columnPoints([item("a", { estimate: 3 }), item("b", { estimate: 0.5 }), item("c")]), "3.5 pts");
  assert.equal(columnPoints([item("a"), item("b")]), "", "no estimates, no total");
  assert.match(component, /const items = stage === "done" \? columns\[stage\] : sortColumn\(columns\[stage\], sort\);/);
  assert.match(component, /\|\| \(board && sort !== "manual"\);/, "a sorted column is not reordered by hand");
  assert.match(component, /<View accessibilityRole="radiogroup" accessibilityLabel="Sort by" style=\{styles\.choices\}>/);
  assert.match(component, /\{items\.length\}\{points \? ` · \$\{points\}` : ""\}/);
});

test("Details holds the tracker's fields, and an epic is chosen only from epics", () => {
  for (const label of ["Description", "Type", "Priority", "Estimate \\(points\\)", "Epic", "Jira issue", "Comments"]) assert.match(editor, new RegExp(`<Text style=\\{styles\\.label\\}>${label}</Text>`), label);
  assert.match(editor, /\{TODO_TYPES\.map\(kind => <Option key=\{kind\} label=\{TYPE_LABEL\[kind\]\} on=\{type === kind\}/);
  assert.match(editor, /<Option label="No priority" on=\{priority === null\}/);
  assert.match(component, /epics=\{todos\.filter\(t => t\.type === "epic" && t\.id !== editing\.id\)\}/);
  assert.match(editor, /\{!bulk && type !== "epic" && \(epics\.length \|\| parentId\) \? <>/, "an epic is not put under an epic");
  assert.match(editor, /type, priority, estimate: points \? Number\(points\) : null, description, parentId: type === "epic" \? null : parentId, jiraKey: jiraKey\.trim\(\) \|\| null \}\)/);
  assert.match(editor, /if \(points && !Number\.isFinite\(Number\(points\)\)\) \{ setError\("Give the estimate as a number of points, like 3"\); return; \}/);
});

test("comments are read when Details opens and added without closing it", () => {
  assert.match(editor, /api\.todoComments\(account, todoId\)\.then\(result => \{ if \(live\) setComments\(result\.comments\); \}\)/);
  assert.match(editor, /const result = await api\.addTodoComment\(account, todoId, words\); setComments\(current => \[\.\.\.\(current \?\? \[\]\), result\.comment\]\); setRemark\(""\);/);
  assert.match(editor, /<Button label="Add comment" kind="secondary" compact busy=\{remarking\} disabled=\{!remark\.trim\(\)\}/);
  assert.doesNotMatch(editor, /deleteTodoComment|editComment/, "a comment is not edited or deleted");
  const server = read("lib/server.ts");
  assert.match(server, /todoComments: \(a: Account, id: string\) => request\(a, `\/v1\/todos\/\$\{encodeURIComponent\(id\)\}\/comments`\)/);
});
