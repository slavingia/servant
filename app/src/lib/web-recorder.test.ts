import { test } from "node:test";
import assert from "node:assert/strict";
import { pickRecordingFormat } from "./web-recorder.ts";

test("the recording format is the first the browser can make that the server can read", () => {
  // Chrome, Edge, Firefox: webm/opus.
  assert.deepEqual(pickRecordingFormat(m => m.startsWith("audio/webm")), { mime: "audio/webm;codecs=opus", ext: "webm" });
  // Safari: no webm, records mp4.
  assert.deepEqual(pickRecordingFormat(m => m === "audio/mp4"), { mime: "audio/mp4", ext: "mp4" });
  assert.deepEqual(pickRecordingFormat(m => m.startsWith("audio/mp4")), { mime: "audio/mp4;codecs=mp4a.40.2", ext: "mp4" });
  // Nothing usable, or a browser that throws on the question.
  assert.equal(pickRecordingFormat(() => false), null);
  assert.equal(pickRecordingFormat(() => { throw new Error("no"); }), null);
  // Every answer is an extension the server accepts.
  const server = new Set(["m4a", "mp4", "aac", "wav", "webm", "caf", "mp3", "3gp"]);
  for (const ok of [() => true, (m: string) => m === "audio/webm", (m: string) => m === "audio/mp4"]) assert.ok(server.has(pickRecordingFormat(ok)!.ext));
});
