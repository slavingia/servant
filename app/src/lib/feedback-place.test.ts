// The owner: "Combine surveys and feedback queue into a single Feedback". One entry in the sidebar and in You; the
// screen has a tab for the surveys and a tab for the responses.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DESTINATIONS, placeIsOpen } from "./destinations.ts";

const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
const features = { channels: true, directMessages: true, meetings: true };

test("Feedback is one destination, open on either of its two screens", () => {
  const places = DESTINATIONS.filter(place => /survey|feedback/i.test(`${place.id} ${place.label}`));
  assert.deepEqual(places.map(place => [place.id, place.label, place.path, place.surveys]), [["feedback", "Feedback", "/surveys", true]]);
  const place = places[0]!;
  assert.deepEqual(["/surveys", "/queue", "/feedback", "/wiki"].map(pathname => placeIsOpen(place, pathname, undefined, features)), [true, true, false, false]);
});

test("both screens are titled Feedback and carry the same two tabs", () => {
  const layout = read("app/_layout.tsx");
  assert.match(layout, /<Stack\.Screen name="surveys" options=\{\{ title: "Feedback", \.\.\.sidebarScreen \}\} \/>/);
  assert.match(layout, /<Stack\.Screen name="queue" options=\{\{ title: "Feedback", \.\.\.sidebarScreen \}\} \/>/);
  // The screen for telling the maintainers about the app is not the same thing, and no longer shares the name.
  assert.match(layout, /<Stack\.Screen name="feedback" options=\{\{ title: "Send feedback", \.\.\.childScreen \}\} \/>/);
  assert.match(read("app/surveys.tsx"), /<FeedbackTabs current="surveys" survey=\{detail\?\.survey\.id\} disabled=\{busy\} \/>/);
  assert.match(read("app/queue.tsx"), /<FeedbackTabs current="responses" survey=\{detail\?\.survey\.id\} disabled=\{busy\} \/>/);
});

test("a tab says it is chosen, is a full-size target, and switching does not stack a screen", () => {
  const tabs = read("components/FeedbackTabs.tsx");
  assert.match(tabs, /\{ id: "surveys", label: "Surveys", path: "\/surveys" \},\n  \{ id: "responses", label: "Responses", path: "\/queue" \},/);
  assert.match(tabs, /accessibilityRole="tab" accessibilityState=\{\{ selected: on, disabled \}\} aria-selected=\{on\}/);
  assert.match(tabs, /if \(!on\) router\.replace\(\{ pathname: view\.path, params: survey \? \{ survey \} : \{\} \}\);/, "the open survey stays open");
  assert.doesNotMatch(tabs, /router\.push/);
  assert.match(/\n  tab: \{([^\n]*)\},/.exec(tabs)![1]!, /minHeight: 44/);
  assert.doesNotMatch(read("app/surveys.tsx"), /router\.push\(\{ pathname: '\/queue'/);
});
