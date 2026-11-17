import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// On a phone, selectable text inside a long-press bubble shows the system Copy menu on top of the
// message menu. Bubbles select text through the menu's Select text instead; web keeps native selection.
test("message bubbles do not stack the system Copy menu on the message menu", () => {
  const text = read("components/MessageText.tsx");
  assert.match(text, /const selectable = !inMenuBubble \|\| Platform\.OS === 'web';/);
  assert.doesNotMatch(text, /<Text selectable /, "every block uses the bubble-aware flag");
  for (const file of ["components/Messaging.tsx", "app/chat/[id].tsx"]) {
    const source = read(file);
    for (const use of source.match(/<MessageText [^>]*\/>/g) ?? []) assert.match(use, /inMenuBubble/, `${file}: ${use}`);
  }
  const chat = read("app/chat/[id].tsx");
  const forwarded = chat.slice(chat.indexOf("function ForwardedText"), chat.indexOf("function ForwardedText") + 800);
  assert.doesNotMatch(forwarded, /<Text selectable /, "your own messages in an agent chat");
});
