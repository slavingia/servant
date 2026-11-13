import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { channelA11yName, channelVisibility } from "./channel-visibility.ts";

test("private and public channels say different things, in plain words", () => {
  const priv = channelVisibility(true, "Sandbox");
  const pub = channelVisibility(false, "Sandbox");
  assert.equal(priv.label, "Private channel");
  assert.match(priv.body, /Only people who were added/);
  assert.equal(pub.label, "Public channel");
  assert.match(pub.body, /Anyone in Sandbox can find/);
  assert.notEqual(priv.body, pub.body);
});

test("without a workspace name it still reads naturally", () => {
  assert.match(channelVisibility(false).body, /Anyone in the workspace/);
  assert.match(channelVisibility(false, "   ").body, /Anyone in the workspace/);
});

test("the screen-reader name carries 'private channel'", () => {
  assert.equal(channelA11yName("#incident-room", true), "#incident-room, private channel");
  assert.equal(channelA11yName("#general", false), "#general");
});

// The text above only helps if the channel screen actually shows it. Guard that wiring.
test("the channel screen shows the visibility line and a lock for private channels", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "../app/c/[id].tsx"), "utf8");
  assert.match(src, /channelVisibility\(/, "the intro uses channelVisibility");
  assert.match(src, /name="lock"/, "a lock icon marks a private channel");
});
