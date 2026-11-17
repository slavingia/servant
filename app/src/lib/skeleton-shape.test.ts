import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Loading skeletons stand in for people avatars, which are circles. A rounded-square
// placeholder makes the shape jump when the list loads.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const picture = (source: string, name: string) => source.match(new RegExp(`${name}:\\s*\\{\\s*width:\\s*(\\d+),\\s*height:\\s*(\\d+),\\s*borderRadius:\\s*([\\w.]+)`));

for (const [file, name] of [["../components/Skeleton.tsx", "avatar"], ["../components/HomeSkeleton.tsx", "recentPicture"]]) {
  test(`${name} in ${file.split("/").pop()} is a circle like the avatars it stands in for`, () => {
    const match = picture(read(file), name);
    assert.ok(match, `${name} style not found`);
    assert.equal(match[1], match[2]);
    assert.equal(match[3], "radius.pill");
  });
}

test("the web launch screen draws Recent's pictures as circles too", () => {
  assert.match(read("../../public/index.html"), /#launch \.row \.pic \{[^}]*border-radius: 999px;/);
});
