import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(import.meta.dirname, "..", file), "utf8");

test("phone content runs to the top edge with square corners", () => {
  const chrome = read("components/AppChrome.tsx");
  assert.doesNotMatch(chrome, /roundedContent/);
  assert.match(chrome, /fullBleedContent: \{ backgroundColor: colors\.background \}/);
  const phone = chrome.slice(chrome.indexOf("fullBleedContent:"));
  assert.doesNotMatch(phone.split("\n")[0], /Radius/);
});

test("phones have no search bar or navy band; search lives in the wide sidebar", () => {
  const chrome = read("components/AppChrome.tsx");
  assert.doesNotMatch(chrome, /<Omnibar/);
  assert.match(chrome, /signedInRoot: \{ backgroundColor: colors\.background \}/);
  assert.match(chrome, /statusArea: \{ backgroundColor: colors\.background \}/);
  assert.match(read("components/Sidebar.tsx"), /<Omnibar variant="sidebar" \/>/);
});

test("the phone status bar is dark on the white top", () => {
  assert.match(read("app/_layout.tsx"), /\(paired && wide\) \|\| pathname === "\/welcome"/);
});
