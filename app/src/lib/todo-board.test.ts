// To-dos as a board. The owner: "To-dos should be tied to projects and releases with due dates so it's more like
// kanban than just simple todo". Three columns by status; a to-do is due on its own day, or its release's.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TodoItem } from "./server.ts";
import { boardColumns, dueLine, STAGE_LABEL, TODO_STAGES, todoStage } from "./todo-list.ts";

const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
const list = read("components/TodoList.tsx");
const component = list.slice(0, list.indexOf("// Edit one to-do, or tag several at once"));
const editor = list.slice(list.indexOf("// Edit one to-do, or tag several at once"));
const item = (id: string, over: Partial<TodoItem> = {}): TodoItem => ({
  id, text: id, status: "open", position: 1, assignee: null, projectId: null, projectName: null, releaseId: null, releaseName: null,
  channelId: null, channelName: null, source: null, chatId: null, withAgent: false, createdBy: "pat", createdByName: "Pat Tester",
  createdAt: 1, updatedAt: 1, doneAt: null, doneBy: null, canEdit: true, ...over,
});

test("the columns are To do, In progress and Done, and every to-do is in exactly one", () => {
  assert.deepEqual(TODO_STAGES.map(stage => STAGE_LABEL[stage]), ["To do", "In progress", "Done"]);
  assert.equal(todoStage(item("a")), "todo", "a server from before the board sends no stage: open is To do");
  assert.equal(todoStage(item("a", { stage: "doing" })), "doing");
  assert.equal(todoStage(item("a", { status: "done", stage: "doing" })), "done", "done wins");
  const columns = boardColumns([
    item("second", { position: 2 }), item("first", { position: 1 }), item("begun", { stage: "doing", position: 3 }),
    item("older", { status: "done", stage: "done", doneAt: 10, position: 4 }), item("newer", { status: "done", stage: "done", doneAt: 20, position: 5 }),
  ]);
  assert.deepEqual([columns.todo.map(t => t.id), columns.doing.map(t => t.id), columns.done.map(t => t.id)], [["first", "second"], ["begun"], ["newer", "older"]]);
});

test("the due line: the day, today, or overdue once it has passed; a finished to-do is not due", () => {
  const now = new Date(2026, 10, 14);
  const line = (due: string | null, status: "open" | "done" = "open") => dueLine({ status, due }, "2026-11-14", now);
  assert.deepEqual(line("2026-11-20"), { text: "Due Nov 20", overdue: false });
  assert.deepEqual(line("2026-11-14"), { text: "Due today", overdue: false });
  assert.deepEqual(line("2026-11-10"), { text: "Overdue, Nov 10", overdue: true });
  assert.deepEqual(line("2027-01-05"), { text: "Due Jan 5, 2027", overdue: false });
  assert.equal(line(null), null);
  assert.equal(line("soon"), null);
  assert.equal(line("2026-11-10", "done"), null);
  assert.match(list, /\n  overdue: \{ color: colors\.red \},/, "only a day that has passed is red");
});

test("side by side where three columns fit, one at a time where they do not", () => {
  assert.match(component, /const sideBySide = board && boardWidth >= BOARD_MIN_WIDTH;/);
  assert.match(component, /<View testID="todo-board" onLayout=\{event => setBoardWidth\(event\.nativeEvent\.layout\.width\)\}>/, "measured from the room the board has, not the window");
  assert.match(component, /\{\(sideBySide \? TODO_STAGES : \[shown\]\)\.map\(stage => \{/);
  // The picker says which column is chosen to a screen reader and a browser alike.
  assert.match(component, /<View accessibilityRole="radiogroup" accessibilityLabel="Column" style=\{styles\.segments\}>/);
  assert.match(component, /accessibilityRole="radio" accessibilityState=\{\{ checked: on \}\} aria-checked=\{on\} accessibilityLabel=\{`\$\{STAGE_LABEL\[stage\]\}, \$\{columns\[stage\]\.length\}`\}/);
  // New to-dos are typed at the foot of To do, and only there.
  assert.match(component, /\{stage === "todo" \? adderLine : null\}/);
  // The Done column starts with the latest few.
  assert.match(component, /const listed = stage === "done" && !allDone \? items\.slice\(0, DONE_SHOWN\) : items;/);
  assert.match(component, /<Button label=\{`Show all \$\{items\.length\}`\} kind="link" compact onPress=\{\(\) => setAllDone\(true\)\} \/>/);
});

test("a card moves by dragging with a mouse, and from the row being edited everywhere", () => {
  assert.match(component, /const canDrag = sideBySide && Platform\.OS === "web";/);
  assert.match(component, /await run\(t\.id, \(\) => api\.updateTodo\(account, t\.id, \{ stage \}\), "Couldn't move that\. Try again"/);
  assert.match(component, /draggable: true/);
  assert.match(component, /if \(card\) void move\(card, stage\);/, "dropping on a column moves the card there");
  assert.match(component, /if \(!canDrag \|\| !t\.canEdit \|\| selecting \|\| active \|\| !!busy\) return line;/, "a card that cannot be changed, or whose words are being edited, is not picked up");
  assert.match(component, /\{board && !finished \? <Button label=\{stage === "doing" \? "Move to To do" : "Start"\}/);
  // A meeting's follow-ups stay a plain list.
  assert.doesNotMatch(read("app/meetings/[id].tsx"), /<TodoList[^>]*\bboard\b/);
});

test("the details sheet takes a due date and says what happens without one", () => {
  assert.match(editor, /<Text style=\{styles\.label\}>Due \(YYYY-MM-DD\)<\/Text>/);
  assert.match(editor, /<TextInput testID="todo-due-date" accessibilityLabel="Due date, year-month-day"/);
  assert.match(editor, /`Leave it empty and it is due with its release, \$\{releaseDate\(releaseDay\)\}\.` : "Leave it empty and it has no due date\."/);
  assert.match(editor, /if \(dueDate && !DATE_SHAPE\.test\(dueDate\)\) \{ setError\("Due dates look like 2026-11-20"\); return; \}/);
  assert.match(editor, /dueDate: dueDate \|\| null \}\)/, "an empty field clears the to-do's own date");
});
