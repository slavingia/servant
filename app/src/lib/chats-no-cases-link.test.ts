import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Cases has its own place in the sidebar and on You; the Chats tab lists people only.
test("the Chats tab has no link to cases", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "../app/(tabs)/messages.tsx"), "utf8");
  assert.doesNotMatch(source, /Open cases/);
  assert.doesNotMatch(source, /"\/inbox"/);
});
