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

test("the system spinner is there to do the pull, but drawn invisible", () => {
  const control = fs.readFileSync(path.join(src, "components/BallRefreshControl.tsx"), "utf8");
  assert.match(control, /tintColor="transparent"/);
  assert.match(control, /colors=\{\["transparent"\]\} progressBackgroundColor="transparent"/);
  assert.match(control, /<ServeLoader size=\{BALL\} immediate/);
});
