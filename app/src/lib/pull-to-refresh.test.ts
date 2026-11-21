import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Pull to refresh shows the app's tennis ball, not the system spinner.
const src = path.join(import.meta.dirname, "..");
const files = (fs.readdirSync(src, { recursive: true, encoding: "utf8" }) as string[])
  .map(file => file.split(path.sep).join("/"))
  .filter(file => /\.tsx$/.test(file) && file !== "components/BallRefreshControl.tsx");

test("every pull to refresh is the ball", () => {
  let found = 0;
  for (const file of files) {
    const source = fs.readFileSync(path.join(src, file), "utf8");
    assert.doesNotMatch(source, /<RefreshControl\b/, `${file}: use BallRefreshControl`);
    // A list given onRefresh itself draws the system spinner.
    if (!/BallRefreshControl/.test(source)) assert.doesNotMatch(source, /\bonRefresh=\{/, `${file}: use BallRefreshControl`);
    if (/<BallRefreshControl\b/.test(source)) found++;
  }
  assert.ok(found >= 10, "the lists that refresh use it");
});

test("Android draws the ball over an invisible system spinner; iOS keeps the system spinner, with no view beside it", () => {
  const control = fs.readFileSync(path.join(src, "components/BallRefreshControl.tsx"), "utf8");
  assert.match(control, /colors=\{\["transparent"\]\} progressBackgroundColor="transparent"/);
  assert.match(control, /<ServeLoader size=\{BALL\} immediate/);
  // A view returned beside the iOS control became list content and pushed every tab's title under the clock.
  const ios = control.slice(control.indexOf('Platform.OS === "ios"'), control.indexOf('Platform.OS === "android"'));
  assert.match(ios, /return <RefreshControl \{\.\.\.rest\} refreshing=\{refreshing\} tintColor=\{colors\.blue\} \/>;/);
  assert.doesNotMatch(ios, /<>|<View/);
});
