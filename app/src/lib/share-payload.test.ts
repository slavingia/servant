import { test } from "node:test";
import assert from "node:assert/strict";
import { describeShare, fileNameFromUri, fileProblem, isShareLaunch, kindOf, nameCharsFor, needsResolution, parseSharedPayloads, sendBlockedReason, shareLimitError, shareProblems, shortenFileName, type SharedFile } from "./share-payload.ts";

const MB = 1024 * 1024;
const file = (over: Partial<SharedFile>): SharedFile => ({ uri: "file:///x", name: "x", mime: "application/octet-stream", size: null, kind: "file", ...over });

test("iPhone photos: the extension's copies, named and measured by the resolved view", () => {
  const raw = [
    { shareType: "image", value: "file:///private/var/mobile/Containers/Shared/AppGroup/ABC/IMG_0001.HEIC", mimeType: "image/heic" },
    { shareType: "image", value: "file:///private/var/mobile/Containers/Shared/AppGroup/ABC/IMG_0002.jpeg", mimeType: "image/jpeg" },
  ];
  const resolved = raw.map((item, i) => ({ ...item, contentUri: item.value, contentType: "image", contentMimeType: item.mimeType, contentSize: (i + 1) * MB, originalName: item.value.split("/").pop()! }));
  const content = parseSharedPayloads(raw, resolved);
  assert.deepEqual(content.files, [
    { uri: raw[0]!.value, name: "IMG_0001.HEIC", mime: "image/heic", size: MB, kind: "image" },
    { uri: raw[1]!.value, name: "IMG_0002.jpeg", mime: "image/jpeg", size: 2 * MB, kind: "image" },
  ]);
  assert.equal(content.text, "");
  assert.equal(content.url, null);
});

test("Android file: the content:// address becomes the readable copy, with the display name and size", () => {
  const raw = [{ shareType: "file", value: "content://com.android.providers.downloads.documents/document/123", mimeType: "application/pdf" }];
  const resolved = [{ ...raw[0], contentUri: "file:///data/user/0/com.example.servant/cache/Report.pdf", contentType: "file", contentMimeType: "application/pdf", contentSize: 20480, originalName: "Report.pdf" }];
  assert.deepEqual(parseSharedPayloads(raw, resolved).files, [{ uri: "file:///data/user/0/com.example.servant/cache/Report.pdf", name: "Report.pdf", mime: "application/pdf", size: 20480, kind: "file" }]);
  // Resolving failed: keep the address we have, name it from the type, size unknown.
  assert.deepEqual(parseSharedPayloads(raw, null).files, [{ uri: raw[0]!.value, name: "123.pdf", mime: "application/pdf", size: null, kind: "file" }]);
  // Android hands back Java's one-slash file URI for the copy; it becomes a normal file:/// address.
  assert.equal(parseSharedPayloads(raw, [{ ...resolved[0]!, contentUri: "file:/data/user/0/com.example.servant/cache/Report.pdf" }]).files[0]!.uri, "file:///data/user/0/com.example.servant/cache/Report.pdf");
  // A resolved list that doesn't line up is ignored rather than mismatched.
  assert.deepEqual(parseSharedPayloads(raw, []).files, parseSharedPayloads(raw, null).files);
});

test("text and links go to the message box; a link is also kept for the card", () => {
  assert.deepEqual(parseSharedPayloads([{ shareType: "text", value: "  Hello there  " }]), { files: [], text: "Hello there", url: null });
  assert.deepEqual(parseSharedPayloads([{ shareType: "url", value: "https://www.example.gov/refunds", mimeType: "text/html" }]), { files: [], text: "https://www.example.gov/refunds", url: "https://www.example.gov/refunds" });
  // Android marks a bare address as text; it's still a link.
  assert.equal(parseSharedPayloads([{ shareType: "text", value: "https://example.com/a?b=1" }]).url, "https://example.com/a?b=1");
  assert.equal(parseSharedPayloads([{ shareType: "text", value: "see https://example.com" }]).url, null);
  // Missing type means text.
  assert.equal(parseSharedPayloads([{ value: "plain" }]).text, "plain");
});

test("several things at once: files first, every line of text joined, repeats and blanks dropped", () => {
  const content = parseSharedPayloads([
    { shareType: "text", value: "Refund timing" },
    { shareType: "url", value: "https://www.example.gov/refunds" },
    { shareType: "image", value: "file:///g/a.png", mimeType: "image/png" },
    { shareType: "image", value: "file:///g/a.png", mimeType: "image/png" },
    { shareType: "text", value: "   " },
    { shareType: "video", value: "", mimeType: "video/mp4" },
  ]);
  assert.equal(content.files.length, 1);
  assert.equal(content.text, "Refund timing\n\nhttps://www.example.gov/refunds");
  assert.equal(content.url, "https://www.example.gov/refunds");
});

test("types and names: a vague type gives way to the file name, a nameless file gets one", () => {
  const [notes] = parseSharedPayloads([{ shareType: "file", value: "file:///g/notes.md", mimeType: "application/octet-stream" }]).files;
  assert.equal(notes!.mime, "text/markdown");
  const [photo] = parseSharedPayloads([{ shareType: "image", value: "file:///g/", mimeType: "application/octet-stream" }]).files;
  assert.deepEqual([photo!.name, photo!.kind], ["shared-1", "image"]);
  const [clip] = parseSharedPayloads([{ shareType: "video", value: "content://media/external/video/media/77", mimeType: "video/quicktime; charset=binary" }]).files;
  assert.deepEqual([clip!.name, clip!.mime, clip!.kind], ["77.mov", "video/quicktime", "video"]);
  assert.equal(fileNameFromUri("file:///a/b/My%20Report.pdf?x=1"), "My Report.pdf");
  assert.equal(fileNameFromUri("content:"), null);
  assert.equal(kindOf("AUDIO/mp4"), "audio");
  assert.equal(kindOf("application/octet-stream", "video"), "video");
  assert.equal(kindOf("application/pdf", "image"), "file");
});

test("only files need resolving", () => {
  assert.equal(needsResolution([{ shareType: "text", value: "x" }, { shareType: "url", value: "https://a" }]), false);
  assert.equal(needsResolution([{ shareType: "text", value: "x" }, { shareType: "file", value: "content://x" }]), true);
});

test("each file that can't go says so by name, with its size and the limit; photos never do", () => {
  const zip = file({ uri: "file:///z", name: "Town hall recording.zip", mime: "application/zip", kind: "file", size: 101 * MB });
  assert.equal(fileProblem(zip), "Town hall recording.zip is 101.0 MB. Files must be under 100 MB.");
  assert.equal(fileProblem({ ...zip, size: 100 * MB }), null);
  assert.equal(fileProblem(file({ name: "Clip.mov", mime: "video/quicktime", kind: "video", size: 26 * MB })), "Clip.mov is 26.0 MB. Videos must be under 25 MB.");
  assert.equal(fileProblem(file({ name: "Clip.mov", mime: "video/quicktime", kind: "video", size: 25 * MB })), null);
  // A video type Servant can't send is refused before its bytes are read; a vague type is left to the reader.
  assert.equal(fileProblem(file({ name: "Town hall clip.avi", mime: "video/x-msvideo", kind: "video", size: 8 * MB })), "Town hall clip.avi isn't a video Servant can send. Share an MP4, MOV or WebM video.");
  assert.equal(fileProblem(file({ name: "77", mime: "application/octet-stream", kind: "video", size: 8 * MB })), null);
  // Big or odd photos are shrunk on the way; audio goes as a document.
  assert.equal(fileProblem(file({ name: "IMG_1.heic", mime: "image/heic", kind: "image", size: 40 * MB })), null);
  assert.equal(fileProblem(file({ name: "memo.m4a", mime: "audio/mp4", kind: "audio", size: 60 * MB })), null);
  assert.equal(fileProblem(file({ kind: "file" })), null, "an unknown size is checked when the bytes are read");
});

test("what blocks Send: the marked files, else the share as a whole, and the line beside the button", () => {
  const zip = file({ uri: "file:///z", name: "Town hall recording.zip", kind: "file", size: 101 * MB });
  const pdf = file({ uri: "file:///p", name: "Refund timeline FY26.pdf", kind: "file", size: 20 * 1024 });
  const avi = file({ uri: "file:///a", name: "Town hall clip.avi", mime: "video/x-msvideo", kind: "video", size: 8 * MB });
  assert.deepEqual(shareProblems([zip, pdf]), { files: new Map([["file:///z", "Town hall recording.zip is 101.0 MB. Files must be under 100 MB."]]), overall: null });
  assert.equal(sendBlockedReason([zip, pdf]), "Remove Town hall recording.zip to send.");
  assert.equal(sendBlockedReason([zip, avi, pdf]), "Remove the 2 files marked above to send.");
  assert.equal(sendBlockedReason([pdf]), null);
  // Limits on the share as a whole: too many files, or too much for one message.
  const five = Array.from({ length: 5 }, (_, i) => file({ uri: `file:///${i}`, kind: "image", size: MB }));
  assert.equal(shareProblems(five).overall, "Share up to 4 files at a time.");
  assert.equal(sendBlockedReason(five), "Share up to 4 files at a time. Remove 1 to send.");
  const clips = [file({ uri: "file:///1", mime: "video/mp4", kind: "video", size: 20 * MB }), file({ uri: "file:///2", mime: "video/mp4", kind: "video", size: 11 * MB })];
  assert.equal(sendBlockedReason(clips), "Photos and videos must be under 30 MB in total. Remove a photo or video to send.");
  // Big photos get shrunk, so they count 5 MB each toward the total; documents don't count.
  assert.equal(shareProblems([file({ uri: "a", kind: "image", size: 12 * MB }), file({ uri: "b", kind: "image", size: 12 * MB }), file({ uri: "c", kind: "image", size: 12 * MB })]).overall, null);
  assert.equal(sendBlockedReason([file({ uri: "a", kind: "file", size: 90 * MB }), file({ uri: "b", mime: "video/mp4", kind: "video", size: 24 * MB })]), null);
  assert.equal(sendBlockedReason([file({ uri: "a", mime: "video/mp4", kind: "video" }), file({ uri: "b", kind: "image" })]), null, "unknown sizes are checked when the bytes are read");
  // The guard before sending: the first marked file, else the share as a whole.
  assert.equal(shareLimitError([pdf, zip]), "Town hall recording.zip is 101.0 MB. Files must be under 100 MB.");
  assert.equal(shareLimitError(clips), "Photos and videos must be under 30 MB in total.");
  assert.equal(shareLimitError([pdf]), null);
});

test("a long file name gives way in the middle and keeps its extension and its ending", () => {
  assert.equal(shortenFileName("Screenshot 2026-11-09.png", 16), "Screen…11-09.png");
  assert.equal(shortenFileName("Screenshot 2026-11-09.png", 24), "Screenshot 202…11-09.png");
  assert.equal(shortenFileName("Screenshot 2026-11-09.png", 25), "Screenshot 2026-11-09.png");
  assert.equal(shortenFileName("IMG_4821.jpg", 16), "IMG_4821.jpg");
  // Two names that differ only at the end still tell apart.
  assert.equal(shortenFileName("Refund timeline FY26 final v2.pdf", 20), "Refund tim…al v2.pdf");
  assert.notEqual(shortenFileName("Refund timeline FY26 final v2.pdf", 20), shortenFileName("Refund timeline FY26 final v3.pdf", 20));
  // No extension, a double one, an extension that wouldn't fit on its own, hardly any room, and characters that count as one.
  assert.equal(shortenFileName("Notes from the Tuesday town hall", 14), "Notes fr… hall");
  assert.equal(shortenFileName("archive.tar.gz", 10), "arc…tar.gz");
  assert.equal(shortenFileName("ab.verylong", 5), "ab.v…");
  assert.equal(shortenFileName("abcdefghij", 4), "abc…");
  assert.equal(shortenFileName("🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂.png", 10), "🙂🙂🙂…🙂🙂.png");
  // How many fit: about 0.56 em a character, never fewer than 8.
  assert.equal(nameCharsFor(104, 12), 15);
  assert.equal(nameCharsFor(285, 13), 39);
  assert.equal(nameCharsFor(20, 13), 8);
});

test("the line above what's being sent", () => {
  assert.equal(describeShare({ files: [file({ kind: "image" })], text: "", url: null }), "1 photo");
  assert.equal(describeShare({ files: [file({ kind: "image" }), file({ kind: "image" }), file({ kind: "file" })], text: "", url: null }), "2 photos and 1 file");
  assert.equal(describeShare({ files: [file({ kind: "video" }), file({ kind: "audio" }), file({ kind: "file" })], text: "", url: null }), "1 video, 1 audio file and 1 file");
  assert.equal(describeShare({ files: [], text: "https://a", url: "https://a" }), "A link");
  assert.equal(describeShare({ files: [], text: "hi", url: null }), "Some text");
  assert.equal(describeShare({ files: [file({ kind: "image" })], text: "https://a", url: "https://a" }), "1 photo and a link");
  assert.equal(describeShare({ files: [], text: "", url: null }), "Nothing yet");
});

test("the share launch address, in every form the app can be opened with", () => {
  for (const ok of ["servant://expo-sharing", "servant://expo-sharing/", "servant://expo-sharing?x=1", "servant:///expo-sharing", "/expo-sharing", "expo-sharing", "exp://192.168.1.5:8081/--/expo-sharing", "SERVANT://EXPO-SHARING"]) assert.ok(isShareLaunch(ok), ok);
  for (const no of ["servant://chat/abc", "servant://expo-sharing-else", "servant://", "https://servant.com/c/x", "https://expo-sharing.example.com/", "", undefined, 42, null]) assert.ok(!isShareLaunch(no), String(no));
});
