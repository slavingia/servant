// The list of people or commands in a message box: drawn over the conversation, never in its way, and driven by
// the keyboard where there is one.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SUGGESTIONS_MAX_HEIGHT, SUGGESTION_ROW_HEIGHT, activeOption, moveOption, suggestionKey, suggestionsHeight, type SuggestionList } from "./suggestion-list.ts";

const mentions = (count: number, active = activeOption("mention", count, null)): SuggestionList => ({ kind: "mention", count, active });
const commands = (count: number, active = activeOption("command", count, null)): SuggestionList => ({ kind: "command", count, active });

test("the list is as tall as its limit when there is room, and stays on the screen when there is not", () => {
  assert.equal(suggestionsHeight(600), SUGGESTIONS_MAX_HEIGHT);
  assert.equal(suggestionsHeight(SUGGESTIONS_MAX_HEIGHT + 8), SUGGESTIONS_MAX_HEIGHT, "just enough room, with the gap kept over it");
  // A small phone with the keyboard up: 150 points over the box. The list ends under the header, and scrolls.
  assert.equal(suggestionsHeight(150), 142);
  assert.ok(suggestionsHeight(150) < 150);
  // Hardly any room: one row is still shown rather than nothing.
  assert.equal(suggestionsHeight(40), SUGGESTION_ROW_HEIGHT);
  assert.equal(suggestionsHeight(0), SUGGESTION_ROW_HEIGHT);
  // Before the box has been measured, and for a measurement that is not a number: the limit.
  for (const unknown of [null, undefined, NaN, Infinity]) assert.equal(suggestionsHeight(unknown), SUGGESTIONS_MAX_HEIGHT);
  assert.ok(SUGGESTION_ROW_HEIGHT >= 44, "a row is a control a finger can press");
});

test("a mention list starts on its first option; a command list starts on none", () => {
  assert.equal(activeOption("mention", 3, null), 0, "Enter has always picked the first name");
  assert.equal(activeOption("command", 3, null), -1, "Enter has always sent what was typed");
  assert.equal(activeOption("mention", 0, null), -1, "nobody to pick");
  // Where the arrow keys left it, while the same options are listed.
  assert.equal(activeOption("mention", 3, 2), 2);
  assert.equal(activeOption("command", 3, 1), 1);
  // A place the list no longer has falls back to the start.
  assert.equal(activeOption("mention", 2, 5), 0);
  assert.equal(activeOption("command", 2, 5), -1);
});

test("the arrow keys move through the options and wrap around", () => {
  assert.equal(moveOption(0, 3, 1), 1);
  assert.equal(moveOption(2, 3, 1), 0, "past the last is the first");
  assert.equal(moveOption(0, 3, -1), 2, "before the first is the last");
  assert.equal(moveOption(-1, 3, 1), 0, "from none, Down is the first");
  assert.equal(moveOption(-1, 3, -1), 2, "from none, Up is the last");
  assert.equal(moveOption(0, 1, 1), 0);
  assert.equal(moveOption(0, 0, 1), -1);
  assert.deepEqual(suggestionKey({ key: "ArrowDown" }, mentions(3), true), { do: "move", to: 1 });
  assert.deepEqual(suggestionKey({ key: "ArrowUp" }, mentions(3), true), { do: "move", to: 2 });
  assert.deepEqual(suggestionKey({ key: "ArrowDown" }, commands(3), true), { do: "move", to: 0 });
  assert.deepEqual(suggestionKey({ key: "ArrowDown" }, commands(3, 2), false), { do: "move", to: 0 }, "a keyboard on a touch screen moves it too");
});

test("Enter picks the name the list is on, and in a command list only after an arrow key chose one", () => {
  assert.deepEqual(suggestionKey({ key: "Enter" }, mentions(3), true), { do: "pick", index: 0 });
  assert.deepEqual(suggestionKey({ key: "Enter" }, mentions(3, 2), true), { do: "pick", index: 2 });
  // "/help" and Enter runs the command, as it always did: the list does not take the key.
  assert.equal(suggestionKey({ key: "Enter" }, commands(3), true), null);
  assert.deepEqual(suggestionKey({ key: "Enter" }, commands(3, 1), true), { do: "pick", index: 1 });
  // Shift+Enter is a new line. On a touch screen Enter is a new line too.
  assert.equal(suggestionKey({ key: "Enter", shiftKey: true }, mentions(3), true), null);
  assert.equal(suggestionKey({ key: "Enter" }, mentions(3), false), null);
  // "No matches": nothing to pick, so Enter sends.
  assert.equal(suggestionKey({ key: "Enter" }, mentions(0), true), null);
});

test("Tab completes with the option the list is on, or the first", () => {
  assert.deepEqual(suggestionKey({ key: "Tab" }, mentions(3), true), { do: "pick", index: 0 });
  assert.deepEqual(suggestionKey({ key: "Tab" }, commands(3), true), { do: "pick", index: 0 });
  assert.deepEqual(suggestionKey({ key: "Tab" }, commands(3, 2), true), { do: "pick", index: 2 });
  // Shift+Tab goes back to the control before the box, and with nothing listed Tab goes on to the next.
  assert.equal(suggestionKey({ key: "Tab", shiftKey: true }, mentions(3), true), null);
  assert.equal(suggestionKey({ key: "Tab" }, mentions(0), true), null);
});

test("Escape closes the list, whatever it holds", () => {
  for (const list of [mentions(3), mentions(0), commands(3), commands(3, 1)]) assert.deepEqual(suggestionKey({ key: "Escape" }, list, true), { do: "close" });
});

test("keys that belong to something else are left alone", () => {
  // An input method composing a character uses Enter, the arrows and Escape itself.
  for (const key of ["Enter", "ArrowDown", "ArrowUp", "Escape", "Tab"]) {
    assert.equal(suggestionKey({ key, isComposing: true }, mentions(3), true), null, key);
    assert.equal(suggestionKey({ key, keyCode: 229 }, mentions(3), true), null, key);
  }
  // Shortcuts, and moving the caret by a word or selecting with the arrows.
  for (const held of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) assert.equal(suggestionKey({ key: "ArrowDown", ...held }, mentions(3), true), null);
  assert.equal(suggestionKey({ key: "ArrowDown", shiftKey: true }, mentions(3), true), null);
  for (const key of ["a", "Backspace", "ArrowLeft", "ArrowRight", "Home", " "]) assert.equal(suggestionKey({ key }, mentions(3), true), null, key);
});

test("the message box draws the list over the conversation, not in the page between the two", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "../components/Messaging.tsx"), "utf8");
  const style = (name: string) => source.match(new RegExp(`\\n  ${name}: \\{([^\\n]*)\\},?\\n`))?.[1] ?? "";
  // Taken out of the page's flow and hung from the top edge of the box: no message is moved to make room.
  assert.match(style("suggestionsAnchor"), /position: "absolute"/);
  assert.match(style("suggestionsAnchor"), /bottom: "100%"/);
  assert.match(source, /<View style=\{\[styles\.suggestionsAnchor, wide && styles\.suggestionsAnchorWide\]\}>\n\s+<View style=\{styles\.suggestionsCard\}>\n\s+<ScrollView nativeID=\{listId\}/);
  // One list, inside the box's own view, so the box's height does not depend on it.
  assert.equal(source.match(/styles\.suggestionsAnchor,/g)?.length, 1);
  assert.doesNotMatch(source, /\{slash\?\.length \? \(\n\s+<ScrollView/);
  // The surface a menu has: the page color, a border, round corners and a shadow, all from the theme.
  const card = style("suggestionsCard");
  for (const part of [/backgroundColor: colors\.background/, /borderRadius: radius\.md/, /borderColor: colors\.borderStrong/, /boxShadow: `0 10px 28px -6px \$\{colors\.scrim\}`/]) assert.match(card, part);
  assert.match(fs.readFileSync(path.join(import.meta.dirname, "../components/ContextMenu.tsx"), "utf8"), /boxShadow: `0 10px 28px -6px \$\{colors\.scrim\}`/, "the same shadow as the menu");
  // It stays on the screen: its height is capped by the room over the box, and it scrolls.
  assert.match(source, /onLayout=\{event => setListHeight\(suggestionsHeight\(event\.nativeEvent\.layout\.y\)\)\}/);
  assert.match(source, /style=\{\[styles\.suggestions, \{ maxHeight: listHeight \}\]\}/);
  assert.match(source, /keyboardShouldPersistTaps="always"/, "a tap on a row lands with the keyboard up");
  // Both lists only while the box has focus: a list over the messages does not stay when the person turns to them.
  assert.match(source, /const match = focused && !busy \? activeMention\(text, selection\) : null;/);
  assert.match(source, /const slash = commands && focused && !busy && !onCancel \? slashMatches\(/);
});

test("a screen reader in a browser hears the list and the option the keys are on", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "../components/Messaging.tsx"), "utf8");
  assert.match(source, /accessibilityRole=\{Platform\.OS === "web" \? "listbox" : undefined\}\n\s+accessibilityLabel=\{list\.kind === "command" \? "Commands" : "Mention suggestions"\}/);
  // Every row is an option that says whether it is the one a key will pick; on a phone it stays a button.
  const rows = source.match(/accessibilityRole=\{Platform\.OS === "web" \? "option" : "button"\}/g) ?? [];
  assert.equal(rows.length, 3, "a command, the agent, a person");
  assert.equal(source.match(/accessibilityState=\{\{ selected: i === active \}\} aria-selected=\{i === active\}/g)?.length, 3);
  // The box points at the list and at that option, so moving with the arrows is read out without focus leaving the box.
  assert.match(source, /\{\.\.\.\(Platform\.OS === "web" && list \? \{ "aria-autocomplete": "list" as const, "aria-controls": listId, "aria-activedescendant": activeId \} : \{\}\)\}/);
  assert.match(source, /const active = list && enterSends \? list\.active : -1;/, "nothing is marked as picked where no key can pick it");
  // The option a key will pick is marked by more than a tint: a bar in the primary color at its left edge.
  assert.match(source, /suggestionActive: \{ backgroundColor: colors\.subtle, borderLeftColor: colors\.primary \}/);
  assert.equal(source.match(/i === active && styles\.suggestionActive/g)?.length, 3);
  // The keys go through the rules above, before anything else the box does with them.
  assert.match(source, /const listAction = list \? suggestionKey\(key, list, enterSends\) : null;/);
  assert.match(source, /if \(listAction\.do === "close"\) setClosedFor\(latest\.current\.text\);/);
  assert.match(source, /const list = options === null \|\| closedFor === text \? null :/, "closed with Escape, it stays closed until the text changes");
  // And only until then: typing the same text again later opens it (it stayed shut for a second "@" once).
  assert.match(source, /if \(closedFor !== null && closedFor !== text\) setClosedFor\(null\);/);
});
