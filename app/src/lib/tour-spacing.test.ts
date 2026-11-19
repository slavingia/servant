// The onboarding tour's spacing: everything stacked on a page sits space.stack (20) from its neighbors, set once as
// a gap on what holds them and not as a margin on each. scripts/onboarding-tour-e2e.mjs measures the same in a browser.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
const tour = read("app/tour.tsx");
const style = (name: string) => tour.match(new RegExp(`^  ${name}: \\{(.*)\\},$`, "m"))?.[1] ?? assert.fail(`tour.tsx has no ${name} style`);

test("the stack gap is 20", () => {
  assert.match(read("lib/theme.tsx"), /export const space = \{[^}]*\bstack: 20\b/);
});

test("a tour page, its points, the example and the could-not-load message stack with the one gap", () => {
  assert.match(style("content"), /paddingVertical: space\.stack, gap: space\.stack/, "the page, from the top bar to its end");
  for (const name of ["points", "example", "failed"]) assert.match(style(name), /\bgap: space\.stack\b/, name);
});

test("nothing on a tour page sets its own distance above or below", () => {
  assert.doesNotMatch(tour, /\bmargin(?:Top|Bottom|Vertical)\b/, "a gap on the container, not a margin on each child");
  assert.doesNotMatch(tour, /<PageTitle/, "PageTitle brings margins of its own; the tour has its own title group");
});

test("what stays close: a title with its explanation, and a label with the list it names", () => {
  assert.match(style("heading"), /\bgap: space\.xxs\b/);
  assert.match(style("group"), /\bgap: space\.xs\b/);
});
