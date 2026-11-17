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
  // A recording's follow-ups stay a plain list.
  assert.doesNotMatch(read("app/recordings/[id].tsx"), /<TodoList[^>]*\bboard\b/);
});

test("the details sheet takes a due date and says what happens without one", () => {
  assert.match(editor, /<Text style=\{styles\.label\}>Due \(YYYY-MM-DD\)<\/Text>/);
  assert.match(editor, /<TextInput testID="todo-due-date" accessibilityLabel="Due date, year-month-day"/);
  assert.match(editor, /`Leave it empty and it is due with its release, \$\{releaseDate\(releaseDay\)\}\.` : "Leave it empty and it has no due date\."/);
  assert.match(editor, /if \(dueDate && !DATE_SHAPE\.test\(dueDate\)\) \{ setError\("Due dates look like 2026-11-20"\); return; \}/);
  assert.match(editor, /channelId, dueDate: dueDate \|\| null,/, "an empty field clears the to-do's own date");
});

// "These should basically feed into work log too": a finished to-do's entry says when it was started and whether
// it met its due date, on the screen and in the report, and the board links to the log.
test("the work log says when a finished to-do was started and whether it was on time", async () => {
  const { workLogDue } = await import("./work-log.ts");
  const { buildWorkLogReport } = await import("./saved-report.ts");
  const entry = (due: string | null, at: number, startedAt: number | null = null) => ({
    kind: "todo" as const, id: "todo:done_1", at, todoId: "todo_1", createdAt: 1000, reopenedAt: null, originKind: null, startedAt, due,
    completedBy: { kind: "person" as const, id: "pat", name: "Pat Tester" },
    source: { text: "Confirm the vendor list", projectId: null, projectName: null, releaseId: null, releaseName: null, channelId: null, channelName: null },
  });
  const noon = (day: number) => Date.UTC(2026, 10, day, 17);
  assert.equal(workLogDue(entry("2026-11-20", noon(14)), "America/New_York"), "Due Nov 20, 2026. Done on time");
  assert.equal(workLogDue(entry("2026-11-14", noon(14)), "America/New_York"), "Due Nov 14, 2026. Done on time", "the due day itself is on time");
  assert.equal(workLogDue(entry("2026-11-13", noon(14)), "America/New_York"), "Due Nov 13, 2026. Done 1 day late");
  assert.equal(workLogDue(entry("2026-11-10", noon(14)), "America/New_York"), "Due Nov 10, 2026. Done 4 days late");
  // The day is the reader's: 03:00 UTC on the 15th is still the 14th in New York.
  assert.equal(workLogDue(entry("2026-11-14", Date.UTC(2026, 10, 15, 3)), "America/New_York"), "Due Nov 14, 2026. Done on time");
  assert.equal(workLogDue(entry(null, noon(14))), "");
  assert.equal(workLogDue(entry("soon", noon(14))), "");
  const report = buildWorkLogReport([entry("2026-11-10", noon(14), noon(12))], { period: "all", generatedAt: noon(15), serverName: "Example team", personName: "Pat Tester", timeZone: "America/New_York" }).markdown;
  assert.match(report, /\*\*Started\*\*\n\n> [^\n]*Nov 12, 2026/);
  assert.match(report, /\*\*Due\*\*\n\n> Due Nov 10, 2026\. Done 4 days late/);
  const saved = read("app/saved.tsx");
  assert.match(saved, /\{item\.startedAt \? <Text style=\{styles\.logMeta\}>Started \{savedWorkLabel\(item\.startedAt\)\}<\/Text> : null\}/);
  assert.match(saved, /\{workLogDue\(item\) \? <Text testID=\{`work-log-due-\$\{item\.id\}`\} style=\{styles\.logMeta\}>\{workLogDue\(item\)\}<\/Text> : null\}/);
  assert.match(saved, /useState<"open" \| "completed" \| "history">\(params\.view === "history" \? "history" : "open"\)/);
  assert.match(component, /\{board \? <Button label="Work log" kind="link" compact onPress=\{\(\) => \{ setMenu\(false\); router\.push\(\{ pathname: "\/saved", params: \{ view: "history" \} \}\); \}\} \/> : null\}/);
});

// The owner on the first board: "odd spacing too much vert at places".
test("no empty line above the board, and the lines sit close together", () => {
  const style = (source: string, name: string) => source.match(new RegExp(`\\n  ${name}: \\{([^\\n]*)\\},`))?.[1] ?? "";
  // The owner then: "Move that button top right And it'll be in header and then all that space is saved".
  assert.match(component, /\) : board \? \(\s*\/\/[^\n]*\n\s*count \? <Text testID="todo-count" style=\{styles\.boardFilters\}>\{count\}<\/Text> : null/, "no toolbar line of its own");
  assert.match(component, /\{board \? <Stack\.Screen options=\{!menuButton \? \{ headerRight: undefined, unstable_headerRightItems: undefined \} : Platform\.OS === "ios"/, "the button is in the screen's header");
  assert.match(component, /icon: \{ type: "sfSymbol" as const, name: "line\.3\.horizontal\.decrease" \}, tintColor: colors\.blue, hidesSharedBackground: true, onPress: openMenu/, "the system's own button on iOS");
  assert.match(component, /: \{ headerRight: \(\) => <View style=\{styles\.headerMenu\}>\{menuButton\}<\/View> \}\}/);
  const boardMarkup = component.slice(component.indexOf('<View testID="todo-board"'), component.indexOf("{menu ? ("));
  assert.doesNotMatch(boardMarkup, /menuButton/, "and nowhere on the board itself");
  assert.doesNotMatch(style(list, "row"), /padding/, "a line is as tall as its 44-point target, no more");
  assert.match(style(list, "body"), /minHeight: 44/);
  // In the work log, the facts about a finished to-do are one block.
  const saved = read("app/saved.tsx");
  assert.match(saved, /item\.kind === "todo" \? <View style=\{styles\.logDetails\}>/);
  assert.match(style(saved, "logDetails"), /gap: space\.xxs \/ 2/);
});
