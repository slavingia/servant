import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The loading skeleton stands in for people avatars, which are circles. A
// rounded-square placeholder makes the shape jump when the list loads.
test("skeleton avatar is a circle like the avatars it stands in for", () => {
  const source = readFileSync(new URL("../components/Skeleton.tsx", import.meta.url), "utf8");
  const match = source.match(/avatar:\s*\{\s*width:\s*(\d+),\s*height:\s*(\d+),\s*borderRadius:\s*([\w.]+)\s*\}/);
  assert.ok(match, "skeleton avatar style not found");
  assert.equal(match[1], match[2]);
  assert.equal(match[3], "radius.pill");
});
