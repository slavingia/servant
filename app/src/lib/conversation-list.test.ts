import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// conversation-list.ts imports react-native for Platform, so its three small rules are read from its source here.
const source = read("./conversation-list.ts");
const rules = new Function(`${source
  .replace(/import [^\n]+\n/g, "")
  .replace(/export const RECYCLING_CONVERSATION_LIST[^\n]+\n/, "")
  .replace(/export const /g, "const ")
  .replace(/<T,>/g, "")
  .replace(/: readonly T\[\]|: T \| undefined|: boolean|: number/g, "")}
  return { listOrder, olderNeighbour, isNewest };`)() as {
  listOrder: <T>(items: readonly T[], recycling: boolean) => readonly T[];
  olderNeighbour: <T>(items: readonly T[], index: number, recycling: boolean) => T | undefined;
  isNewest: (count: number, index: number, recycling: boolean) => boolean;
};

test("both lists agree on which message is older and which is newest", () => {
  const newestFirst = ["Wednesday", "Tuesday", "Monday"];
  for (const recycling of [false, true]) {
    const drawn = rules.listOrder(newestFirst, recycling);
    assert.deepEqual(drawn, recycling ? ["Monday", "Tuesday", "Wednesday"] : newestFirst);
    const at = (name: string) => drawn.indexOf(name);
    assert.equal(rules.olderNeighbour(drawn, at("Wednesday"), recycling), "Tuesday");
    assert.equal(rules.olderNeighbour(drawn, at("Tuesday"), recycling), "Monday");
    assert.equal(rules.olderNeighbour(drawn, at("Monday"), recycling), undefined, "nothing is older than the first message");
    assert.deepEqual(drawn.map((_, index) => rules.isNewest(drawn.length, index, recycling)), recycling ? [false, false, true] : [true, false, false]);
  }
  assert.notEqual(rules.listOrder(newestFirst, true), newestFirst, "the order given is not changed in place");
  assert.deepEqual(newestFirst, ["Wednesday", "Tuesday", "Monday"]);
});

test("a browser gets the recycling list and a phone keeps the list it had", () => {
  assert.match(source, /export const RECYCLING_CONVERSATION_LIST = Platform\.OS === "web";/);
  const screen = read("../app/c/[id].tsx");
  assert.match(screen, /RECYCLING_CONVERSATION_LIST \? \(\n(?:\s+\/\/.*\n)*\s+<Activity mode=\{focused \? "visible" : "hidden"\}>\n\s+<FlashList/);
  assert.match(screen, /\) : \(\n\s+<FlatList\n\s+\{\.\.\.readTracking\}\n\s+inverted/, "the phone's list is as it was");
  assert.equal(screen.match(/\{\.\.\.readTracking\}/g)?.length, 2, "both lists report what was read");
  assert.match(screen, /onStartReached=\{onEndReached\}/, "older messages load when the top comes near");
  assert.match(screen, /initialScrollIndex=\{data\.length \? data\.length - 1 : undefined\}/, "it opens at the newest message");
  assert.match(screen, /startRenderingFromBottom: true, autoscrollToBottomThreshold: 0\.2/);
  assert.match(screen, /<View key=\{item\.id\}>/, "a row's own state never moves to another message when its place is reused");
  assert.match(screen, /olderNeighbour\(data, index, RECYCLING_CONVERSATION_LIST\)/);
  assert.match(screen, /isNewest\(data\.length, index, RECYCLING_CONVERSATION_LIST\)/);
});

// Under a thread, Details or Files the page gives the channel no size. Measured at nothing, the recycling
// list forgot its rows' heights and drew twice as many: back in the channel the same scroll position showed
// messages a thousand points from the ones being read. Set aside (React's Activity) it is not measured while
// covered, keeps its rows and its place, and is picked up as it was.
test("a channel under another screen keeps its place: the recycling list is set aside, not measured at nothing", () => {
  const screen = read("../app/c/[id].tsx");
  assert.match(screen, /import \{ Activity, [^}]*\} from "react";/);
  assert.match(screen, /const focused = useIsFocused\(\);/);
  assert.match(screen, /<Activity mode=\{focused \? "visible" : "hidden"\}>\n\s+<FlashList\n[\s\S]*?\/>\n\s+<\/Activity>\n\s+\) : \(\n\s+<FlatList/, "only the browser's list; the phone's is as it was");
});

test("the compiler that saves re-renders is on, and the gesture and animation libraries are the app's own dependencies", () => {
  const config = JSON.parse(read("../../app.json"));
  assert.equal(config.expo.experiments.reactCompiler, true);
  const packages = JSON.parse(read("../../package.json")).dependencies;
  for (const name of ["@shopify/flash-list", "react-native-gesture-handler", "react-native-reanimated", "react-native-worklets"]) assert.ok(packages[name], name);
});
