import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReadmeCache } from "./project-readme.mjs";

test("README: live first, then cached, refreshed when old, null when never reachable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readme-"));
  let t = 1000, calls = 0, text = "# One";
  const readme = createReadmeCache(dir, { now: () => t, fetcher: async () => { calls++; if (text === null) throw new Error("down"); return { name: "README.md", text, sha: "x" }; } });
  assert.equal((await readme("a/b")).text, "# One");
  assert.equal(calls, 1);
  t += 1000; text = "# Two";
  assert.deepEqual([(await readme("a/b")).text, calls], ["# One", 1], "fresh cache, no fetch");
  t += 10 * 60 * 1000;
  const old = await readme("a/b");
  assert.deepEqual([old.text, old.stale], ["# One", true], "old copy served at once");
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await readme("a/b")).text, "# Two", "refreshed behind it");
  const down = createReadmeCache(fs.mkdtempSync(path.join(os.tmpdir(), "readme-")), { fetcher: async () => { throw new Error("no"); } });
  assert.equal(await down("a/c"), null);
});
