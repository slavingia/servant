import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDocumentStore, documentMime, documentNotice, DOCUMENT_CHUNK, MAX_DOCUMENT } from "./documents.mjs";
import { hermesInput } from "./media.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "servant-docs-"));
const b64 = buffer => buffer.toString("base64");

test("a design file bigger than one request uploads in chunks and resolves to an on-disk attachment", () => {
  const dir = tmp();
  const store = createDocumentStore(dir);
  const bytes = Buffer.alloc(DOCUMENT_CHUNK * 2 + 1234, 7);
  const { id, chunkBytes } = store.create({ chatId: "cht_1", userId: "u1", name: "Tax home.fig", size: bytes.length });
  assert.equal(chunkBytes, DOCUMENT_CHUNK);
  let offset = 0;
  while (offset < bytes.length) offset = store.append({ chatId: "cht_1", userId: "u1", id, offset, data: b64(bytes.subarray(offset, offset + DOCUMENT_CHUNK)) }).received;
  const [doc] = store.resolve({ chatId: "cht_1", userId: "u1", parts: [{ name: "Tax home.fig", upload: id }] });
  assert.equal(doc.name, "Tax home.fig");
  assert.equal(doc.mime, "application/x-figma");
  assert.equal(doc.size, bytes.length);
  assert.ok(store.owns(doc.file));
  assert.deepEqual(fs.readFileSync(doc.file), bytes);
  assert.deepEqual(store.read(doc.file, DOCUMENT_CHUNK * 2, DOCUMENT_CHUNK), bytes.subarray(DOCUMENT_CHUNK * 2));
  store.deleteChat("cht_1");
  assert.equal(fs.existsSync(doc.file), false);
});

test("retried chunks are no-ops, gaps are refused with the expected offset", () => {
  const store = createDocumentStore(tmp());
  const { id } = store.create({ chatId: "c", userId: "u", name: "a.pdf", size: 10 });
  assert.equal(store.append({ chatId: "c", userId: "u", id, offset: 0, data: b64(Buffer.alloc(4)) }).received, 4);
  assert.equal(store.append({ chatId: "c", userId: "u", id, offset: 0, data: b64(Buffer.alloc(4)) }).received, 4);
  assert.throws(() => store.append({ chatId: "c", userId: "u", id, offset: 8, data: b64(Buffer.alloc(2)) }), e => e.status === 409 && e.code === "upload_offset" && /4/.test(e.message));
  assert.throws(() => store.append({ chatId: "c", userId: "u", id, offset: 4, data: b64(Buffer.alloc(9)) }), e => e.status === 413);
  assert.throws(() => store.resolve({ chatId: "c", userId: "u", parts: [{ upload: id }] }), e => e.code === "upload_incomplete");
});

test("uploads belong to their sender and chat, and the size cap is enforced up front", () => {
  const store = createDocumentStore(tmp());
  assert.throws(() => store.create({ chatId: "c", userId: "u", name: "big.zip", size: MAX_DOCUMENT + 1 }), e => e.status === 413 && /100 MB/.test(e.message));
  const { id } = store.create({ chatId: "c", userId: "u", name: "a.pdf", size: 1 });
  assert.throws(() => store.append({ chatId: "c", userId: "other", id, offset: 0, data: b64(Buffer.alloc(1)) }), e => e.status === 404);
  assert.throws(() => store.append({ chatId: "other", userId: "u", id, offset: 0, data: b64(Buffer.alloc(1)) }), e => e.status === 404);
  assert.throws(() => store.resolve({ chatId: "c", userId: "u", parts: [{ upload: "../../etc" }] }), e => e.status === 404);
});

test("documents are never typed as images or videos, even when named like one", () => {
  assert.equal(documentMime("mock.psd"), "application/x-photoshop");
  assert.equal(documentMime("photo.png"), "application/octet-stream");
  assert.equal(documentMime("noext"), "application/octet-stream");
});

test("the agent gets a note, not image parts; only the full agent sees the path", () => {
  const doc = { name: "Hero.sketch", mime: "application/x-sketch", data: Buffer.alloc(0), size: 30_000_000, file: "/data/chat-files/c/upl_x/Hero.sketch" };
  const full = hermesInput("Use this", [doc], { full: true });
  assert.ok(full.every(part => part.type === "text"));
  assert.match(full.at(-1).text, /saved at \/data\/chat-files/);
  const member = hermesInput("Use this", [doc]);
  assert.ok(member.every(part => part.type === "text"));
  assert.doesNotMatch(JSON.stringify(member), /chat-files/);
  assert.match(documentNotice([doc]), /Hero\.sketch.*30,000,000 bytes/);
});

test("a document named meta.json keeps its own bytes instead of being overwritten by the upload's metadata", () => {
  const store = createDocumentStore(tmp());
  for (const name of ["meta.json", "Meta.JSON"]) {
    const bytes = Buffer.from('{"mine":"a real json document"}');
    const { id } = store.create({ chatId: "c", userId: "u", name, size: bytes.length });
    store.append({ chatId: "c", userId: "u", id, offset: 0, data: b64(bytes) });
    const [doc] = store.resolve({ chatId: "c", userId: "u", parts: [{ name, upload: id }] });
    assert.equal(doc.name, name, "the name people see is unchanged");
    assert.deepEqual(fs.readFileSync(doc.file), bytes, `${name}: bytes survive`);
  }
});
