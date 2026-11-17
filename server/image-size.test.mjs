// A picture's width and height, read from its header (image-size.mjs): each format, a photo stored on its
// side, files cut short, and files that are not pictures at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claimedSize, imageSize, pictureSize, withPictureSize } from "./image-size.mjs";
import { createMessaging } from "./messaging.mjs";
import { createChatMediaStore } from "./chat-media.mjs";
import { validateUploads } from "./media.mjs";

const bytes = base64 => Buffer.from(base64, "base64");
const be16 = n => Buffer.from([n >> 8, n & 255]);
const be32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const le16 = n => Buffer.from([n & 255, n >> 8]);
const le24 = n => Buffer.from([n & 255, (n >> 8) & 255, n >> 16]);
const ascii = text => Buffer.from(text, "latin1");

// Real files, three pixels wide and two tall, as an image library wrote them.
const REAL = {
  png: bytes("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGPkqjjBAAZMEIqBgQEAFrIBTmrNSIkAAAAASUVORK5CYII="),
  gif: bytes("R0lGODdhAwACAIEAAAp4yAAAAAAAAAAAACwAAAAAAwACAAAIBgABCBwYEAA7"),
  jpeg: bytes("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDACgcHiMeGSgjISMtKygwPGRBPDc3PHtYXUlkkYCZlo+AjIqgtObDoKrarYqMyP/L2u71////m8H////6/+b9//j/2wBDASstLTw1PHZBQXb4pYyl+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj/wAARCAACAAMDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIgFhv/Z"),
  "WebP (lossy)": bytes("UklGRjgAAABXRUJQVlA4ICwAAADQAQCdASoDAAIAAsBMJaACdLoB+AADsAD+6Ncf+IZ6PU1I//ILlhdcRgAAAA=="),
  "WebP (lossless)": bytes("UklGRh4AAABXRUJQVlA4TBEAAAAvAkAAAAdQvCoUuf+BiOh/AAA="),
  "WebP (extended)": bytes("UklGRloAAABXRUJQVlA4WAoAAAAQAAAAAgAAAQAAQUxQSAcAAAAAAP//////AFZQOCAsAAAA0AEAnQEqAwACAALATCWgAnS6AfgAA7AA/ujXH/iGej1NSP/yC5YXXEYAAAA="),
};
// A real HEIC, 37 by 23, up to the end of its header (the picture's own bytes are not needed). Its encoder
// stores 38 by 24 and says which part is shown.
const REAL_HEIC = bytes("AAAAGGZ0eXBoZWljAAAAAGhlaWNtaWYxAAABr21ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAQ9pcHJwAAAA7WlwY28AAAATY29scm5jbHgAAgACAAaAAAAADGNsbGkAywBAAAAAFGlzcGUAAAAAAAAAJgAAABgAAAAoY2xhcAAAACUAAAABAAAAFwAAAAH/wAAAAIAAAP/AAAAAgAAAAAAACWlyb3QAAAAAEHBpeGkAAAAAAwgICAAAAHFodmNDAQNwAAAAsAAAAAAAHvAA/P34+AAACwOgAAEAF0ABDAH//wNwAAADALAAAAMAAAMAHnAkoQABACNCAQEDcAAAAwCwAAADAAADAB6gFCBBwfQriHuRZVNwICBgCKIAAQAJRAHAYXLIRFNkAAAAGmlwbWEAAAAAAAAAAQABB4ECAwaHhIUAAAAeaWxvYwAAAABEAAABAAEAAAABAAAB1wAAAZIAAAAB");

// Headers written out by hand, so a test can ask for any size and any oddity.
const png = (width, height) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), be32(13), ascii("IHDR"), be32(width), be32(height), Buffer.from([8, 2, 0, 0, 0])]);
const gif = (width, height) => Buffer.concat([ascii("GIF89a"), le16(width), le16(height), Buffer.from([0, 0, 0])]);
function jpeg({ width, height, orientation, order = "MM", frame = 0xc0, padding = 0, exifFirst = true }) {
  const segment = (marker, body) => Buffer.concat([Buffer.alloc(padding, 0xff), Buffer.from([0xff, marker]), be16(body.length + 2), body]);
  const little = order === "II";
  const u16 = n => little ? le16(n) : be16(n);
  const u32 = n => { const b = Buffer.alloc(4); if (little) b.writeUInt32LE(n); else b.writeUInt32BE(n); return b; };
  // One entry: tag 0x0112 (orientation), a SHORT, count 1, the value in the first two bytes of its field.
  const exif = orientation ? segment(0xe1, Buffer.concat([ascii("Exif\0\0"), ascii(order), u16(42), u32(8), u16(1), u16(0x0112), u16(3), u32(1), u16(orientation), u16(0), u32(0)])) : Buffer.alloc(0);
  const jfif = segment(0xe0, ascii("JFIF\0\x01\x01\0\0\x01\0\x01\0\0"));
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), ...(exifFirst ? [exif, jfif] : [jfif, exif]),
    segment(0xdb, Buffer.alloc(65)),
    segment(frame, Buffer.concat([Buffer.from([8]), be16(height), be16(width), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])])),
    Buffer.from([0xff, 0xda]),
  ]);
}
const riff = (kind, body) => Buffer.concat([ascii("RIFF"), Buffer.from([0, 0, 0, 0]), ascii("WEBP"), ascii(kind), Buffer.from([0, 0, 0, 0]), body]);
const webp = {
  lossy: (width, height) => riff("VP8 ", Buffer.concat([Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a]), le16(width), le16(height), Buffer.alloc(4)])),
  lossless: (width, height) => { const b = Buffer.alloc(4); b.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0); return riff("VP8L", Buffer.concat([Buffer.from([0x2f]), b, Buffer.alloc(4)])); },
  extended: (width, height) => riff("VP8X", Buffer.concat([Buffer.alloc(4), le24(width - 1), le24(height - 1)])),
};
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([be32(8 + body.length), ascii(type), body]); };
const full = (type, ...parts) => box(type, Buffer.alloc(4), ...parts);
const ispe = (width, height) => full("ispe", be32(width), be32(height));
/** `properties` are the boxes in the list; `mine` are the places (from 1) of those that belong to the picture, or null to leave that out. */
function heic({ brand = "heic", properties, mine }) {
  const links = mine ? [full("pitm", be16(1)), box("iprp", box("ipco", ...properties), full("ipma", be32(1), be16(1), Buffer.from([mine.length, ...mine])))] : [box("iprp", box("ipco", ...properties))];
  return Buffer.concat([box("ftyp", ascii(brand), be32(0), ascii("mif1")), full("meta", full("hdlr", be32(0), ascii("pict"), Buffer.alloc(13)), ...links), box("mdat", Buffer.alloc(32))]);
}

test("a PNG, a JPEG, a GIF and each kind of WebP say how big they are", () => {
  for (const [format, data] of Object.entries(REAL)) assert.deepEqual(imageSize(data), { width: 3, height: 2 }, format);
  assert.deepEqual(imageSize(png(1600, 500)), { width: 1600, height: 500 });
  assert.deepEqual(imageSize(gif(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(imageSize(jpeg({ width: 4032, height: 3024 })), { width: 4032, height: 3024 });
  assert.deepEqual(imageSize(webp.lossy(600, 1300)), { width: 600, height: 1300 });
  assert.deepEqual(imageSize(webp.lossless(600, 1300)), { width: 600, height: 1300 });
  assert.deepEqual(imageSize(webp.extended(16384, 9000)), { width: 16384, height: 9000 });
  // What SQLite hands back for a stored file is a plain byte array, not a Buffer.
  assert.deepEqual(imageSize(new Uint8Array(png(800, 600))), { width: 800, height: 600 });
});

test("a JPEG says its size wherever the frame header is: progressive, padded, after other blocks", () => {
  // Every kind of frame header (baseline, progressive, lossless, arithmetic), not the three markers among them that are not one.
  for (const frame of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) {
    assert.deepEqual(imageSize(jpeg({ width: 300, height: 200, frame })), { width: 300, height: 200 }, `frame ${frame.toString(16)}`);
  }
  assert.deepEqual(imageSize(jpeg({ width: 300, height: 200, padding: 3 })), { width: 300, height: 200 }, "fill bytes before each marker");
  // A large block (a thumbnail, a color profile) ahead of the frame header is stepped over, not searched.
  const data = jpeg({ width: 300, height: 200 });
  const profile = Buffer.concat([Buffer.from([0xff, 0xe2]), be16(60002), Buffer.alloc(60000, 0xc0)]);
  assert.deepEqual(imageSize(Buffer.concat([data.subarray(0, 2), profile, profile, data.subarray(2)])), { width: 300, height: 200 });
});

test("a photo stored on its side comes back the way it is shown", () => {
  for (const order of ["MM", "II"]) {
    for (let orientation = 1; orientation <= 8; orientation++) {
      const turned = orientation >= 5;
      assert.deepEqual(imageSize(jpeg({ width: 4032, height: 3024, orientation, order })), turned ? { width: 3024, height: 4032 } : { width: 4032, height: 3024 }, `orientation ${orientation}, ${order}`);
    }
  }
  assert.deepEqual(imageSize(jpeg({ width: 4032, height: 3024, orientation: 6, exifFirst: false })), { width: 3024, height: 4032 }, "the note may come after the JFIF block");
  // A HEIC says it with a rotation in quarter turns.
  for (const [turns, shown] of [[0, { width: 4032, height: 3024 }], [1, { width: 3024, height: 4032 }], [2, { width: 4032, height: 3024 }], [3, { width: 3024, height: 4032 }]]) {
    assert.deepEqual(imageSize(heic({ properties: [ispe(4032, 3024), box("irot", Buffer.from([turns]))], mine: [1, 2] })), shown, `${turns} quarter turns`);
  }
});

test("a HEIC says the size of the picture, not of its tiles or its thumbnail", () => {
  assert.deepEqual(imageSize(REAL_HEIC), { width: 37, height: 23 }, "a real file: the part that is shown, not the 38 by 24 that is stored");
  // A phone's photo: a grid of 512-point tiles, a thumbnail, and the picture made of the tiles.
  const properties = [ispe(512, 512), ispe(320, 240), ispe(4032, 3024)];
  assert.deepEqual(imageSize(heic({ properties, mine: [3] })), { width: 4032, height: 3024 });
  assert.deepEqual(imageSize(heic({ properties, mine: [2] })), { width: 320, height: 240 }, "the size the file says is the picture's is the one used");
  assert.deepEqual(imageSize(heic({ properties, mine: null })), { width: 4032, height: 3024 }, "a file that does not say: the largest");
  for (const brand of ["heic", "heix", "mif1", "avif"]) assert.deepEqual(imageSize(heic({ brand, properties: [ispe(800, 600)], mine: [1] })), { width: 800, height: 600 }, brand);
  // A video is boxes too, and is not a picture.
  assert.equal(imageSize(Buffer.from("000000186674797069736f6d0000020069736f6d6d703432000000086d646174", "hex")), null);
  assert.equal(imageSize(heic({ brand: "isom", properties: [ispe(800, 600)], mine: [1] }).fill(ascii("isom"), 16, 20)), null, "not a HEIC by its own brands");
});

test("a file cut short says its size when the header is whole, and nothing otherwise: never a wrong size, never an error", () => {
  const samples = [
    ...Object.values(REAL), REAL_HEIC, png(1600, 500), gif(640, 480), jpeg({ width: 4032, height: 3024, orientation: 6 }),
    webp.lossy(600, 1300), webp.lossless(600, 1300), webp.extended(2000, 1000), heic({ properties: [ispe(512, 512), ispe(4032, 3024), box("irot", Buffer.from([1]))], mine: [2, 3] }),
  ];
  for (const data of samples) {
    const whole = imageSize(data);
    assert.ok(whole, "the whole file has a size");
    for (let length = 0; length < data.length; length++) {
      const got = imageSize(data.subarray(0, length));
      if (got !== null) assert.deepEqual(got, whole, `${length} of ${data.length} bytes`);
    }
    assert.equal(imageSize(data.subarray(0, 9)), null, "nine bytes are never enough");
  }
});

test("a file that is not a picture, or whose header is damaged, has no size", () => {
  for (const value of [Buffer.alloc(0), ascii("plain text"), ascii("%PDF-1.7\n"), ascii("PK\x03\x04"), ascii("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/>"), Buffer.alloc(64), null, undefined, "text", 5, {}]) {
    assert.equal(imageSize(value), null);
  }
  // The right first bytes, then nothing that makes sense.
  assert.equal(imageSize(png(0, 600)), null, "no width");
  assert.equal(imageSize(png(800, 0)), null, "no height");
  assert.equal(imageSize(png(2 ** 31, 600)), null, "a size no picture has");
  assert.equal(imageSize(gif(0, 0)), null);
  assert.equal(imageSize(Buffer.concat([png(800, 600).subarray(0, 12), ascii("IDAT"), be32(800), be32(600)])), null, "a PNG whose first block is not its header");
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 8, 1, 2, 3, 4, 5, 6])), null, "a JPEG whose picture starts before any frame header");
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 0, 0, 0, 0])), null, "a block with an impossible length");
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])), null, "bytes that are not a block");
  assert.equal(imageSize(riff("VP8 ", Buffer.alloc(20))), null, "a WebP without its start code");
  assert.equal(imageSize(riff("VP8L", Buffer.alloc(20))), null, "a WebP without its signature byte");
  assert.equal(imageSize(riff("ALPH", Buffer.alloc(20))), null);
  assert.equal(imageSize(heic({ properties: [box("irot", Buffer.from([1]))], mine: [1] })), null, "a HEIC with no size in it");
  assert.equal(imageSize(Buffer.concat([be32(0xffffff00), ascii("ftypheic"), Buffer.alloc(32)])), null, "a first box longer than the file");
  // Random bytes behind each format's first bytes: whatever comes back is null or a size that makes sense.
  const starts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from([0xff, 0xd8, 0xff]), ascii("GIF89a"), ascii("RIFF\0\0\0\0WEBPVP8 "), ascii("RIFF\0\0\0\0WEBPVP8L"), ascii("RIFF\0\0\0\0WEBPVP8X"), ascii("\0\0\0\x18ftypheic\0\0\0\0mif1heic")];
  for (let i = 0; i < 3500; i++) {
    const got = imageSize(Buffer.concat([starts[i % starts.length], crypto.randomBytes(i % 257)]));
    if (got) assert.ok(Number.isInteger(got.width) && Number.isInteger(got.height) && got.width > 0 && got.height > 0 && got.width <= 100000 && got.height <= 100000, JSON.stringify(got));
  }
});

test("what is kept with a file: its own header first, then a size the sender's app gave for a picture or a video", () => {
  assert.deepEqual(pictureSize({ mime: "image/png", data: png(800, 600) }), { width: 800, height: 600 });
  assert.deepEqual(pictureSize({ mime: "image/png", data: png(800, 600), width: 10, height: 10 }), { width: 800, height: 600 }, "the header is believed over the app");
  const video = Buffer.from("000000186674797069736f6d0000020069736f6d6d703432000000086d646174", "hex");
  assert.deepEqual(pictureSize({ mime: "video/mp4", data: video, width: 1920, height: 1080 }), { width: 1920, height: 1080 });
  assert.equal(pictureSize({ mime: "video/mp4", data: video }), null);
  assert.equal(pictureSize({ mime: "application/octet-stream", data: ascii("%PDF-1.7"), width: 800, height: 600 }), null, "a document has no shape to keep");
  for (const claim of [{ width: 0, height: 600 }, { width: 800 }, { width: "800", height: "600" }, { width: 800.5, height: 600 }, { width: -800, height: 600 }, { width: 1e9, height: 600 }, { width: NaN, height: 600 }, null, "800x600"]) {
    assert.equal(claimedSize(claim), null, JSON.stringify(claim));
  }
  assert.deepEqual(claimedSize({ width: 800, height: 600, name: "photo.jpg" }), { width: 800, height: 600 });
});

test("a stored file's row carries width and height only when they are known", () => {
  assert.deepEqual(withPictureSize({ id: "file_1", name: "a.png", mime: "image/png", size: 10, width: 800, height: 600 }), { id: "file_1", name: "a.png", mime: "image/png", size: 10, width: 800, height: 600 });
  // A file stored before sizes were kept, and a file that is not a picture: the same four fields as before.
  assert.deepEqual(withPictureSize({ id: "file_1", name: "a.png", mime: "image/png", size: 10, width: null, height: null }), { id: "file_1", name: "a.png", mime: "image/png", size: 10 });
  assert.deepEqual(withPictureSize({ id: "file_1", name: "a.pdf", mime: "application/octet-stream", size: 10 }), { id: "file_1", name: "a.pdf", mime: "application/octet-stream", size: 10 });
});

// ----- what the app receives -----

const people = { pat: { id: "pat", name: "Pat Tester", role: "owner" }, jo: { id: "jo", name: "Jo Park", role: "member" } };
const VIDEO = Buffer.from("000000186674797069736f6d0000020069736f6d6d703432000000086d646174", "hex");
const upload = (name, data, extra = {}) => ({ name, data: data.toString("base64"), ...extra });
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-picture-size-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function messaging(file = ":memory:") {
  const m = createMessaging({ file, users: () => people, agentName: () => "Agent", askAgent: async () => "ok" });
  const route = async (userId, method, url, body = {}) => {
    let response;
    await m.handle({ setHeader() {} }, { setHeader() {} }, { user: people[userId], method, parts: url.split("?")[0].split("/").filter(Boolean), url: new URL(url, "http://local"), cors: {}, readBody: async () => body,
      isAuthorized: () => true, send: (_r, status, data) => { response = { status, data }; }, fail: (_r, status, code) => { response = { status, code }; } });
    return response;
  };
  return { m, route };
}
const shape = file => ({ width: file.width, height: file.height });

test("a message's files come with their width and height: when it is sent, when it is read, and in the gallery", async () => {
  const { m, route } = messaging();
  try {
    const c = m.createChannel(people.pat, { name: "pictures", memberIds: ["jo"] });
    const sent = await route("pat", "POST", `/v1/conversations/${c.id}/messages`, { text: "A banner, a clip and some notes", attachments: [
      upload("banner.png", png(1600, 500)),
      upload("portrait.jpg", jpeg({ width: 4032, height: 3024, orientation: 6 }), { width: 10, height: 10 }),
      upload("clip.mp4", VIDEO, { width: 1920, height: 1080 }),
      upload("notes.txt", ascii("hello"), { width: 800, height: 600 }),
    ] });
    assert.equal(sent.status, 201);
    const check = (files, where) => {
      assert.deepEqual(files.map(file => file.name), ["banner.png", "portrait.jpg", "clip.mp4", "notes.txt"], where);
      assert.deepEqual(shape(files[0]), { width: 1600, height: 500 }, `${where}: read from the picture`);
      assert.deepEqual(shape(files[1]), { width: 3024, height: 4032 }, `${where}: as it is shown, whatever the app said`);
      assert.deepEqual(shape(files[2]), { width: 1920, height: 1080 }, `${where}: a video keeps the size its sender's app gave`);
      assert.ok(!("width" in files[3]) && !("height" in files[3]), `${where}: a document has none`);
      for (const file of files) assert.equal(file.data, undefined, `${where}: never the bytes`);
    };
    check(sent.data.message.attachments, "the answer to the sender");
    assert.deepEqual(Object.keys(sent.data.message.attachments[3]).sort(), ["id", "mime", "name", "size"]);
    const read = (await route("jo", "GET", `/v1/conversations/${c.id}/messages`)).data.messages.find(post => post.id === sent.data.message.id);
    check(read.attachments, "the conversation");
    const gallery = (await route("jo", "GET", `/v1/conversations/${c.id}/media`)).data.items;
    check(gallery, "the gallery");
    assert.equal(gallery[0].messageId, sent.data.message.id);
    // The conversation's last message in the list carries them too.
    const listed = (await route("jo", "GET", "/v1/conversations")).data.conversations.find(conversation => conversation.id === c.id);
    check(listed.lastMessage.attachments, "the list");
  } finally { m.close(); }
});

test("a picture the agent posts, or one posted for it, is measured the same way", async () => {
  const { m, route } = messaging();
  try {
    const c = m.createChannel(people.pat, { name: "pictures" });
    const picture = validateUploads([upload("chart.png", png(1200, 900))]);
    m.post(c, "pat", "Posted in code", null, { attachments: picture });
    m.notifyFromAgent("pat", "A chart for you", { attachments: picture });
    const rows = m.db.prepare("SELECT width, height FROM attachments").all();
    assert.equal(rows.length, 2);
    for (const row of rows) assert.deepEqual({ ...row }, { width: 1200, height: 900 });
    const shown = (await route("pat", "GET", `/v1/conversations/${c.id}/messages`)).data.messages.find(post => post.text === "Posted in code");
    assert.deepEqual(shape(shown.attachments[0]), { width: 1200, height: 900 });
  } finally { m.close(); }
});

test("a file stored before sizes were kept has none, still opens, and a database from then gains the columns", async t => {
  const file = path.join(directory(t), "messages.db");
  let { m, route } = messaging(file);
  let channel, old;
  try {
    channel = m.createChannel(people.pat, { name: "pictures" });
    old = m.post(channel, "pat", "An old picture", null, { attachments: validateUploads([upload("old.png", png(640, 480))]) });
  } finally { m.close(); }
  // The database as an earlier version left it: no width, no height.
  const db = new DatabaseSync(file);
  db.exec("ALTER TABLE attachments DROP COLUMN width; ALTER TABLE attachments DROP COLUMN height");
  assert.deepEqual(db.prepare("PRAGMA table_info(attachments)").all().map(column => column.name), ["id", "message_seq", "name", "mime", "size", "data"]);
  db.close();
  ({ m, route } = messaging(file));
  try {
    const columns = m.db.prepare("PRAGMA table_info(attachments)").all().map(column => column.name);
    assert.ok(columns.includes("width") && columns.includes("height"));
    const shown = (await route("pat", "GET", `/v1/conversations/${channel.id}/messages`)).data.messages.find(post => post.id === String(old.seq));
    assert.deepEqual(Object.keys(shown.attachments[0]).sort(), ["id", "mime", "name", "size"], "exactly what was sent before");
    const bytes = await route("pat", "GET", `/v1/attachments/${shown.attachments[0].id}`);
    assert.equal(bytes.status, 200);
    assert.deepEqual(Buffer.from(bytes.data.data, "base64"), png(640, 480));
    assert.deepEqual(Object.keys((await route("pat", "GET", `/v1/conversations/${channel.id}/media`)).data.items[0]).sort(), ["createdAt", "id", "messageId", "mime", "name", "sender", "size", "text"]);
    // A picture sent now is measured.
    const fresh = await route("pat", "POST", `/v1/conversations/${channel.id}/messages`, { attachments: [upload("new.png", png(640, 480))] });
    assert.deepEqual(shape(fresh.data.message.attachments[0]), { width: 640, height: 480 });
  } finally { m.close(); }
});

test("an agent chat's files come with their width and height, and an older chat database gains the columns", t => {
  const file = path.join(directory(t), "chat-media.db");
  let store = createChatMediaStore(file);
  const sender = { id: "pat", name: "Pat Tester" };
  try {
    const mine = store.accept("chat_1", "user", "Two pictures and a clip", validateUploads([upload("banner.png", png(1600, 500)), upload("clip.mp4", VIDEO, { width: 1080, height: 1920 })]), "turn-1");
    assert.deepEqual(mine.attachments.map(shape), [{ width: 1600, height: 500 }, { width: 1080, height: 1920 }]);
    const reply = store.accept("chat_1", "assistant", "Here is the chart", [{ name: "chart.webp", mime: "image/webp", data: webp.lossy(600, 1300) }], "turn-1");
    assert.deepEqual(shape(reply.attachments[0]), { width: 600, height: 1300 });
    // A document is kept on disk and has no shape; one that is not a picture has none either.
    const papers = store.accept("chat_1", "user", "A document", [{ name: "plan.pdf", mime: "application/pdf", size: 9, file: "/data/documents/plan.pdf" }, { name: "notes.txt", mime: "application/octet-stream", data: ascii("hello") }], "turn-2");
    for (const paper of papers.attachments) assert.deepEqual(Object.keys(paper).sort(), ["id", "mime", "name", "size"]);
    assert.deepEqual(store.history("chat_1").map(message => message.attachments.map(shape)), [[{ width: 1600, height: 500 }, { width: 1080, height: 1920 }], [{ width: 600, height: 1300 }], [{ width: undefined, height: undefined }, { width: undefined, height: undefined }]]);
    assert.deepEqual(store.media("chat_1", sender).slice(0, 3).map(shape), [{ width: 1600, height: 500 }, { width: 1080, height: 1920 }, { width: 600, height: 1300 }]);
    assert.deepEqual(shape(store.last("chat_1").attachments[0]), { width: undefined, height: undefined });
  } finally { store.close(); }
  const db = new DatabaseSync(file);
  db.exec("ALTER TABLE chat_attachments DROP COLUMN width; ALTER TABLE chat_attachments DROP COLUMN height");
  db.close();
  store = createChatMediaStore(file);
  try {
    const before = store.history("chat_1");
    assert.equal(before.length, 3, "what was there is still there");
    assert.deepEqual(Object.keys(before[0].attachments[0]).sort(), ["id", "mime", "name", "size"]);
    assert.ok(store.attachment(before[0].attachments[0].id).data.length > 0, "and still opens");
    const fresh = store.accept("chat_1", "user", "", validateUploads([upload("new.gif", gif(320, 200))]), "turn-3");
    assert.deepEqual(shape(fresh.attachments[0]), { width: 320, height: 200 });
  } finally { store.close(); }
});
