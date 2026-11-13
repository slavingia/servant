// One text field (docs/design-system.md, `controls.input`): body type, 48 points, a `borderStrong` outline, 10-point
// corners. Twenty fields had drawn their own: 6-point corners with 12-point padding (text shortcuts, dates, search in
// sheets), a faint `line` outline (project fields, New project), no outline on a grey fill (To-dos), and on You a
// field with no outline or label and "Save" as blue words. A form is a label, the shared field, then the main action
// and Cancel.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const files = fs.readdirSync(root, { recursive: true, encoding: "utf8" }).filter(file => file.endsWith(".tsx")).map(file => file.split(path.sep).join("/"));

// Fields that sit inside something that already draws the boundary, or that are a line of a list, and why.
const INNER: Record<string, string> = {
  "components/Messaging.tsx:input": "the composer's field, inside the composer's box",
  "components/Omnibar.tsx:input": "the search field, inside the search panel's header",
  "app/new-channel.tsx:nameInput": "inside a shared field that shows # or a lock before the name",
  "app/new-message.tsx:search": "the To: line of a new message",
  "components/TodoList.tsx:words": "a line of a to-do list, edited where it is read: a box around it would make every line a form",
};

test("every text field is the shared input", () => {
  const own: string[] = [];
  let fields = 0;
  for (const file of files) {
    const source = read(file);
    for (const tag of source.match(/<TextInput\b[\s\S]*?\/>/g) ?? []) {
      fields++;
      const name = tag.match(/style=\{\[?\s*styles\.(\w+)/)?.[1];
      if (!name) { own.push(`${file}: a field with no style from the sheet`); continue; }
      if (`${file}:${name}` in INNER) continue;
      const definition = source.match(new RegExp(`\\b${name}: (controls\\.input\\b|\\{[^{}]*\\})`))?.[1] ?? "";
      if (!/controls\.input\b/.test(definition)) own.push(`${file}:${name}`);
    }
  }
  assert.ok(fields >= 40, "found the fields");
  assert.deepEqual(own, [], "base the style on controls.input, or list the field above with its reason");
  for (const key of Object.keys(INNER)) { const [file, name] = key.split(":"); assert.match(read(file!), new RegExp(`styles\\.${name}\\b`), `${key} is still there`); }
});

test("every text field has a name a screen reader can say", () => {
  const unnamed: string[] = [];
  for (const file of files) for (const tag of read(file).match(/<TextInput\b[\s\S]*?\/>/g) ?? []) {
    if (!/accessibilityLabel=|aria-label=|accessibilityLabelledBy=/.test(tag)) unnamed.push(`${file}: ${tag.slice(0, 80)}`);
  }
  assert.deepEqual(unnamed, []);
});

test("You's name and work email are forms: a label, the shared field, the main action, then Cancel", () => {
  const you = read("app/(tabs)/you.tsx");
  for (const label of ["Your name", "Work email", "Six-digit code"]) assert.match(you, new RegExp(`<Text style=\\{styles\\.fieldLabel\\}>${label}</Text>`), `${label} has a label that stays`);
  assert.match(you, /\n  field: controls\.input,/);
  for (const id of ["name-save", "email-send", "email-confirm"]) assert.match(you, new RegExp(`<Button testID="${id}" label="[^"]+" compact busy=`), `${id} is the shared primary button`);
  assert.match(you, /<Button label="Cancel" kind="link" compact /);
  assert.doesNotMatch(you, /"Saving…" : "Save"/, "the button shows it is busy; the words do not change");
});

test("the search panel's field leaves room for the focus ring", () => {
  // The ring a browser draws around the focused field sat on the first letter of "Search".
  assert.match(read("components/Omnibar.tsx"), /\n  input: \{[^\n]*paddingHorizontal: space\.xs, borderRadius: radius\.sm \},/);
});
