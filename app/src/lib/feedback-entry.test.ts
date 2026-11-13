import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Feedback starts from You, then Feedback, or by sharing a screenshot to Servant from the system share sheet.
// The app no longer watches for shakes or screenshots or captures the screen on its own.
test("the app does not capture the screen or listen for shakes and screenshots", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  for (const name of ["expo-screen-capture", "expo-sensors", "react-native-view-shot"]) assert.equal(pkg.dependencies?.[name], undefined, name);
  const layout = readFileSync(new URL("../app/_layout.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(layout, /FeedbackPrompt/);
});
