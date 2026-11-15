import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { messageBlocks } from "./message-format.ts";
import { quoteOf, withQuote } from "./quote.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("a message's words become quote lines", () => {
  assert.equal(quoteOf("Is the form ready?"), "> Is the form ready?");
  assert.equal(quoteOf("First line\n\nSecond line"), "> First line\n>\n> Second line");
  assert.equal(quoteOf("> an older quote\nMy answer"), "> My answer", "a quote inside the message is not quoted again");
  assert.equal(quoteOf("  \n"), "");
  const long = quoteOf("word ".repeat(200));
  assert.equal(long.length, 502);
  assert.ok(long.endsWith("…"));
});

test("the quote goes ahead of what was typed, with room for the answer", () => {
  assert.equal(withQuote("", "Is the form ready?"), "> Is the form ready?\n\n");
  assert.equal(withQuote("Yes, since this morning", "Is the form ready?"), "> Is the form ready?\n\nYes, since this morning");
  assert.equal(withQuote("kept", ""), "kept", "nothing to quote changes nothing");
});

test("what is sent shows as a quote and then the answer", () => {
  const blocks = messageBlocks(withQuote("Yes, since this morning", "Is the form ready?"), { chat: true });
  assert.deepEqual(blocks, [{ kind: "quote", text: "Is the form ready?" }, { kind: "paragraph", text: "Yes, since this morning" }]);
});

test("messages offer Quote and the reply field takes it", () => {
  const messaging = read("../components/Messaging.tsx"), channel = read("../app/c/[id].tsx"), thread = read("../app/thread.tsx");
  assert.match(messaging, /const onQuote = quoteIt && post\.text && !post\.deleted \? \(\) => quoteIt\(post\) : undefined;/, "only a message with words");
  assert.equal(messaging.match(/\{ (?:text|label): "Quote", onPress: onQuote \}/g)?.length, 2, "in the touch-and-hold sheet and the menu");
  assert.match(messaging, /if \(quote && quote\.at !== quoted\) \{\n\s+setQuoted\(quote\.at\);\n\s+setText\(current => withQuote\(current, quote\.text\)\);/, "each request once");
  assert.match(messaging, /input\.current\?\.focus\(\);\n\s+onQuoted\?\.\(\);/, "the field is ready to type in, and the request is done with");
  for (const screen of [channel, thread]) {
    assert.match(screen, /setQuote\(\{ text: p\.text, at: Date\.now\(\) \}\)/);
    assert.match(screen, /quote=\{quote\} onQuoted=\{quoteTaken\}/);
    assert.match(screen, /const quoteTaken = useStableCallback\(\(\) => setQuote\(null\)\);/);
  }
  assert.match(channel, /onQuote=\{joined \? onQuote : undefined\}/, "someone only reading a channel has no reply field");
});
