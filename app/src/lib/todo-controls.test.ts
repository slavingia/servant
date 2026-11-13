// To-dos. First (design audit): every control is at least 44 points by its own size, with no hit slop.
// Then the owner's note on the screen, "Soooo busy": two rows of filter chips, Refresh and Choose links, and on every
// row a blue Send button, a "..." grip and colored tags. It is now a plain list, a box and the words, like a list
// on paper: a row offers its options only while its words are being edited, and everything about the list as a
// whole is behind one icon.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { todoCountLine, todoFilterSummary, todoMeta } from "./todo-list.ts";

const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
const screen = read("app/todos.tsx");
const list = read("components/TodoList.tsx");
const style = (source: string, name: string) => source.match(new RegExp(`\\n  ${name}: \\{([^\\n]*)\\},`))?.[1] ?? "";
const minHeight = (source: string, name: string) => Number(style(source, name).match(/minHeight: (\d+)/)?.[1] ?? 0);
// The list component alone, without the details sheet below it.
const component = list.slice(0, list.indexOf("// Edit one to-do, or tag several at once"));
const rowCode = component.slice(component.indexOf("const row = "), component.indexOf("const count = "));

test("every To-dos control is at least 44 points, without relying on hit slop", () => {
  assert.ok(minHeight(screen, "chip") >= 44, "filter choices");
  assert.ok(minHeight(list, "option") >= 44, "the details sheet's options");
  assert.ok(minHeight(list, "body") >= 44, "a row's words");
  assert.ok(minHeight(list, "adder") >= 44, "the new to-do line");
  assert.ok(minHeight(list, "linkTarget") >= 44, "Choose all");
  assert.match(style(list, "boxTarget"), /width: 44, height: 44/, "the row checkbox");
  assert.doesNotMatch(list, /hitSlop/, "hit slop does nothing in a browser or the Mac app");
  // Every control in the list is one of the sized targets, the shared Button, a whole row, or the sheet's backdrop.
  const controls = list.split("<Pressable").slice(1).map(rest => rest.match(/style=\{\[?([\w.]+)/)?.[1] ?? "no style");
  assert.ok(controls.length >= 6, "found the list's controls");
  const sized = ["styles.boxTarget", "styles.linkTarget", "styles.option", "styles.body", "StyleSheet.absoluteFill"];
  assert.deepEqual(controls.filter(name => !sized.includes(name)), []);
});

test("a row at rest is a box and its words: no Send button, no grip, no colored tags", () => {
  assert.doesNotMatch(component, /agentBtn|agentTarget|styles\.grip|gripProps|<Chip\b|function Chip/, "none of the row's old furniture");
  assert.doesNotMatch(style(list, "row"), /border/, "nothing is drawn between one line and the next");
  const rest = rowCode.slice(rowCode.indexOf(") : (\n          <Pressable accessibilityRole=\"button\" accessibilityLabel={`${t.text}. Edit`}"));
  assert.ok(rest.length > 0, "found the row at rest");
  assert.doesNotMatch(rest, /<Button\b|<IconButton\b/, "no buttons on a row that is not being edited");
  assert.match(rest, /<Text style=\{\[styles\.text, finished && styles\.textDone\]\}>\{t\.text\}<\/Text>\s*\{meta \? <Text style=\{styles\.meta\}>\{meta\}<\/Text> : null\}/);
});

test("who it is for and where it belongs is one quiet line", () => {
  assert.equal(todoMeta({ status: "open", assignee: { name: "Ana Ruiz" }, projectName: "Example app", releaseName: "Spring release", channelName: "launch", withAgent: true }), "Ana Ruiz · Example app · Spring release · #launch · With Agent");
  assert.equal(todoMeta({ status: "open" }), "", "nothing to say, no line");
  assert.equal(todoMeta({ status: "done", doneBy: "agent" }), "Done by Agent");
  assert.equal(todoMeta({ status: "done", doneBy: "Jo Park", projectName: "Example app" }), "Example app · Done by Jo Park");
  assert.equal(todoMeta({ status: "open", doneBy: "Jo Park" }), "", "only a finished to-do says who finished it");
  assert.match(style(list, "meta"), /typography\.caption, color: colors\.muted/);
});

test("tapping the words edits them in place, and only then does the row offer its options", () => {
  assert.match(rowCode, /\{active \? \(\s*<View style=\{styles\.body\}>\s*<TextInput testID="todo-words" accessibilityLabel="What needs doing" autoFocus multiline value=\{words\}/, "the words become a field where they were");
  assert.match(rowCode, /onBlur=\{\(\) => void finishWords\(t\)\}/, "leaving the field saves and puts the options away");
  assert.match(rowCode, /<View testID="todo-options" style=\{styles\.options\} \{\.\.\.KEEP_EDITING\}>/, "pressing an option does not end the edit before the press lands");
  assert.match(rowCode, /<Button label="Send to Agent" kind="link" compact onPress=\{\(\) => void send\(t\)\} \/>/);
  assert.match(rowCode, /<Button label="Open chat" kind="link" compact/);
  assert.match(rowCode, /<Button label="Details" accessibilityLabel=\{`Details of: \$\{t\.text\}`\} kind="link" compact onPress=\{\(\) => \{ setActiveId\(null\); setEditingId\(t\.id\); \}\} \/>/);
  // The field looks like the words it replaced: the same type, no box.
  assert.match(style(list, "words"), /\.\.\.typography\.body, color: colors\.ink, padding: 0, margin: 0, borderWidth: 0, backgroundColor: "transparent"/);
  // What is saved: only words that changed, and never nothing.
  assert.match(component, /if \(!next \|\| next === t\.text\) return;\s*await run\(t\.id, \(\) => api\.updateTodo\(account, t\.id, \{ text: next \}\)/);
});

test("a new to-do is the next line of the list, not a boxed field with a button", () => {
  assert.match(component, /<TextInput ref=\{adder\} testID="todo-add" accessibilityLabel="New to-do"[^\n]*placeholder="New to-do"/);
  assert.match(component, /onSubmitEditing=\{\(\) => void add\(\)\} onBlur=\{\(\) => void add\(\)\} blurOnSubmit=\{false\}/, "Return adds it and the line stays ready for another");
  assert.doesNotMatch(component, /addBtn|styles\.addRow/);
});

test("the list has one line above it, and one icon for everything about the list as a whole", () => {
  assert.equal(todoCountLine(5, 0), "5 to do");
  assert.equal(todoCountLine(5, 2), "5 to do · 2 done");
  assert.equal(todoCountLine(0, 3), "All 3 done");
  assert.equal(todoCountLine(0, 0), "");
  assert.equal(todoCountLine(5, 0, "Mine · Example app"), "5 to do · Mine · Example app");
  assert.equal(todoCountLine(0, 0, "Mine"), "Mine", "an empty filtered list still says what is filtered");
  assert.equal(todoFilterSummary({ mine: false, done: false }), "", "everyone's open to-dos is the plain list");
  assert.equal(todoFilterSummary({ mine: true, project: "Example app", release: "Spring release", done: true }), "Mine · Example app · Spring release · With done");
  assert.match(component, /<IconButton testID="todo-menu" icon="sort" label=\{filters \? "Filter and options" : "Options"\}/);
  assert.doesNotMatch(component, /Refresh to-dos|Choose several to tag|toolbarActions/, "no row of links above the list");
  // What the icon opens: the screen's filters, then tagging several, sending all, and a refresh.
  const sheet = component.slice(component.indexOf('testID="todo-menu-sheet"'));
  assert.match(sheet, /\{filters\}/);
  assert.match(sheet, /<Button label="Tag several" kind="secondary"/);
  assert.match(sheet, /<Button label=\{`Send all \$\{sendable\.length\} to Agent`\} kind="secondary"/);
  assert.match(sheet, /<Button label="Refresh" kind="link" compact/);
  // The screen draws no filters of its own any more: it hands them to the list.
  assert.match(screen, /<TodoList account=\{account\} todos=\{todos\} allowAdd=\{!selectedId\} filters=\{filters\} filterSummary=\{summary\}/);
  const body = screen.slice(screen.indexOf("<ScrollView style={styles.root}"));
  assert.doesNotMatch(body, /chip\(|radiogroup/, "nothing but the list on the screen");
});

test("Show done is a switch of its own, not a third choice beside Everyone's and Mine", () => {
  const start = screen.indexOf('accessibilityLabel="Whose to-dos"');
  const group = screen.slice(start, screen.indexOf("</View>", start));
  assert.match(group, /Everyone's/);
  assert.match(group, /Mine/);
  assert.doesNotMatch(group, /done/i, "the group holds the two choices only");
  assert.match(screen, /<Toggle value=\{showDone\} label="Show done" disabled=\{writing\} onValueChange=\{setShowDone\} \/>/);
  assert.doesNotMatch(screen, /Hide done/, "the label stays put; the switch shows the state");
});
