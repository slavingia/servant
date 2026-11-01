import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeMediaContent, validateUploads, hermesInput, splitText, TEXT_PART_CHARS, createMediaDeltaFilter, mediaMime, MAX_VIDEO, MAX_FILE, MAX_UPLOAD_TOTAL, MAX_UPLOAD_BODY } from "./media.mjs";
import { createChatMediaStore } from "./chat-media.mjs";
import { createMessaging } from "./messaging.mjs";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
const uri = `data:image/png;base64,${png}`;
const upload = { name: "photo.png", data: png };
const attachment = validateUploads([upload])[0];
const mp4 = Buffer.from("000000186674797069736f6d0000020069736f6d6d703432000000086d646174", "hex");
const videoUri = `data:video/mp4;base64,${mp4.toString("base64")}`;
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-media-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("Hermes media normalizes supported inline formats without trusting filenames, URLs or local paths", () => {
  const formats = [
    `Here it is.\n\n![../Rendered photo](${uri})`,
    [{ type: "text", text: "Here it is." }, { type: "image_url", image_url: { url: uri } }],
    [{ type: "text", text: "Here it is." }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }],
  ];
  for (const content of formats) {
    const result = normalizeMediaContent(content);
    assert.equal(result.text, "Here it is.");
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].mime, "image/png");
    assert.equal(result.attachments[0].data.toString("base64"), png);
    assert.ok(!result.attachments[0].name.includes("/"));
  }
  assert.equal(normalizeMediaContent(`![one](${uri}) ![two](${uri})`).attachments.length, 1);
  for (const content of ["MEDIA: /private/secrets.png", "![secret](file:///private/secrets.png)", "![remote](https://example.test/image.png)",
    [{ type: "image_url", image_url: { url: "http://169.254.169.254/secrets.png" } }],
    `![html](data:image/png;base64,${Buffer.from("<script>secret</script>").toString("base64")})`]) {
    assert.equal(normalizeMediaContent(content).attachments.length, 0);
  }
  assert.throws(() => validateUploads([{ name: "fake.png", data: Buffer.from("not an image").toString("base64") }], { imagesOnly: true }), /Agent chats accept/);
  assert.deepEqual(hermesInput("", [attachment]), [{ type: "image_url", image_url: { url: uri } }]);
});

test("streaming image markup is hidden even when split one character at a time", () => {
  const filter = createMediaDeltaFilter();
  const content = `Look here. ![Photo](${uri})\nMEDIA: /private/photo.png\nDone M`;
  const result = [...content].map(char => filter(char)).join("") + filter("", true);
  assert.equal(result, "Look here. \n\nDone M");
  assert.ok(!result.includes(png));
});

test("video containers are identified from bounded headers, never extensions or declared MIME", () => {
  assert.equal(mediaMime(mp4), "video/mp4");
  const mov = Buffer.from(mp4); mov.write("qt  ", 8);
  assert.equal(mediaMime(mov), "video/quicktime");
  const webm = Buffer.from("1a45dfa3874282847765626d1853806780", "hex");
  assert.equal(mediaMime(webm), "video/webm");
  for (const brand of ["avif", "heic", "mif1", "M4A ", "M4B "]) {
    const other = Buffer.from(mp4); other.write(brand, 8);
    assert.equal(mediaMime(other), "application/octet-stream");
  }
  for (const broken of [mp4.subarray(0, 17), Buffer.from("000000086674797069736f6d00000000", "hex"), webm.subarray(0, 9), Buffer.from("clip.mp4"), Buffer.from("<video>webm</video>")]) {
    assert.equal(mediaMime(broken), "application/octet-stream");
    assert.throws(() => validateUploads([{ name: "pretend.mp4", mime: "video/mp4", data: broken.toString("base64") }], { mediaOnly: true }), /Agent chats accept/);
  }
});

test("inline video links, content parts, and HTML normalize without leaking encoded bytes", () => {
  for (const content of [`Watch this. [Clip](${videoUri})`, `Watch this. ![Clip](${videoUri})`,
    `Watch this. <video controls src="${videoUri}"></video>`, `Watch this. <video><source src='${videoUri}' type='video/mp4'></video>`,
    [{ type: "text", text: "Watch this." }, { type: "video_url", video_url: { url: videoUri }, name: "Clip.mp4" }],
    [{ type: "text", text: "Watch this." }, { type: "video", source: { type: "base64", media_type: "video/mp4", data: mp4.toString("base64") } }]]) {
    const normalized = normalizeMediaContent(content);
    assert.equal(normalized.text, "Watch this.");
    assert.equal(normalized.attachments.length, 1);
    assert.equal(normalized.attachments[0].mime, "video/mp4");
    assert.deepEqual(normalized.attachments[0].data, mp4);
  }
  assert.equal(normalizeMediaContent("", [{ name: "movie.mp4", mime: "video/mp4", data: mp4.toString("base64") }]).attachments.length, 1);
  assert.equal(normalizeMediaContent("MEDIA: /private/clip.mp4").text, "[Video unavailable]");
  assert.deepEqual(normalizeMediaContent([{ type: "video_url", video_url: { url: "http://169.254.169.254/clip.mp4" } }]), { text: "[Video unavailable]", attachments: [] });
  assert.equal(normalizeMediaContent(`[Fake](data:video/mp4;base64,${Buffer.from("<script>fake</script>").toString("base64")})`).text, "[Video unavailable]");
});

test("video delta filtering is bounded across huge payload chunks and split delimiters", () => {
  for (const markup of [`[Clip](${videoUri})`, `![Clip](${videoUri})`, `<video src="${videoUri}"></video>`, `MEDIA: /private/clip.mp4\n`]) {
    const filter = createMediaDeltaFilter();
    const result = [...`Before ${markup} After`].map(char => filter(char)).join("") + filter("", true);
    assert.equal(result, markup.startsWith("MEDIA:") ? "Before \n After" : "Before  After");
  }
  const filter = createMediaDeltaFilter();
  assert.equal(filter("Start [Video](data:video/mp4;base64,"), "Start ");
  for (let i = 0; i < 64; i++) assert.equal(filter("A".repeat(128 * 1024)), "");
  assert.equal(filter(") End [normal](https://example.test).", true), " End [normal](https://example.test).");
});

test("video size budgets allow clips while retaining smaller image/file and total caps", () => {
  const clip = size => { const data = Buffer.alloc(size); mp4.copy(data); return { name: "clip.mp4", data: data.toString("base64") }; };
  assert.equal(validateUploads([clip(MAX_VIDEO)], { mediaOnly: true })[0].data.length, MAX_VIDEO);
  assert.throws(() => validateUploads([clip(MAX_VIDEO + 1)]), /25 MB/);
  assert.throws(() => validateUploads([{ name: "file.bin", data: Buffer.alloc(MAX_FILE + 1).toString("base64") }]), /5 MB/);
  assert.throws(() => validateUploads([clip(16 * 1024 * 1024), clip(16 * 1024 * 1024)]), /30 MB total/);
  assert.ok(Math.ceil(MAX_UPLOAD_TOTAL / 3) * 4 + 64 * 1024 < MAX_UPLOAD_BODY);
  assert.ok(Math.ceil((MAX_UPLOAD_BODY + 64 * 1024) / 3) * 4 < 56 * 1024 * 1024);
});

test("video-only accepted messages reconcile against actual Hermes text-only history without duplicate notices", t => {
  const store = createChatMediaStore(path.join(directory(t), "chat.db"));
  try {
    const firstClip = validateUploads([{ name: "trip.mp4", data: mp4.toString("base64") }], { mediaOnly: true })[0];
    const secondClip = { ...firstClip, data: Buffer.concat([mp4, Buffer.from("second clip")]) };
    const first = store.accept("video", "user", "", [firstClip]);
    const second = store.accept("video", "user", "", [secondClip]);
    const inputA = hermesInput("", [firstClip]), inputB = hermesInput("", [secondClip]);
    store.identifyInput(first.id, inputA); store.identifyInput(second.id, inputB);
    assert.match(inputA[0].text, /have not received the video bytes/);
    const history = [{ id: "first", role: "user", content: inputA.map(p => p.text).join("\n") }, { id: "second", role: "user", content: inputB.map(p => p.text).join("\n") }];
    assert.deepEqual(store.sync("video", history), [first, second]);
    assert.deepEqual(store.media("video", {}).map(a => a.messageId), [first.id, second.id]);
  } finally { store.close(); }
});

test("accepted messages reconcile with raw MEDIA history, preserve image identity across reopen, and scope files per chat", t => {
  const file = path.join(directory(t), "chat.db");
  let store = createChatMediaStore(file);
  const user = store.accept("a", "user", "", [attachment]);
  const assistant = store.accept("a", "assistant", "Here it is.", [attachment]);
  // Hermes tool-call assistant rows have no visible content and must not steal
  // a pending image-only message's identity.
  const history = [{ id: "u", role: "user", content: hermesInput("", [attachment]) },
    { id: "tool-call", role: "assistant", content: "" },
    { id: "t", role: "tool", content: "secret tool output" },
    { id: "a", role: "assistant", content: "Here it is.\n\nMEDIA: /private/generated/image.png" }];
  assert.deepEqual(store.sync("a", history), [user, assistant]);
  store.close();
  store = createChatMediaStore(file);
  try {
    assert.deepEqual(store.sync("a", history), [user, assistant]);
    assert.equal(store.media("a", { id: "human", name: "Human" }, "Hermes")[1].sender.name, "Hermes");
    assert.equal(store.media("b", { id: "human", name: "Human" }).length, 0);
    assert.equal(store.attachment(user.attachments[0].id).chat_id, "a");
    store.deleteChat("a");
    assert.equal(store.attachment(user.attachments[0].id), undefined);
  } finally { store.close(); }
});

test("repeated image captions reconcile by bytes rather than assigning the wrong human image", t => {
  const store = createChatMediaStore(path.join(directory(t), "chat.db"));
  try {
    const different = { ...attachment, data: Buffer.concat([attachment.data, Buffer.from("different")]) };
    const failed = store.accept("a", "user", "Photo", [attachment]);
    const sent = store.accept("a", "user", "Photo", [different]);
    const history = store.sync("a", [{ id: "upstream", role: "user", content: hermesInput("Photo", [different]) }]);
    assert.equal(history[0].id, sent.id);
    assert.equal(history[1].id, failed.id);
  } finally { store.close(); }
});

test("different image-only agent replies reconcile independently and deleted history media becomes inaccessible", t => {
  const store = createChatMediaStore(path.join(directory(t), "chat.db"));
  try {
    const different = { ...attachment, data: Buffer.concat([attachment.data, Buffer.from("second")]) };
    const first = store.accept("a", "assistant", "", [attachment]);
    const second = store.accept("a", "assistant", "", [different]);
    const firstSource = "MEDIA: /private/first.png", secondSource = "MEDIA: /private/second.png";
    store.identify(first.id, firstSource);
    store.identify(second.id, secondSource);
    // A truncated response that contains only the second completion must not
    // assign the first image to it because their visible captions are empty.
    assert.deepEqual(store.sync("a", [{ id: "second", role: "assistant", content: secondSource }]), [second, first]);
    const full = [{ id: "first", role: "assistant", content: firstSource }, { id: "second", role: "assistant", content: secondSource }];
    assert.deepEqual(store.sync("a", full), [first, second]);
    assert.deepEqual(store.media("a", {}).map(a => a.messageId), [first.id, second.id]);
    assert.deepEqual(store.sync("a", [full[1]]), [second]);
    assert.equal(store.attachment(first.attachments[0].id), undefined);
    assert.deepEqual(store.media("a", {}).map(a => a.messageId), [second.id]);
  } finally { store.close(); }
});

test("old unresolved MEDIA paths render an explicit unavailable state without exposing private paths", t => {
  const store = createChatMediaStore(path.join(directory(t), "chat.db"));
  try {
    const result = store.sync("old", [{ id: "historical", role: "assistant", content: "Past image\nMEDIA: /private/old.png" }]);
    assert.equal(result[0].text, "Past image\n[Image unavailable]");
    assert.deepEqual(result[0].attachments, []);
    assert.ok(!JSON.stringify(result).includes("/private"));
  } finally { store.close(); }
});

test("stale history from another API process cannot delete newly confirmed images", t => {
  const file = path.join(directory(t), "chat.db");
  const firstApi = createChatMediaStore(file), secondApi = createChatMediaStore(file);
  try {
    const staleGeneration = firstApi.beginSync("a");
    const assistant = firstApi.accept("a", "assistant", "", [attachment]);
    firstApi.identify(assistant.id, "MEDIA: /private/new.png");
    const currentGeneration = secondApi.beginSync("a");
    const upstream = [{ id: "new", role: "assistant", content: "MEDIA: /private/new.png" }];
    assert.deepEqual(secondApi.sync("a", upstream, currentGeneration), [assistant]);
    assert.deepEqual(firstApi.sync("a", [], staleGeneration), [assistant]);
    assert.equal(firstApi.attachment(assistant.attachments[0].id).size, attachment.data.length);
    assert.deepEqual(firstApi.media("a", {}).map(a => a.messageId), [assistant.id]);
    const deletionGeneration = firstApi.beginSync("a");
    assert.deepEqual(firstApi.sync("a", [], deletionGeneration), []);
    assert.equal(secondApi.attachment(assistant.attachments[0].id), undefined);
  } finally { firstApi.close(); secondApi.close(); }
});

test("channel agent workers receive human image bytes and persist returned images with their threaded reply", async t => {
  let received;
  const people = { a: { id: "a", name: "Alice" } };
  const messages = createMessaging({ file: path.join(directory(t), "messages.db"), users: () => people,
    agentName: () => "Hermes", externalWorker: true,
    askAgent: async args => { received = args; return { text: "", attachments: [attachment] }; } });
  try {
    const channel = messages.createChannel(people.a, { name: "images" });
    const root = messages.post(channel, "a", "@Hermes make a picture", null, { attachments: [attachment] });
    await messages.processAgentJob("media-test");
    assert.equal(received.attachments.length, 1);
    assert.deepEqual(Buffer.from(received.attachments[0].data), attachment.data);
    const reply = messages.db.prepare("SELECT * FROM messages WHERE user_id='agent' AND thread_root=?").get(root.seq);
    assert.equal(reply.pending, 0);
    assert.equal(reply.text, "");
    assert.equal(messages.db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE message_seq=?").get(reply.seq).n, 1);
  } finally { messages.close(); }
});


test("long agent messages split into text parts that rejoin to the original", () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ` + "x".repeat(40)).join("\n");
  const parts = splitText(lines);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(p => p.length <= TEXT_PART_CHARS));
  assert.equal(parts.join("\n"), lines);
  const input = hermesInput(lines);
  assert.ok(Array.isArray(input) && input.every(p => p.type === "text"));
  assert.equal(input.map(p => p.text).join("\n"), lines);
  assert.equal(hermesInput("short"), "short");
});

test("durable input preserves long JSON strings and image text as one unchanged value", () => {
  const text = JSON.stringify({ payload: "x".repeat(TEXT_PART_CHARS - 14) + "😀" + " with spaces".repeat(1000) });
  const plain = hermesInput(text, [], { durable: true });
  assert.equal(plain, text);
  assert.deepEqual(JSON.parse(plain), JSON.parse(text));
  const image = { mime: "image/png", data: Buffer.from("synthetic image bytes") };
  const media = hermesInput(text, [image], { durable: true });
  assert.deepEqual(media, [{ type: "text", text }, { type: "image_url", image_url: { url: `data:image/png;base64,${image.data.toString("base64")}` } }]);
});

test("legacy splitting preserves newline boundaries or rejects an unrepresentable line", () => {
  for (const text of ["a\n" + "b".repeat(59999), "a\r\n" + "b".repeat(59999), "a\n" + "b".repeat(59998) + "\n"]) {
    const parts = splitText(text);
    assert.ok(parts.every(part => part.length && part.length <= TEXT_PART_CHARS));
    assert.equal(parts.join("\n"), text);
    const media = hermesInput(text, [{ mime: "image/png", data: Buffer.from("image") }]);
    assert.equal(media.filter(part => part.type === "text").map(part => part.text).join(""), text);
    assert.ok(media.filter(part => part.type === "text").every(part => part.text.length < 65536));
  }
  for (const text of [JSON.stringify({ payload: "x".repeat(70000) }), "words with spaces ".repeat(4000), "x".repeat(TEXT_PART_CHARS) + "\n"]) {
    assert.throws(() => hermesInput(text), { code: "agent_text_too_long", status: 413 });
  }
});
