import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { FIRST, preloadOrder } from "./preload-order.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
// Every file the router would list, as it names them.
const routes = (dir: URL, prefix = "./"): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? routes(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`) : /\.tsx?$/.test(entry.name) ? [`${prefix}${entry.name}`] : []);
const keys = routes(new URL("../app/", import.meta.url));

test("the screens opened most are loaded first, and each of them exists", () => {
  const { first } = preloadOrder(keys);
  assert.deepEqual(first, FIRST, "a renamed screen must be renamed here too");
  assert.deepEqual(first.slice(0, 3), ["./c/[id].tsx", "./chat/[id].tsx", "./thread.tsx"]);
});

test("every other screen follows, once; layouts, sign-in screens and non-screens are left out", () => {
  const { first, later } = preloadOrder(keys);
  const all = [...first, ...later];
  assert.equal(new Set(all).size, all.length);
  for (const key of ["./notifications.tsx", "./saved.tsx", "./channel-info.tsx", "./meetings/[id].tsx", "./(tabs)/channels.tsx"]) assert.ok(all.includes(key), key);
  for (const key of all) assert.doesNotMatch(key, /_layout|\/\+|^\.\/(welcome|pair|sign-in|join-server|invite|scan|reverify|index)\.tsx$/, key);
  assert.ok(keys.includes("./_layout.tsx") && keys.includes("./pair.tsx"), "they exist, and are skipped on purpose");
  assert.deepEqual(later, [...later].sort());
  assert.deepEqual(preloadOrder(["./a.tsx", "./notes.md", "./+native-intent.tsx", "./x/_layout.tsx"]), { first: [], later: ["./a.tsx"] });
});

test("the browser loads them once the signed-in app is up; a phone has nothing to load", () => {
  const web = read("./preload-screens.web.ts");
  assert.match(web, /import \{ ctx \} from "expo-router\/_ctx";/, "the router's own list, so the code loaded is the code it will ask for");
  assert.match(web, /await Promise\.all\(first\.map\(load\)\);\n\s+for \(const key of later\) \{ await quiet\(\); await load\(key\); \}/);
  assert.match(web, /if \(started\) return;/);
  assert.match(read("./preload-screens.ts"), /export function preloadScreens\(\) \{\}/);
  assert.match(read("../app/_layout.tsx"), /useEffect\(\(\) => \{ if \(paired\) preloadScreens\(\); \}, \[paired\]\);/);
});
