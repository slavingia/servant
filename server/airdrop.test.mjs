import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { airdropDir, cleanName, createAirdrop, freeName } from "./airdrop.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "airdrop-"));
const b64 = s => Buffer.from(s).toString("base64");

test("cleanName keeps only a plain file name", () => {
  assert.equal(cleanName("../../etc/passwd"), "passwd");
  assert.equal(cleanName("C:\\Users\\x\\report.pdf"), "report.pdf");
  assert.equal(cleanName(".bashrc"), "bashrc");
  assert.equal(cleanName("a\x00b:c.txt"), "a_b_c.txt");
  assert.equal(cleanName(".."), null);
  assert.equal(cleanName(""), null);
});

test("freeName numbers a clash like Finder does", () => {
  const taken = new Set(["/d/a.pdf", "/d/a (1).pdf", "/d/notes"]);
  const exists = p => taken.has(p);
  assert.equal(freeName("/d", "b.pdf", exists), "b.pdf");
  assert.equal(freeName("/d", "a.pdf", exists), "a (2).pdf");
  assert.equal(freeName("/d", "notes", exists), "notes (1)");
});

test("airdropDir defaults to the Desktop and honours AIRDROP_DIR", () => {
  assert.equal(airdropDir({}), path.join(os.homedir(), "Desktop"));
  assert.equal(airdropDir({ AIRDROP_DIR: "~/Inbox" }), path.join(os.homedir(), "Inbox"));
});

test("chunks land as one file in the folder, only when complete", () => {
  const data = tmp(), desk = tmp();
  fs.writeFileSync(path.join(desk, "hello.txt"), "old");
  const air = createAirdrop({ dataDir: data, target: () => desk });
  const { id } = air.create({ userId: "u1", name: "../hello.txt", size: 11 });
  assert.deepEqual(air.append({ userId: "u1", id, offset: 0, data: b64("hello ") }), { received: 6 });
  assert.deepEqual(fs.readdirSync(desk), ["hello.txt"]);
  assert.deepEqual(air.append({ userId: "u1", id, offset: 0, data: b64("hello ") }), { received: 6 }, "retried chunk is a no-op");
  assert.throws(() => air.append({ userId: "u1", id, offset: 8, data: b64("xx") }), /Expected the chunk at 6/);
  assert.throws(() => air.append({ userId: "u2", id, offset: 6, data: b64("world") }), /gone/);
  assert.deepEqual(air.append({ userId: "u1", id, offset: 6, data: b64("world") }), { received: 11, saved: "hello (1).txt" });
  assert.equal(fs.readFileSync(path.join(desk, "hello (1).txt"), "utf8"), "hello world");
  assert.equal(fs.readFileSync(path.join(desk, "hello.txt"), "utf8"), "old");
  assert.deepEqual(air.append({ userId: "u1", id, offset: 6, data: b64("world") }), { received: 11, saved: "hello (1).txt" }, "a retried last chunk doesn't write twice");
  assert.equal(fs.readdirSync(desk).length, 2);
});

test("rejects bad sizes and oversize data", () => {
  const air = createAirdrop({ dataDir: tmp(), target: () => tmp() });
  assert.throws(() => air.create({ userId: "u", name: "a", size: 0 }), /Couldn't read/);
  assert.throws(() => air.create({ userId: "u", name: "a", size: 200 * 1024 * 1024 }), /under 100 MB/);
  assert.throws(() => air.create({ userId: "u", name: "..", size: 3 }), /Name the file/);
  const { id } = air.create({ userId: "u", name: "a", size: 2 });
  assert.throws(() => air.append({ userId: "u", id, offset: 0, data: b64("abc") }), /bigger than announced/);
});

test("handle is owner only", async () => {
  const air = createAirdrop({ dataDir: tmp(), target: () => tmp() });
  const out = [];
  const ctx = role => ({ user: { id: "u", role }, method: "POST", parts: ["v1", "airdrop"], send: (_r, s, b) => out.push([s, b]), fail: (_r, s, c) => out.push([s, c]), readBody: async () => ({ name: "a.txt", size: 1 }) });
  assert.equal(await air.handle({}, {}, ctx("member")), true);
  assert.deepEqual(out.pop(), [403, "forbidden"]);
  await air.handle({}, {}, ctx("owner"));
  assert.equal(out.pop()[0], 201);
});
