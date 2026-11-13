import type { Attachment, Post, Upload } from "./server";

export type MediaScope = { kind: "conversation" | "chat"; id: string };
export type MediaItem = Attachment & {
  messageId: string;
  sender: { id: string; name: string; agent?: boolean };
  createdAt: number;
  text?: string;
  width?: number;
  height?: number;
};
export type MediaPage = { items: MediaItem[]; nextCursor: string | null };
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
// Documents and design files upload in chunks, outside the 30 MB message limit.
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
export const DOCUMENT_CHUNK_BYTES = 3 * 1024 * 1024;

export function validateAttachmentSelection(files: readonly { mime: string; size: number; document?: unknown }[]) {
  if (files.length > 4) throw new Error("Attach up to 4 files");
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Couldn't read this file");
    if (file.document) {
      if (file.size > MAX_DOCUMENT_BYTES) throw new Error("Choose documents under 100 MB each");
      continue;
    }
    // Only images go to the model inline (5 MB cap); videos and other files get 25 MB.
    const image = file.mime.startsWith("image/");
    if (file.size > (image ? MAX_FILE_BYTES : MAX_VIDEO_BYTES)) {
      throw new Error(image ? "Choose photos under 5 MB each" : "Choose videos and files under 25 MB each");
    }
  }
  if (files.reduce((total, file) => total + (file.document ? 0 : file.size), 0) > MAX_UPLOAD_BYTES) throw new Error("Attachments must be under 30 MB total");
}

export function mediaRoute(scope: MediaScope, after?: string) {
  const collection = scope.kind === "chat" ? "chats" : "conversations";
  return `/v1/${collection}/${encodeURIComponent(scope.id)}/media?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
}

function messageOrder(a: string, b: string) {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  // Chat IDs are opaque; tied timestamps must retain the server's sequence.
  return 0;
}

/** Keep the selected file identified by ID while older pages are inserted. */
export function mergeMediaItems(...groups: readonly (readonly MediaItem[])[]): MediaItem[] {
  const items = new Map<string, MediaItem>();
  for (const group of groups) for (const item of group) items.set(item.id, { ...items.get(item.id), ...item });
  return [...items.values()].sort((a, b) => a.createdAt - b.createdAt || messageOrder(a.messageId, b.messageId));
}

export function mediaFromPosts(posts: readonly Post[]): MediaItem[] {
  return posts.flatMap(post => post.deleted || (post.pending && post.user.agent) ? [] : (post.attachments ?? []).map(file => ({
    ...file, messageId: post.id, sender: post.user, createdAt: post.createdAt, text: post.text,
  })));
}

export function mediaFromMessages(messages: readonly {
  id: string; role: "user" | "assistant"; text: string; at?: number | string | null; attachments?: Attachment[]; pending?: boolean;
}[], userName: string, agentName = "Agent"): MediaItem[] {
  return messages.flatMap(message => message.role === "assistant" && message.pending ? [] : (message.attachments ?? []).map(file => {
    const timestamp = typeof message.at === "number" ? message.at : message.at ? Date.parse(message.at) : 0;
    return { ...file, messageId: message.id, sender: { id: message.role, name: message.role === "user" ? userName : agentName, agent: message.role === "assistant" }, createdAt: Number.isFinite(timestamp) ? timestamp : 0, text: message.text };
  }));
}

export function readMediaPage(value: unknown): MediaPage {
  if (!value || typeof value !== "object") throw new Error("Invalid gallery response");
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.items) || (page.nextCursor !== null && (typeof page.nextCursor !== "string" || !page.nextCursor))) throw new Error("Invalid gallery response");
  for (const item of page.items) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id || typeof item.name !== "string" || typeof item.mime !== "string"
      || typeof item.size !== "number" || item.size < 0 || !Number.isFinite(item.size) || typeof item.messageId !== "string"
      || typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt) || !item.sender || typeof item.sender.name !== "string" || typeof item.sender.id !== "string"
      || (item.text !== undefined && typeof item.text !== "string") || (item.sender.agent !== undefined && typeof item.sender.agent !== "boolean")) {
      throw new Error("Invalid gallery item");
    }
  }
  return page as MediaPage;
}

export function formatFileSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function isPreviewImage(file: { mime: string }) {
  return /^image\/(png|jpeg|gif|webp|heic|heif|avif)$/i.test(file.mime);
}

export function isPreviewVideo(file: { mime: string }) {
  return /^video\/(mp4|quicktime|webm)$/i.test(file.mime);
}

function decodePrefix(data: string, bytes = 4096) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let bits = 0, available = 0, signature = "";
  for (const character of data.slice(0, Math.ceil(bytes / 3) * 4)) {
    const value = alphabet.indexOf(character);
    if (value < 0) break;
    bits = (bits << 6) | value; available += 6;
    if (available >= 8) { available -= 8; signature += String.fromCharCode((bits >>> available) & 255); }
  }
  return signature.slice(0, bytes);
}

function webmHeader(signature: string) {
  if (!signature.startsWith("\x1a\x45\xdf\xa3")) return false;
  const vint = (offset: number, id = false): { value: number; length: number } | undefined => {
    const first = signature.charCodeAt(offset);
    if (!Number.isFinite(first) || first === 0) return;
    let mask = 0x80, length = 1;
    while (!(first & mask) && length <= (id ? 4 : 8)) { mask >>= 1; length++; }
    if (!mask || length > (id ? 4 : 8) || offset + length > signature.length) return;
    let value = id ? first : first & (mask - 1);
    for (let i = 1; i < length; i++) value = value * 256 + signature.charCodeAt(offset + i);
    if (!Number.isSafeInteger(value) || (!id && value === 2 ** (7 * length) - 1)) return;
    return { value, length };
  };
  const header = vint(4);
  if (!header || 4 + header.length + header.value > signature.length) return false;
  const end = 4 + header.length + header.value;
  let offset = 4 + header.length;
  while (offset < end) {
    const id = vint(offset, true);
    if (!id) return false;
    offset += id.length;
    const size = vint(offset);
    if (!size || offset + size.length + size.value > end) return false;
    offset += size.length;
    if (id.value === 0x4282) return signature.slice(offset, offset + size.value) === "webm";
    offset += size.value;
  }
  return false;
}

/** Inspect bytes rather than names or picker-supplied MIME types. The server validates again. */
export function uploadMediaMime(data: string): string | undefined {
  const signature = decodePrefix(data);
  const brand = signature.slice(8, 12);
  const imageMime = signature.startsWith("\x89PNG\r\n\x1a\n") ? "image/png" : signature.startsWith("\xff\xd8\xff") ? "image/jpeg"
    : /^GIF8[79]a/.test(signature) ? "image/gif" : signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP" ? "image/webp"
      : signature.slice(4, 8) === "ftyp" && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand) ? "image/heic"
        : signature.slice(4, 8) === "ftyp" && /^(avif|avis)$/.test(brand) ? "image/avif" : undefined;
  if (imageMime) return imageMime;
  if (signature.slice(4, 8) === "ftyp") {
    const size = signature.charCodeAt(0) * 0x1000000 + signature.charCodeAt(1) * 0x10000 + signature.charCodeAt(2) * 0x100 + signature.charCodeAt(3);
    if (size < 16 || size > signature.length || size % 4 !== 0 || /^(M4A |M4B |M4P )$/.test(brand)) return;
    const brands = [brand];
    for (let offset = 16; offset < size; offset += 4) brands.push(signature.slice(offset, offset + 4));
    if (brands.includes("qt  ")) return "video/quicktime";
    if (brands.some(value => /^(isom|iso[2345689]|mp41|mp42|avc1|dash|msdh|msix|M4V |M4VH|M4VP)$/.test(value))) return "video/mp4";
  }
  return webmHeader(signature) ? "video/webm" : undefined;
}

/** Upload previews only use recognized raster signatures, never supplied URLs. */
export function uploadImageUri(file: Upload): string | undefined {
  const mime = uploadMediaMime(file.data);
  return mime?.startsWith("image/") ? `data:${mime};base64,${file.data}` : undefined;
}

/** Expo's native picker exports JPEG base64 even when its URI keeps HEIC/AVIF. */
export function jpegPhotoUpload(name: string | null | undefined, data: string, maxBytes = 5 * 1024 * 1024) {
  if (!data.startsWith("/9j/") || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("Couldn't prepare this photo. Choose a JPEG or PNG image.");
  const size = data.length * 3 / 4 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (size > maxBytes) throw new Error("Choose files under 5 MB each");
  const stem = (name || "photo").replace(/\.[^.]+$/, "");
  return { name: `${stem || "photo"}.jpg`, data, size, mime: "image/jpeg", uri: `data:image/jpeg;base64,${data}` };
}

/** A provider owns this cache; disposing it aborts requests and releases private bytes. */
export function createMediaCache(fetchContent: (file: Attachment, signal: AbortSignal) => Promise<string>, maxCharacters = 20 * 1024 * 1024, maxEntries = 8) {
  const entries = new Map<string, string>();
  const pending = new Map<string, { promise: Promise<string>; controller: AbortController }>();
  let characters = 0;
  const peek = (id: string) => entries.get(id);
  const remove = (id: string) => {
    const value = entries.get(id);
    if (value !== undefined) characters -= value.length;
    entries.delete(id);
  };
  const invalidate = (id: string) => {
    remove(id);
    pending.get(id)?.controller.abort();
    pending.delete(id);
  };
  const load = (file: Attachment): Promise<string> => {
    const hit = entries.get(file.id);
    if (hit !== undefined) {
      entries.delete(file.id); entries.set(file.id, hit);
      return Promise.resolve(hit);
    }
    const inFlight = pending.get(file.id);
    if (inFlight) return inFlight.promise;
    const controller = new AbortController();
    const promise = fetchContent(file, controller.signal).then(data => {
      if (controller.signal.aborted) throw new Error("Gallery request cancelled");
      if (data.length <= maxCharacters) {
        remove(file.id);
        while (entries.size && (characters + data.length > maxCharacters || entries.size >= maxEntries)) remove(entries.keys().next().value!);
        entries.set(file.id, data); characters += data.length;
      }
      return data;
    }).finally(() => { if (pending.get(file.id)?.controller === controller) pending.delete(file.id); });
    pending.set(file.id, { promise, controller });
    return promise;
  };
  return { load, peek, invalidate, dispose: () => {
    for (const entry of pending.values()) entry.controller.abort();
    pending.clear(); entries.clear(); characters = 0;
  } };
}
