// An owner's iPhone showed a long agent chat title drawn under the options button: "Automatically tackle GitHu…"
// with three small dots printed over its end. The title was a view of our own in the system's header, which is
// not kept clear of the buttons beside it, and the button was the text "•••" rather than a button.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(import.meta.dirname, "../app/chat/[id].tsx"), "utf8");

test("on iOS the header title is the system's, which is cut to the room between the buttons", () => {
  assert.match(source, /function titleButton\(open: boolean, setOpen: \(next: boolean\) => void, links = 0\) \{\n  if \(Platform\.OS === "ios"\) return undefined;/);
  assert.match(source, /<Stack\.Screen options=\{\{ title: heading, headerTitle: titleButton\(/, "the title itself is still given to the header");
});

test("on iOS the options button is the system's ellipsis symbol, named for a screen reader, not dots of text", () => {
  assert.match(source, /const HEADER_SYMBOL = \{ more: "ellipsis" \} as const/);
  assert.match(source, /label: link\.accessibilityLabel \?\? link\.label, accessibilityLabel: link\.accessibilityLabel,\n\s+\.\.\.\(link\.icon && link\.icon in HEADER_SYMBOL \? \{ icon: \{ type: "sfSymbol" as const, name: HEADER_SYMBOL\[/);
  assert.match(source, /\{ label: "•••", icon: "more", testID: "open-options", accessibilityLabel: "Chat options"/, "the options link carries the icon and its name");
});

test("the whole title is the first line of the chat's options, since a header shows only its start", () => {
  assert.match(source, /<Pressable testID="chat-options"[^\n]*\n\s+\{\/\* The whole title[^\n]*\n\s+<Text testID="chat-options-title" selectable accessibilityRole="header" style=\{styles\.optionsTitle\}>\{title\}<\/Text>/);
  assert.doesNotMatch(/\n  optionsTitle: \{([^\n]*)\},/.exec(source)![1]!, /numberOfLines/);
});

// The same screenshot showed two things that are already gone: a large Stop button beside "Thinking…" and an
// Abbreviations link above the message box. Keep them gone.
test("Stop lives in the send button and nothing sits above the message box", () => {
  const composer = fs.readFileSync(path.join(import.meta.dirname, "../components/Messaging.tsx"), "utf8");
  const progress = fs.readFileSync(path.join(import.meta.dirname, "../components/AgentSteps.tsx"), "utf8");
  assert.match(composer, /canStop \? "Stop the agent"/);
  assert.doesNotMatch(progress, /label="Stop"/);
  assert.doesNotMatch(composer, /AbbreviationExpander|label="Abbreviations"/);
});
