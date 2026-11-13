// One switch (docs/design-system.md, "Components"). The switch a browser draws is 40 by 20 points and takes no hit
// slop, so eight settings rows had a control under half the size of everything around it, each repeating the same
// colors. Toggle is that row's control everywhere: the phone's own switch on a phone, and in a browser the track
// and thumb the Deep work switch already drew, inside a 44-point target that Enter and Space flip.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const style = (source: string, name: string) => source.match(new RegExp(`\\n  ${name}: \\{([^\\n]*)\\},`))?.[1] ?? "";
const screens = (fs.readdirSync(root, { recursive: true, encoding: "utf8" }) as string[]).filter(file => /\.tsx$/.test(file)).sort();

test("there is one switch, and in a browser it is a 44-point control", () => {
  const toggle = read("components/Toggle.tsx");
  assert.match(toggle, /export const SWITCH_TARGET = 44;/);
  assert.match(style(toggle, "target"), /minWidth: SWITCH_TARGET, minHeight: SWITCH_TARGET/);
  assert.match(toggle, /accessibilityRole="switch"[^>]*aria-checked=\{value\}/, "the state reaches a screen reader in a browser");
  assert.match(toggle, /onKeyDown/, "Space flips it, as it flips a checkbox");
  const own = screens.filter(file => file !== "components/Toggle.tsx" && /<Switch\b/.test(read(file)));
  assert.deepEqual(own, [], "use Toggle: the switch a browser draws is 40 by 20");
  assert.match(read("components/DeepWorkSwitch.tsx"), /<SwitchPicture on=\{deepWork\}/, "the Deep work row shows the same track and thumb");
});
