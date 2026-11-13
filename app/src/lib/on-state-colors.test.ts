// ON-state controls are drawn as white (thumb, tick) on a coloured fill. In dark mode `colors.blue` is the pale link
// colour (#80C7FF), so white on it is about 1.8:1 and an ON switch or a ticked agreement is nearly invisible (WCAG
// 1.4.11 asks 3:1). The fill must be `colors.primary`, which keeps white readable in both themes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { darkColors, lightColors } from "./theme-colors.ts";

const root = path.join(import.meta.dirname, "..");
const files: string[] = [];
(function walk(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p);
  }
})(root);

function ratio(a: string, b: string) {
  const lum = (hex: string) => hex.slice(1).match(/../g)!.map(v => { const c = parseInt(v, 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test("white on the ON-state fill is at least 3:1 in both themes", () => {
  for (const [name, c] of [["light", lightColors], ["dark", darkColors]] as const) {
    assert.ok(ratio("#FFFFFF", c.primary) >= 3, `${name}: white on primary is ${ratio("#FFFFFF", c.primary).toFixed(2)}:1`);
  }
  assert.ok(ratio("#FFFFFF", darkColors.blue) < 3, "the premise: white on dark-mode blue is too faint, so blue must not be an ON fill");
});

test("no switch track or ticked box is filled with colors.blue", () => {
  const offenders: string[] = [];
  for (const f of files) {
    fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const switchTrack = /trackColor=\{\{\s*true:\s*colors\.blue\b/.test(line);
      const tickedBox = /\bbox(On|Checked)\w*:\s*\{[^}]*backgroundColor:\s*colors\.blue\b/.test(line);
      const customTrack = /backgroundColor:\s*\w+\s*\?\s*colors\.blue\b/.test(line) && /track/i.test(line);
      if (switchTrack || tickedBox || customTrack) offenders.push(`${path.relative(root, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], "use colors.primary for an ON-state fill");
});
