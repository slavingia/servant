// A message list is drawn again whenever its screen re-renders (a typing line, an error, a reaction): with
// rows built inline, every message on screen was drawn again each time. A row is now memoized and is handed the
// same handlers for as long as the screen is open, so it is drawn again only when its own message changes.
// This reads the screens, like the design-rule tests, so a new inline handler shows up here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

/** Every `<Name ... />` element in a source file, as text. */
function elements(source: string, name: string) {
  const found: string[] = [];
  for (let at = source.indexOf(`<${name}`); at >= 0; at = source.indexOf(`<${name}`, at + 1)) {
    if (/[A-Za-z0-9_.]/.test(source[at + name.length + 1] ?? "")) continue;
    let depth = 0, end = at;
    for (; end < source.length; end++) {
      if (source[end] === "{") depth++;
      else if (source[end] === "}") depth--;
      else if (depth === 0 && source[end] === ">" && source[end - 1] !== "=") break;
    }
    found.push(source.slice(at, end + 1));
  }
  return found;
}

test("a message row is memoized and takes handlers that are given the post", () => {
  const source = read("components/Messaging.tsx");
  assert.match(source, /export const PostRow = memo\(function PostRow\(/);
  for (const handler of ["onOpenThread", "onEdit", "onDelete", "onAskAgent"]) assert.match(source, new RegExp(`${handler}\\?: \\(post: Post\\) => void`), handler);
  assert.match(source, /onReact\?: \(post: Post, emoji: string, active: boolean\) => Promise<void>/);
});

for (const file of ["app/c/[id].tsx", "app/thread.tsx"]) {
  test(`${file} hands every message row the same handlers and the list the same rows`, () => {
    const source = read(file);
    const rows = elements(source, "PostRow");
    assert.ok(rows.length > 0, "the screen renders message rows");
    // An arrow function written in a row's props is a new handler on every render.
    for (const row of rows) assert.doesNotMatch(row, /=>/, row);
    const lists = elements(source, "FlatList").filter(list => /renderItem=/.test(list));
    assert.equal(lists.length, 1);
    assert.match(lists[0]!, /renderItem=\{renderItem\}/);
    assert.match(lists[0]!, /keyExtractor=\{postKey\}/);
    assert.doesNotMatch(lists[0]!, /contentContainerStyle=\{\{/);
    assert.match(source, /const renderItem = useCallback\(/);
    assert.match(source, /useStableCallback\(/);
  });
}

test("the conversation's list of rows is built once per change of its messages", () => {
  assert.match(read("app/c/[id].tsx"), /const data = useMemo\(\(\) => groupActivity\(/);
});
