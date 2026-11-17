import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const hook = read("./channel-discovery.ts");
const list = read("../components/ChannelList.tsx");

// "Add channels" on Home drew "No more channels" for a frame, then the loader, then the answer: the request
// starts in an effect, so on the first frame nothing was loading and nothing had been found.
test("channels to join are loading from the moment they are asked for until the first answer", () => {
  assert.match(hook, /const \[answered, setAnswered\] = useState\(false\);/);
  assert.match(hook, /finally \{\n\s+if \(ticket === generation\.current\) \{ busy\.current = false; setLoading\(false\); setAnswered\(true\); \}/, "a failure is an answer too");
  assert.match(hook, /loading: loading \|\| \(enabled && !!account && !answered\),/);
});

test("Home asks loading before it says there is nothing to join", () => {
  const status = list.slice(list.indexOf("return discovery.loading ?"));
  assert.ok(status.indexOf("discovery.loading ?") < status.indexOf("No more channels"));
  assert.match(status, /!others\.length \?\n?\s*<Text style=\{styles\.sectionNote\}>No more channels<\/Text>/);
});
