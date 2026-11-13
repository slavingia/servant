import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadDocument, uploadDocument } from "./document-upload.ts";
import { DOCUMENT_CHUNK_BYTES, validateAttachmentSelection } from "./media.ts";

function fakeServer(size: number, { dropOnce = false } = {}) {
  let received = 0, dropped = false;
  const store: Uint8Array[] = [];
  const post = async (path: string, body: any) => {
    if (path.endsWith("/uploads")) return { id: "upl_test", chunkBytes: DOCUMENT_CHUNK_BYTES, received: 0 };
    const bytes = Uint8Array.from(Buffer.from(body.data, "base64"));
    if (body.offset + bytes.length <= received) return { received };
    if (body.offset !== received) throw { status: 409, code: "upload_offset", message: `Expected the chunk at ${received}` };
    store.push(bytes); received += bytes.length;
    // The chunk lands but the response is lost.
    if (dropOnce && !dropped) { dropped = true; throw { status: 0, message: "network" }; }
    return { received };
  };
  return { post, bytes: () => Buffer.concat(store), size };
}

test("uploads a 7 MB file in chunks and survives a lost response", async () => {
  const file = Buffer.alloc(7 * 1024 * 1024 + 5, 3);
  const server = fakeServer(file.length, { dropOnce: true });
  const progress: number[] = [];
  const id = await uploadDocument({ chatId: "c", name: "a.fig", size: file.length, read: async (o, l) => Uint8Array.from(file.subarray(o, o + l)), post: server.post, onProgress: p => progress.push(p) });
  assert.equal(id, "upl_test");
  assert.deepEqual(server.bytes(), file);
  assert.equal(progress.at(-1), 1);
});

test("refuses documents over 100 MB before uploading", async () => {
  await assert.rejects(uploadDocument({ chatId: "c", name: "a.zip", size: 101 * 1024 * 1024, read: async () => new Uint8Array(), post: async () => ({}) }), /under 100 MB/);
});

test("server errors surface their message", async () => {
  await assert.rejects(uploadDocument({ chatId: "c", name: "a.zip", size: 10, read: async () => new Uint8Array(10), post: async () => { throw { status: 403, message: "Posting is closed" }; } }), /Posting is closed/);
});

test("joins ranged downloads", async () => {
  const file = Buffer.alloc(10, 9);
  const data = await downloadDocument({ data: file.subarray(0, 6).toString("base64"), size: 10 }, async offset => ({ data: file.subarray(offset).toString("base64"), offset, size: 10 }));
  assert.equal(data, file.toString("base64"));
});

test("documents skip the 25 MB and 30 MB caps but not the 100 MB one", () => {
  const doc = (size: number) => ({ mime: "application/octet-stream", size, document: {} });
  validateAttachmentSelection([doc(90 * 1024 * 1024), doc(90 * 1024 * 1024)]);
  assert.throws(() => validateAttachmentSelection([doc(101 * 1024 * 1024)]), /under 100 MB/);
  assert.throws(() => validateAttachmentSelection([{ mime: "application/pdf", size: 26 * 1024 * 1024 }]), /under 25 MB/);
});
