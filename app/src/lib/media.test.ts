import assert from "node:assert/strict";
import { test } from "node:test";
import { createMediaCache, isPreviewImage, isPreviewVideo, jpegPhotoUpload, MAX_FILE_BYTES, MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, mediaFromMessages, mediaFromPosts, mediaRoute, mergeMediaItems, readMediaPage, uploadImageUri, uploadMediaMime, validateAttachmentSelection, type MediaItem } from "./media.ts";
import type { Post } from "./server.ts";

const photo = (id: string, messageId = id, createdAt = Number(messageId)): MediaItem => ({ id, messageId, createdAt, name: `${id}.png`, mime: "image/png", size: 100, sender: { id: "hermes", name: "Hermes", agent: true } });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("older pages insert chronologically without changing the selected attachment identity", () => {
  const selectedId = "latest";
  const seed = photo(selectedId, "11", 110);
  const first = mergeMediaItems([seed], [photo("older", "1", 10)]);
  assert.equal(first.findIndex(item => item.id === selectedId), 1);
  const all = mergeMediaItems(first, [photo("middle", "5", 50), { ...seed, text: "Canonical caption", sender: { id: "user", name: "Sahil" } }]);
  assert.deepEqual(all.map(item => item.id), ["older", "middle", "latest"]);
  assert.equal(all.find(item => item.id === selectedId)?.text, "Canonical caption");
  assert.equal(all.find(item => item.id === selectedId)?.sender.name, "Sahil");
});

test("equal timestamps preserve file order within a post and numeric message order", () => {
  const items = mergeMediaItems([photo("ten-a", "10", 1), photo("ten-b", "10", 1)], [photo("two", "2", 1)]);
  assert.deepEqual(items.map(item => item.id), ["two", "ten-a", "ten-b"]);
});

test("equal-timestamp chat attachments retain server sequence rather than opaque ID order", () => {
  const first = photo("first", "msg_z", 1);
  const second = photo("second", "msg_a", 1);
  const items = mergeMediaItems([first], [second]);
  assert.deepEqual(items.map(item => item.id), ["first", "second"]);
});

test("channel seeds include human and completed agent files while omitting deleted and working replies", () => {
  const base: Post = { id: "2", conversationId: "c1", user: { id: "s", name: "Sahil" }, threadRoot: null, text: "A photograph", deleted: false, pending: false, replyCount: 0, lastReplyAt: null, createdAt: 2, editedAt: null, attachments: [photo("human")] };
  const items = mediaFromPosts([base, { ...base, id: "3", user: { id: "h", name: "Hermes", agent: true }, attachments: [photo("agent")] }, { ...base, id: "4", deleted: true, attachments: [photo("deleted")] }, { ...base, id: "5", user: { id: "h", name: "Hermes", agent: true }, pending: true, attachments: [photo("unfinished")] }]);
  assert.deepEqual(items.map(item => [item.id, item.sender.name]), [["human", "Sahil"], ["agent", "Hermes"]]);
  assert.equal(items[0].text, "A photograph");
});

test("chat seeds handle both roles and number, ISO, and unavailable timestamps", () => {
  const items = mediaFromMessages([
    { id: "1", role: "user", text: "Look", at: 10, attachments: [photo("first")] },
    { id: "2", role: "assistant", text: "Here", at: "2026-10-30T12:00:00Z", attachments: [photo("second")] },
    { id: "3", role: "assistant", text: "Again", at: "invalid", attachments: [photo("third")] },
    { id: "4", role: "assistant", text: "Unfinished", pending: true, attachments: [photo("unfinished")] },
  ], "Sahil", "Hermes");
  assert.deepEqual(items.map(item => item.id), ["first", "second", "third"]);
  assert.equal(items[0].sender.name, "Sahil");
  assert.equal(items[0].createdAt, 10);
  assert.equal(items[1].sender.name, "Hermes");
  assert.equal(items[1].sender.agent, true);
  assert.equal(items[1].createdAt, Date.parse("2026-10-30T12:00:00Z"));
  assert.equal(items[2].createdAt, 0);
});

test("chat files are credited to the message's sender, not the reader (UX-M01)", () => {
  const items = mediaFromMessages([
    { id: "1", role: "user", text: "Plan", at: 10, attachments: [photo("from-author")] },
    { id: "2", role: "user", text: "Notes", at: 20, attachments: [photo("from-colleague")], sentBy: { id: "usr_eli", name: "Eli Colleague" } },
  ], "Pia Author", "Agent");
  assert.deepEqual(items.map(item => item.sender.name), ["Pia Author", "Eli Colleague"]);
  assert.equal(items[1].sender.id, "usr_eli");
});

test("gallery routes encode conversation IDs and opaque cursors", () => {
  assert.equal(mediaRoute({ kind: "conversation", id: "one/two" }, "a+=b"), "/v1/conversations/one%2Ftwo/media?limit=100&after=a%2B%3Db");
  assert.equal(mediaRoute({ kind: "chat", id: "chat" }), "/v1/chats/chat/media?limit=100");
});

test("malformed metadata is rejected before it reaches gallery rendering", () => {
  const valid = { items: [photo("1")], nextCursor: null };
  assert.deepEqual(readMediaPage(valid), valid);
  for (const invalid of [null, {}, { ...valid, nextCursor: "" }, { ...valid, nextCursor: 2 }, { ...valid, items: [{ ...photo("1"), size: -1 }] }, { ...valid, items: [{ ...photo("1"), createdAt: Infinity }] }, { ...valid, items: [{ ...photo("1"), text: {} }] }, { ...valid, items: [{ ...photo("1"), sender: {} }] }]) {
    assert.throws(() => readMediaPage(invalid));
  }
});

test("pending previews recognize raster signatures without trusting names or URLs", () => {
  const cases: [string, string][] = [
    ["\x89PNG\r\n\x1a\nrest", "image/png"], ["\xff\xd8\xffrest", "image/jpeg"], ["GIF89arest", "image/gif"],
    ["RIFF\x10\x00\x00\x00WEBPVP8 rest", "image/webp"], ["\x00\x00\x00\x18ftypheicrest", "image/heic"], ["\x00\x00\x00\x18ftypavifrest", "image/avif"],
  ];
  for (const [bytes, mime] of cases) {
    const data = Buffer.from(bytes, "binary").toString("base64");
    assert.equal(uploadImageUri({ name: "misleading.pdf", data }), `data:${mime};base64,${data}`);
  }
  assert.equal(uploadImageUri({ name: "image.png", data: Buffer.from("<svg></svg>").toString("base64") }), undefined);
  assert.equal(uploadImageUri({ name: "image.png", data: "https://example.com/private.png" }), undefined);
  assert.equal(isPreviewImage({ mime: "image/svg+xml" }), false);
  assert.equal(isPreviewImage({ mime: "image/jpeg" }), true);
});

test("HEIC picker exports become JPEG uploads with matching name, preview and checked byte size", () => {
  const data = Buffer.from("\xff\xd8\xfftest", "binary").toString("base64");
  const upload = jpegPhotoUpload("IMG_1024.HEIC", data);
  assert.equal(upload.name, "IMG_1024.jpg");
  assert.equal(upload.mime, "image/jpeg");
  assert.equal(upload.size, 7);
  assert.equal(upload.uri, `data:image/jpeg;base64,${data}`);
  assert.throws(() => jpegPhotoUpload("large.heic", data, 6), /under 5 MB/);
  assert.throws(() => jpegPhotoUpload("bad.heic", "aGVsbG8="), /prepare this photo/);
  assert.throws(() => jpegPhotoUpload("bad.heic", "/9j/invalid!"), /prepare this photo/);
});

test("video previews recognize container signatures without mistaking audio or still images for video", () => {
  const bmff = (major: string, compatible = "") => {
    const bytes = Buffer.alloc(16 + compatible.length);
    bytes.writeUInt32BE(bytes.length, 0); bytes.write("ftyp", 4); bytes.write(major, 8); bytes.write(compatible, 16);
    return bytes.toString("base64");
  };
  assert.equal(uploadMediaMime(bmff("isom", "mp42")), "video/mp4");
  assert.equal(uploadMediaMime(bmff("qt  ")), "video/quicktime");
  assert.equal(uploadMediaMime(bmff("MSNV", "isom")), "video/mp4");
  assert.equal(uploadMediaMime(bmff("M4A ", "isom")), undefined);
  assert.equal(uploadMediaMime(bmff("M4P ", "isom")), undefined);
  assert.equal(uploadMediaMime(bmff("heic", "isom")), "image/heic");
  assert.equal(uploadMediaMime(bmff("avif", "isom")), "image/avif");
  assert.equal(uploadImageUri({ name: "fake.jpg", data: bmff("isom") }), undefined);
  assert.equal(uploadMediaMime(Buffer.from("\x1a\x45\xdf\xa3\x87\x42\x82\x84webm", "binary").toString("base64")), "video/webm");
  assert.equal(uploadMediaMime(Buffer.from("\x1a\x45\xdf\xa3\x8b\x42\x82\x88matroska", "binary").toString("base64")), undefined);
  assert.equal(uploadMediaMime(Buffer.from("\x1a\x45\xdf\xa3webm", "binary").toString("base64")), undefined);
  assert.equal(uploadMediaMime(Buffer.from("\x00\x00\x01\x00ftypisom", "binary").toString("base64")), undefined);
  assert.equal(isPreviewVideo({ mime: "video/mp4" }), true);
  assert.equal(isPreviewVideo({ mime: "application/octet-stream" }), false);
});

test("mixed image/video selection enforces per-file and shared upload limits", () => {
  const photo = { mime: "image/jpeg", size: MAX_FILE_BYTES };
  const video = { mime: "video/mp4", size: MAX_VIDEO_BYTES };
  assert.doesNotThrow(() => validateAttachmentSelection([photo, video]));
  assert.equal(photo.size + video.size, MAX_UPLOAD_BYTES);
  assert.throws(() => validateAttachmentSelection([{ ...video, size: video.size + 1 }]), /25 MB/);
  assert.throws(() => validateAttachmentSelection([{ ...photo, size: photo.size + 1 }]), /photos under 5 MB/);
  assert.doesNotThrow(() => validateAttachmentSelection([{ mime: "application/octet-stream", size: MAX_VIDEO_BYTES }]));
  assert.throws(() => validateAttachmentSelection([video, { ...video, size: MAX_FILE_BYTES + 1 }]), /30 MB/);
  assert.throws(() => validateAttachmentSelection(Array.from({ length: 5 }, () => ({ ...photo, size: 1 }))), /4 files/);
  assert.throws(() => validateAttachmentSelection([{ mime: "video/mp4", size: Infinity }]), /read this file/);
});

test("private content cache deduplicates concurrent requests and reuses loaded bytes", async () => {
  const response = deferred<string>();
  let requests = 0;
  const cache = createMediaCache(async () => { requests++; return response.promise; });
  const first = cache.load(photo("1"));
  const second = cache.load(photo("1"));
  assert.equal(first, second);
  response.resolve("picture");
  assert.equal(await first, "picture");
  assert.equal(await cache.load(photo("1")), "picture");
  assert.equal(requests, 1);
  cache.dispose();
});

test("failed private content requests can be retried", async () => {
  let requests = 0;
  const cache = createMediaCache(async () => { if (++requests === 1) throw new Error("offline"); return "recovered"; });
  await assert.rejects(cache.load(photo("1")), /offline/);
  assert.equal(await cache.load(photo("1")), "recovered");
  assert.equal(requests, 2);
  cache.dispose();
});

test("cache evicts least recently used entries and respects byte budget", async () => {
  const cache = createMediaCache(async file => file.id.repeat(4), 8, 2);
  await cache.load(photo("a")); await cache.load(photo("b")); await cache.load(photo("a")); await cache.load(photo("c"));
  assert.equal(cache.peek("a"), "aaaa");
  assert.equal(cache.peek("b"), undefined);
  assert.equal(cache.peek("c"), "cccc");
  await cache.load(photo("huge"));
  assert.equal(cache.peek("huge"), undefined);
  assert.equal(cache.peek("a"), "aaaa");
  cache.dispose();
});

test("invalidating a pending file prevents late data from replacing a retry", async () => {
  const old = deferred<string>();
  let signal: AbortSignal | undefined;
  let requests = 0;
  const cache = createMediaCache(async (_, incomingSignal) => { signal = incomingSignal; return ++requests === 1 ? old.promise : "fresh"; });
  const pending = cache.load(photo("1"));
  const cancelled = assert.rejects(pending, /cancelled/);
  cache.invalidate("1");
  assert.equal(signal?.aborted, true);
  assert.equal(await cache.load(photo("1")), "fresh");
  old.resolve("stale");
  await cancelled;
  assert.equal(cache.peek("1"), "fresh");
  cache.dispose();
});

test("account teardown aborts and releases content, and supports StrictMode effect replay", async () => {
  const old = deferred<string>();
  let signal: AbortSignal | undefined;
  let requests = 0;
  const cache = createMediaCache(async (_, incomingSignal) => { signal = incomingSignal; return ++requests === 1 ? old.promise : "new session"; });
  const pending = cache.load(photo("1"));
  const cancelled = assert.rejects(pending, /cancelled/);
  cache.dispose();
  assert.equal(signal?.aborted, true);
  old.resolve("old private bytes");
  await cancelled;
  assert.equal(cache.peek("1"), undefined);
  assert.equal(await cache.load(photo("1")), "new session");
  cache.dispose();
  assert.equal(cache.peek("1"), undefined);
});
