// Values written out where a token exists (docs/design-system.md, "Foundations"): a color that is not from the
// palette, a type size, weight or line height beside the roles, a corner radius that is not from `radius`, and
// padding, margin or a gap that is off the spacing scale. token-ratchet.json holds how many each file has today.
// A file may not gain one, and when it loses one its number comes down, so the count only falls.
//
// Most of what is left is deliberate and stays until someone has a reason to move it: the call screen and the
// media viewer are dark in both appearances and carry their own colors, emoji and initials are sized from their
// container, and a few rows sit 2 or 6 points apart.
//
// After removing a literal, lower the file's number by hand, or run
//   WRITE_RATCHET=1 node --test --experimental-strip-types src/lib/token-ratchet.test.ts
// which rewrites the file and never raises a number.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const ledger = path.join(import.meta.dirname, "token-ratchet.json");
const files = (fs.readdirSync(root, { recursive: true, encoding: "utf8" }) as string[])
  .map(file => file.split(path.sep).join("/"))
  .filter(file => /\.tsx?$/.test(file) && !/\.test\.ts$/.test(file) && !/^lib\/theme(-colors)?\.tsx?$/.test(file))
  .sort();

const SCALE = new Set([0, 4, 8, 12, 16, 24, 32, 48]);
const matches = (source: string, pattern: RegExp) => source.match(pattern) ?? [];
export const counters: Record<string, (source: string) => number> = {
  color: source => matches(source, /["'`]#[0-9A-Fa-f]{3,8}["'`]|rgba?\([^)]*\)/g).length,
  type: source => matches(source, /\b(?:fontSize|lineHeight): *\d|\bfontWeight: *["'`]?\d/g).length,
  radius: source => matches(source, /\bborder(?:Top|Bottom)?(?:Left|Right)?Radius: *[1-9]/g).length,
  spacing: source => matches(source, /\b(?:padding|margin)(?:Top|Bottom|Left|Right|Horizontal|Vertical)?: *-?\d+(?:\.\d+)?|\b(?:gap|rowGap|columnGap): *\d+(?:\.\d+)?/g)
    .filter(found => !SCALE.has(Math.abs(Number(found.match(/-?\d+(?:\.\d+)?$/)![0])))).length,
};

type Ledger = Record<string, Record<string, number>>;
function today(): Ledger {
  const now: Ledger = {};
  for (const [kind, count] of Object.entries(counters)) {
    now[kind] = {};
    for (const file of files) { const n = count(fs.readFileSync(path.join(root, file), "utf8")); if (n) now[kind]![file] = n; }
  }
  return now;
}

test("the counters find a literal and pass a token", () => {
  assert.equal(counters.color!(`a: { color: "#C2571A" }, b: { backgroundColor: "rgba(0,0,0,0.35)" }, c: { color: colors.ink }`), 2);
  assert.equal(counters.type!(`a: { fontSize: 14, lineHeight: 20 }, b: { fontWeight: "600" }, c: { ...typography.body }, d: { fontSize: typography.title.fontSize }`), 3);
  assert.equal(counters.radius!(`a: { borderRadius: 8 }, b: { borderRadius: radius.sm }, c: { borderRadius: 0 }, d: { borderTopLeftRadius: 3 }`), 2);
  assert.equal(counters.spacing!(`a: { padding: 16, marginTop: 6, gap: 2 }, b: { paddingVertical: space.xs, marginBottom: -12 }, c: { columnGap: 10 }`), 3);
});

test("no file gains a value that should be a token, and the count only falls", () => {
  const ceilings: Ledger = JSON.parse(fs.readFileSync(ledger, "utf8"));
  const now = today();
  const gained: string[] = [];
  const fell: string[] = [];
  for (const kind of Object.keys(counters)) {
    const allowed = ceilings[kind] ?? {};
    for (const file of new Set([...Object.keys(allowed), ...Object.keys(now[kind]!)])) {
      const have = now[kind]![file] ?? 0, may = allowed[file] ?? 0;
      if (have > may) gained.push(`${kind}: ${file} has ${have}, was ${may}`);
      if (have < may) fell.push(`${kind}: ${file} has ${have}, the ledger says ${may}`);
    }
  }
  if (process.env.WRITE_RATCHET === "1" && !gained.length) fs.writeFileSync(ledger, JSON.stringify(now, null, 2) + "\n");
  assert.deepEqual(gained, [], "use a token: a palette color, a type role, radius.* or space.*");
  if (process.env.WRITE_RATCHET !== "1") assert.deepEqual(fell, [], "good: now lower these numbers in token-ratchet.json so they cannot come back");
});
