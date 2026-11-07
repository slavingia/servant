import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadRecording } from "./recordings.ts";

const bytes = (n: number) => new Uint8Array(n).fill(7);

test("a recording uploads in order and finishes with its title", async () => {
  const calls: { path: string; body: any }[] = [];
  const data = bytes(10);
  const recording = await uploadRecording({
    size: 10, durationMs: 60000, ext: "m4a", title: "Launch sync",
    read: async (offset, length) => data.slice(offset, offset + length),
    post: async (path, body: any) => {
      calls.push({ path, body });
      if (path === "/v1/recordings") return { id: "rec_1", received: 0, chunkBytes: 4 };
      if (path.endsWith("/chunk")) return { received: body.offset + Buffer.from(body.data, "base64").length };
      return { meeting: { id: "rec_1", status: "processing", title: "Launch sync" } };
    },
  });
  assert.deepEqual(calls.map(c => c.path), ["/v1/recordings", "/v1/recordings/rec_1/chunk", "/v1/recordings/rec_1/chunk", "/v1/recordings/rec_1/chunk", "/v1/recordings/rec_1/finish"]);
  assert.deepEqual(calls.filter(c => c.path.endsWith("/chunk")).map(c => c.body.offset), [0, 4, 8]);
  assert.deepEqual(calls.at(-1)!.body, { title: "Launch sync" });
  assert.equal(recording.status, "processing");
});

test("a dropped connection resumes where the server is, and an empty recording is refused", async () => {
  let failed = false;
  const progress: number[] = [];
  await uploadRecording({
    size: 8, durationMs: 1000, ext: "m4a",
    read: async (offset, length) => bytes(8).slice(offset, offset + length),
    onProgress: f => progress.push(f),
    post: async (path, body: any) => {
      if (path === "/v1/recordings") return { id: "r", received: 0, chunkBytes: 4 };
      if (path.endsWith("/chunk") && body.offset === 4 && !failed) { failed = true; throw { status: 409, code: "upload_offset", message: "Resume at 4" }; }
      if (path.endsWith("/chunk")) return { received: body.offset + 4 };
      return { meeting: { id: "r", status: "processing" } };
    },
  });
  assert.equal(failed, true);
  assert.equal(progress.at(-1), 1);
  await assert.rejects(uploadRecording({ size: 0, durationMs: 0, ext: "m4a", read: async () => bytes(0), post: async () => ({}) }), /empty/);
  await assert.rejects(uploadRecording({ size: 4, durationMs: 1, ext: "m4a", read: async () => bytes(4), post: async () => { throw { status: 413, code: "recording", message: "That recording is too long" }; } }), /too long/);
});

test("a failed upload keeps its id, and the next try carries on from the server's offset without a second copy", async () => {
  let down = true;
  const post = async (path: string, body: any) => {
    if (path === "/v1/recordings") return { id: "rec_9", received: 0, chunkBytes: 4 };
    if (path.endsWith("/chunk")) {
      if (body.offset === 4 && down) throw { status: 0, message: "Failed to fetch" };
      if (body.offset !== 4 && !down && body.offset === 0) throw { status: 409, code: "upload_offset", message: "Resume at 4" };
      return { received: body.offset + Math.min(4, 10 - body.offset) };
    }
    return { meeting: { id: "rec_9", status: "processing" } };
  };
  const args = { size: 10, durationMs: 5000, ext: "webm", read: async (o: number, l: number) => bytes(10).slice(o, o + l) };
  const error = await uploadRecording({ ...args, post }).catch(e => e);
  assert.match(error.message, /connection/);
  assert.equal(error.recordingId, "rec_9");
  down = false;
  const creates: string[] = [];
  const done = await uploadRecording({ ...args, resume: error.recordingId, post: async (path, body) => { if (path === "/v1/recordings") creates.push(path); return post(path, body); } });
  assert.equal(done.status, "processing");
  assert.deepEqual(creates, [], "no second recording was created");
});
