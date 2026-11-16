// A fill with words or an icon on it uses `primary` (or `danger`): those stay dark enough for white in both
// appearances. `blue`, `green` and `red` are foreground colors: in dark mode they turn pale so they can be read on
// a dark surface, and white on them cannot be read. To-dos arrived with white "Send" on `blue` (1.8 to 1 in dark
// mode) and a white check on `green`; a live meeting's mark was a white icon on `green`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const files = fs.readdirSync(root, { recursive: true, encoding: "utf8" }).filter(file => file.endsWith(".tsx")).map(file => file.split(path.sep).join("/"));

// Small marks with nothing on top of them: a paler color in dark mode is right for these.
const MARKS: Record<string, string> = {
  "app/notifications.tsx:radioDot": "the dot of a chosen radio",
  "components/MeetingRecorder.tsx:dot": "the recording dot",
  "app/leaderboard.tsx:bar": "a usage bar",
  "components/ProjectReleases.tsx:barFill": "a release's progress bar",
  "components/ReplyBar.tsx:fill": "how far a reply is through its usual time",
};

test("a fill that carries words or an icon is primary or danger, never a foreground color", () => {
  const wrong: string[] = [];
  for (const file of files) {
    for (const [, name, , color] of read(file).matchAll(/(\w+): \{([^{}]*)\bbackgroundColor: colors\.(blue|blueDark|green|greenDark|red)\b/g)) {
      if (!(`${file}:${name}` in MARKS)) wrong.push(`${file}:${name} (${color})`);
    }
  }
  assert.deepEqual(wrong, []);
  for (const key of Object.keys(MARKS)) { const [file, name] = key.split(":"); assert.match(read(file!), new RegExp(`\\b${name}: \\{[^{}]*backgroundColor: colors\\.`), `${key} is still there`); }
});

test("the palette keeps primary and danger the same in dark mode", async () => {
  const { lightColors, darkColors } = await import("./theme-colors.ts");
  assert.equal(darkColors.primary, lightColors.primary);
  assert.equal(darkColors.danger, lightColors.danger);
  assert.notEqual(darkColors.blue, lightColors.blue, "blue is a foreground color and changes");
});
