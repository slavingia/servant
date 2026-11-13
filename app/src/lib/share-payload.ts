// What another app handed Servant through the share sheet, in one shape for the "Send to agent"
// screen (app/share.tsx) and the composer's attachment helpers. expo-sharing gives two views of
// a share: raw payloads (sync; on Android a file is still a content:// address the app can't
// read later) and resolved ones (the file copied where the app can read it, with its name and
// size). Platform-free and tested.
import { MAX_DOCUMENT_BYTES, MAX_FILE_BYTES, MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, formatFileSize, isPreviewVideo } from "./media.ts";

export type SharedKind = "image" | "video" | "audio" | "file";
/** One shared file: where to read it, what to call it, and how the composer should treat it. */
export type SharedFile = { uri: string; name: string; mime: string; size: number | null; kind: SharedKind };
/** files to attach; text for the message box (a shared link goes there too); url for the link card. */
export type SharedContent = { files: SharedFile[]; text: string; url: string | null };

export type RawSharePayload = { value?: string | null; shareType?: string | null; mimeType?: string | null };
export type ResolvedSharePayload = RawSharePayload & {
  contentUri?: string | null; contentType?: string | null; contentMimeType?: string | null; contentSize?: number | null; originalName?: string | null;
};

export const MAX_SHARED_FILES = 4;
export const EMPTY_SHARE: SharedContent = { files: [], text: "", url: null };

const FILE_KINDS = new Set(["image", "video", "audio", "file"]);
const LINK = /^https?:\/\/\S+$/i;
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav",
  txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", zip: "application/zip",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const EXTENSION_BY_MIME: Record<string, string> = Object.fromEntries(Object.entries(MIME_BY_EXTENSION).map(([ext, mime]) => [mime, ext]).reverse());

export function kindOf(mime: string, hint?: string | null): SharedKind {
  const lower = mime.toLowerCase();
  if (lower.startsWith("image/")) return "image";
  if (lower.startsWith("video/")) return "video";
  if (lower.startsWith("audio/")) return "audio";
  // A specific type wins; a vague one ("application/octet-stream") leaves it to what the OS said it was.
  if (lower && lower !== "application/octet-stream") return "file";
  return hint === "image" || hint === "video" || hint === "audio" ? hint : "file";
}

/** The last path segment of a file address, decoded; null when there isn't a usable one. */
export function fileNameFromUri(uri: string): string | null {
  const path = uri.split(/[?#]/)[0]!;
  const last = path.slice(path.lastIndexOf("/") + 1);
  if (!last || last.includes(":")) return null;
  try { return decodeURIComponent(last); } catch { return last; }
}

const normalizeMime = (value: unknown) => typeof value === "string" ? value.split(";")[0]!.trim().toLowerCase() : "";
// Android's resolved copies come as Java file URIs ("file:/data/…"); everything downstream expects "file:///".
const normalizeUri = (uri: string) => uri.replace(/^file:\/(?!\/)/i, "file:///");
const mimeFromName = (name: string) => MIME_BY_EXTENSION[name.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? ""] ?? null;
const withExtension = (name: string, mime: string) => /\.[a-z0-9]{1,8}$/i.test(name) || !EXTENSION_BY_MIME[mime] ? name : `${name}.${EXTENSION_BY_MIME[mime]}`;

/** Files have to be resolved (copied, measured, named); text and links are complete as they are. */
export const needsResolution = (raw: readonly RawSharePayload[]) => raw.some(item => FILE_KINDS.has(item.shareType ?? ""));

/**
 * Raw payloads in the order expo-sharing gave them, plus the resolved view when it arrived
 * (same length, same order). Files come first in `files`; every piece of text or link ends up in
 * `text`, so the message box starts with what was shared.
 */
export function parseSharedPayloads(raw: readonly RawSharePayload[], resolved?: readonly ResolvedSharePayload[] | null): SharedContent {
  const paired = resolved && resolved.length === raw.length ? resolved : null;
  const files: SharedFile[] = [];
  const lines: string[] = [];
  const seen = new Set<string>();
  let url: string | null = null;
  raw.forEach((item, index) => {
    const value = typeof item?.value === "string" ? item.value.trim() : "";
    if (!value) return;
    const type = typeof item.shareType === "string" ? item.shareType : "text";
    if (FILE_KINDS.has(type)) {
      const extra = paired?.[index];
      const uri = normalizeUri((typeof extra?.contentUri === "string" && extra.contentUri) || value);
      if (seen.has(uri)) return;
      seen.add(uri);
      const baseName = (typeof extra?.originalName === "string" && extra.originalName.trim()) || fileNameFromUri(uri) || "";
      const declared = normalizeMime(extra?.contentMimeType) || normalizeMime(item.mimeType);
      const mime = (declared && declared !== "application/octet-stream" ? declared : null) ?? (baseName ? mimeFromName(baseName) : null) ?? declared ?? "application/octet-stream";
      const size = typeof extra?.contentSize === "number" && Number.isFinite(extra.contentSize) && extra.contentSize >= 0 ? Math.floor(extra.contentSize) : null;
      files.push({ uri, name: withExtension(baseName || `shared-${files.length + 1}`, mime), mime, size, kind: kindOf(mime, type) });
      return;
    }
    if (type === "url" || LINK.test(value)) url ??= value;
    if (!lines.includes(value)) lines.push(value);
  });
  return { files, text: lines.join("\n\n"), url };
}

/**
 * Why one file can't go as it is, before any bytes are read: the composer's per-file limits and the video types
 * it can send (media.ts), in plain words that name the file. Null when it can; an unknown size is checked once
 * the bytes are read. Photos are never refused here: big or odd ones are shrunk and re-encoded on the way.
 */
export function fileProblem(file: SharedFile): string | null {
  const measured = file.size === null ? "" : `${file.name} is ${formatFileSize(file.size)}. `;
  if (file.kind === "video") {
    if (/^video\//i.test(file.mime) && !isPreviewVideo(file)) return `${file.name} isn't a video Servant can send. Share an MP4, MOV or WebM video.`;
    return file.size !== null && file.size > MAX_VIDEO_BYTES ? `${measured}Videos must be under 25 MB.` : null;
  }
  if (file.kind === "image") return null;
  return file.size !== null && file.size > MAX_DOCUMENT_BYTES ? `${measured}Files must be under 100 MB.` : null;
}

/** What stops the share going: each file that can't be sent (by its address), and anything about the share as a whole. */
export function shareProblems(files: readonly SharedFile[]): { files: Map<string, string>; overall: string | null } {
  const problems = new Map<string, string>();
  for (const file of files) { const problem = fileProblem(file); if (problem) problems.set(file.uri, problem); }
  let overall: string | null = null;
  if (files.length > MAX_SHARED_FILES) overall = `Share up to ${MAX_SHARED_FILES} files at a time.`;
  else {
    let inline = 0;
    for (const file of files) {
      if (file.size === null) continue;
      if (file.kind === "video") inline += file.size;
      // Big photos are shrunk to fit, the way the composer does it.
      else if (file.kind === "image") inline += Math.min(file.size, MAX_FILE_BYTES);
    }
    if (inline > MAX_UPLOAD_BYTES) overall = "Photos and videos must be under 30 MB in total.";
  }
  return { files: problems, overall };
}

/** The line beside a Send that's switched off: what to remove so the rest can go. Null when nothing blocks it. */
export function sendBlockedReason(files: readonly SharedFile[]): string | null {
  const { files: problems, overall } = shareProblems(files);
  if (problems.size === 1) return `Remove ${files.find(file => problems.has(file.uri))!.name} to send.`;
  if (problems.size > 1) return `Remove the ${problems.size} files marked above to send.`;
  if (!overall) return null;
  return files.length > MAX_SHARED_FILES ? `${overall} Remove ${files.length - MAX_SHARED_FILES} to send.` : `${overall} Remove a photo or video to send.`;
}

/** The composer's limits, in plain words, before any bytes are read: the first file that can't go, else the share as a whole. Null when everything fits. */
export function shareLimitError(files: readonly SharedFile[]): string | null {
  const { files: problems, overall } = shareProblems(files);
  return problems.values().next().value ?? overall;
}

/**
 * A file name on one line: the middle gives way while the extension and the end of the name stay, so
 * "Screenshot 2026-11-09.png" reads "Screen…11-09.png" and two names that differ only at the end still tell apart.
 * `max` counts characters; the full name belongs in the accessibility label.
 */
export function shortenFileName(name: string, max: number): string {
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  if (max < 5) return `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
  const ext = name.match(/\.[a-z0-9]{1,8}$/i)?.[0] ?? "";
  const base = Array.from(name.slice(0, name.length - ext.length));
  const room = max - 1 - Array.from(ext).length;
  if (room < 2) return `${chars.slice(0, max - 1).join("")}…`;
  const tail = Math.min(5, Math.floor(room / 2));
  return `${base.slice(0, room - tail).join("")}…${base.slice(base.length - tail).join("")}${ext}`;
}

/** How many characters of a file name fit in `width` points at `fontSize`: an average glyph is about 0.56 em wide. */
export const nameCharsFor = (width: number, fontSize: number) => Math.max(8, Math.floor(width / (fontSize * 0.56)));

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "2 photos and a PDF", "A link", "Some text": the line above what's being sent. */
export function describeShare(content: SharedContent): string {
  const count = (kind: SharedKind) => content.files.filter(file => file.kind === kind).length;
  const parts = [
    count("image") ? plural(count("image"), "photo") : "",
    count("video") ? plural(count("video"), "video") : "",
    count("audio") ? plural(count("audio"), "audio file") : "",
    count("file") ? plural(count("file"), "file") : "",
  ].filter(Boolean);
  if (!parts.length) parts.push(content.url ? "a link" : content.text ? "some text" : "nothing yet");
  else if (content.url) parts.push("a link");
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]!;
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

// The address the share extension (iOS) and the intent listener (Android) open the app with:
// `<scheme>://expo-sharing`. Also the forms a dev client wraps it in. Never throws: this runs in
// +native-intent.tsx, outside the app, for every link the app is opened with.
const SHARE_LAUNCH = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^/?#]*\/--)?\/*expo-sharing(?:[/?#]|$)/i;
export const isShareLaunch = (path: unknown): boolean => typeof path === "string" && SHARE_LAUNCH.test(path.trim());
