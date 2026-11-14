// Feedback queue rows (design audit). Each response carried a full-width "Reply by email" button, the same hint
// under it on every row and a full-width "Review" button, so three responses filled a phone screen with buttons.
// And "Surveys" added another copy of the Surveys screen each time, so Back went Surveys, queue, Surveys, queue.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(import.meta.dirname, "../app/queue.tsx"), "utf8");

test("a row's buttons are as wide as their words", () => {
  // An actions row lays buttons out side by side at their own width; a button placed straight in the row stretches.
  for (const label of ["Reply by email", "Review", "Delete response"]) {
    assert.match(source, new RegExp(`<View style=\\{styles\\.actions\\}><Button label="${label}"`), `${label} sits in an actions row`);
  }
});

test("the reply hint is not repeated under every response", () => {
  assert.doesNotMatch(source, /Opens your email app/);
  assert.match(source, /Could not open your email app\. Copy the contact email below/, "what to do is still said when the email app does not open");
});

test("Surveys returns to the Surveys screen instead of adding another copy", () => {
  assert.doesNotMatch(source, /router\.dismissTo\(\{ pathname: '\/surveys'/, "the Surveys button became a tab");
  assert.match(source, /<FeedbackTabs current="responses" survey=\{detail\?\.survey\.id\} disabled=\{busy\} \/>/);
  assert.doesNotMatch(source, /router\.push\(\{ pathname: '\/surveys'/);
});
