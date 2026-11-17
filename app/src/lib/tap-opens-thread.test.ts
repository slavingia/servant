import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("on a phone a tap on a message opens its thread, like Slack; touch and hold still opens the actions", () => {
  const messaging = read("../components/Messaging.tsx");
  assert.match(messaging, /const tapOpensThread = Platform\.OS !== "web" && available && onOpenThread \? onOpenThread : undefined;/, "only on a phone, only for a message that is sent, only where a thread can open");
  assert.match(messaging, /onPress=\{tapOpensThread\} onLongPress=\{actions\}/, "the tap opens the thread and the long press keeps the actions");
  assert.match(messaging, /name: "activate", label: tapOpensThread \? "Open thread"/, "VoiceOver's double tap does what a tap does");
  assert.match(messaging, /name: "longpress", label: "Copy, react or open message actions"/, "and the actions stay one gesture away");
});

test("inside a thread a tap opens nothing: the thread screen gives its messages no way to open a thread", () => {
  assert.doesNotMatch(read("../app/thread.tsx"), /onOpenThread=/);
  assert.match(read("../app/c/[id].tsx"), /onOpenThread=\{onOpenThread\}/);
});
