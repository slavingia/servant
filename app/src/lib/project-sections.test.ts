// A project's About tab (design audit): "Project shortcuts" arrived as an 18-point bold heading between sections
// whose titles ("Workflow", "People", "Files") are small muted labels. One page, one level of section title.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");

test("Project shortcuts is titled like the sections around it", () => {
  const about = read("components/ProjectAbout.tsx");
  const glossary = read("components/ProjectGlossary.tsx");
  assert.match(about, /\n  section: \{ \.\.\.typography\.label, color: colors\.muted \},/, "the About tab's section title");
  assert.match(glossary, /<Text accessibilityRole="header" style=\{styles\.heading\}>Project shortcuts<\/Text>/);
  assert.match(glossary, /\n  heading: \{ \.\.\.typography\.label, color: colors\.muted, flexGrow: 1 \},/, "the same type and color");
});
