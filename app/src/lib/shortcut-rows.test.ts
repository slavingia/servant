// Abbreviations (once Text shortcuts, now a page of the wiki) and a project's shortcuts (design audit): every entry was two lines, the pair and then Edit and
// Delete on a line of their own at the far right, so a list of ten short entries filled two phone screens. The
// actions now sit on the entry's line and drop below only when the entry is too long or the screen too narrow.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
const style = (source: string, name: string) => source.match(new RegExp(`\\n  ${name}: \\{([^\\n]*)\\},`))?.[1] ?? "";

for (const [name, file, row, copy, actions] of [
  ["Abbreviations", "components/WikiAbbreviations.tsx", "entry", "columns", "actions"],
  ["Project shortcuts", "components/ProjectGlossary.tsx", "row", "pair", "rowActions"],
] as const) {
  test(`${name}: Edit and Delete sit on the entry's line and wrap below when there is no room`, () => {
    const source = read(file);
    assert.match(style(source, row), /flexDirection: "row", flexWrap: "wrap", alignItems: "center"/, "the entry is one wrapping row");
    assert.match(style(source, copy), /flexGrow: 1, flexBasis: 280/, "the words take the room, and keep enough of it that a phrase is not broken mid-word");
    assert.doesNotMatch(style(source, actions), /justifyContent: "flex-end"/, "the actions are not a line of their own pushed to the right");
    assert.match(style(source, actions), /marginLeft: "auto"/, "they sit at the end of the line, or at the end of the next when wrapped");
    assert.match(source, new RegExp(`<View style=\\{styles\\.${actions}\\}>\\s*<Button label="Edit"`));
  });
}

test("Abbreviations: the heading's columns line up with the entries'", () => {
  const source = read("components/WikiAbbreviations.tsx");
  assert.match(style(source, "abbreviation"), /width: 112/, "a fixed first column, so an entry with actions beside it still lines up with the heading");
  assert.doesNotMatch(style(source, "abbreviation"), /%/);
});
