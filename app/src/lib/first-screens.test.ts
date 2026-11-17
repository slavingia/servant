import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { FIRST_SCREENS_WAIT_MS, firstScreens } from "./first-screens.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
// Every file the router would list, as it names them.
const routes = (dir: URL, prefix = "./"): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? routes(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`) : /\.tsx?$/.test(entry.name) ? [`${prefix}${entry.name}`] : []);
const keys = routes(new URL("../app/", import.meta.url));

test("opening the app at its root waits for the redirect, the tabs and the screen the app lands on", () => {
  assert.deepEqual(firstScreens("/", "/channels", keys), ["./index.tsx", "./(tabs)/_layout.tsx", "./(tabs)/channels.tsx"]);
  assert.deepEqual(firstScreens("/", "/agent", keys), ["./index.tsx", "./(tabs)/_layout.tsx", "./(tabs)/agent.tsx"]);
  assert.deepEqual(firstScreens("", "/channels", keys), firstScreens("/", "/channels", keys));
});

test("opening it on a screen waits for that screen and the layouts above it, not for Home", () => {
  assert.deepEqual(firstScreens("/channels", "/channels", keys), ["./(tabs)/_layout.tsx", "./(tabs)/channels.tsx"]);
  assert.deepEqual(firstScreens("/you", "/channels", keys), ["./(tabs)/_layout.tsx", "./(tabs)/you.tsx"]);
  assert.deepEqual(firstScreens("/c/ch_123", "/channels", keys), ["./c/[id].tsx"]);
  assert.deepEqual(firstScreens("/chat/chat_9?compose=1", "/channels", keys), ["./chat/[id].tsx"]);
  assert.deepEqual(firstScreens("/thread?conv=ch_1&root=5", "/channels", keys), ["./thread.tsx"]);
  assert.deepEqual(firstScreens("/recordings", "/channels", keys), ["./recordings/index.tsx"]);
  assert.deepEqual(firstScreens("/recordings/rec_1", "/channels", keys), ["./recordings/[id].tsx"]);
});

test("an address no screen answers to waits for nothing", () => {
  assert.deepEqual(firstScreens("/no-such-screen", "/channels", keys), []);
  assert.deepEqual(firstScreens("/c", "/channels", keys), []);
  assert.deepEqual(firstScreens("/c/ch_1/extra", "/channels", keys), []);
});

test("a named file beats one that takes any value; groups, layouts and non-screens are never the screen", () => {
  const made = ["./_layout.tsx", "./(app)/_layout.tsx", "./(app)/c/_layout.tsx", "./(app)/c/[id].tsx", "./(app)/c/new.tsx", "./(app)/docs/[...rest].tsx", "./+native-intent.tsx", "./notes.md"];
  assert.deepEqual(firstScreens("/c/new", "/", made), ["./(app)/_layout.tsx", "./(app)/c/_layout.tsx", "./(app)/c/new.tsx"]);
  assert.deepEqual(firstScreens("/c/abc", "/", made), ["./(app)/_layout.tsx", "./(app)/c/_layout.tsx", "./(app)/c/[id].tsx"]);
  assert.deepEqual(firstScreens("/docs/a/b/c", "/", made), ["./(app)/_layout.tsx", "./(app)/docs/[...rest].tsx"]);
  assert.deepEqual(firstScreens("/_layout", "/", made), []);
});

test("the root layout keeps the launch screen up until that code is in, in a browser only, and never forever", () => {
  const layout = read("../app/_layout.tsx");
  assert.match(layout, /const firstScreensIn = useFirstScreens\(ready, paired, pathname, landing\);/);
  assert.match(layout, /<LiveProvider>\n(?:.*\n)?\s*\{!firstScreensIn \? <LaunchScreen \/> : <>/, "the lists load behind the launch screen");
  const web = read("./use-first-screens.web.ts");
  assert.match(web, /import \{ ctx \} from "expo-router\/_ctx";/, "the router's own list, so the code loaded is the code it will ask for");
  assert.match(web, /if \(state === "reading" && ready\) setState\(signedIn \? "loading" : "in"\);/, "decided once: signing in later never covers the open screens");
  assert.match(web, /setTimeout\(done, FIRST_SCREENS_WAIT_MS\)/);
  assert.ok(FIRST_SCREENS_WAIT_MS >= 2000 && FIRST_SCREENS_WAIT_MS <= 8000);
  assert.match(read("./use-first-screens.ts"), /export function useFirstScreens\([^)]*\): boolean \{\n\s+return true;\n\}/, "a phone waits for nothing");
});

test("the redirect from the root keeps the launch screen up while it happens", () => {
  const index = read("../app/index.tsx");
  assert.match(index, /return <><LaunchScreen \/><Redirect href=\{account && validServerKey\(account\.serverKey\) \? landing : "\/welcome"\} \/><\/>;/);
});
