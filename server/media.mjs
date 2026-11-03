// Media crosses the same authenticated transport as messages. Never resolve an
// agent-emitted local path or fetch a URL here: Hermes supplies inline data URLs
// after applying its own media-delivery policy.
import crypto from "node:crypto";
import { splitCloseMarker } from "./close-marker.mjs";

export const MAX_FILE = 5 * 1024 * 1024;
export const MAX_VIDEO = 25 * 1024 * 1024;
export const MAX_UPLOAD_TOTAL = 30 * 1024 * 1024;
export const MAX_UPLOAD_BODY = 41 * 1024 * 1024;
// Images go to the model inline and Anthropic refuses images over 5 MB. Videos
// and other files (ZIPs, PDFs, prototypes) never travel to the model as bytes.
const sizeMessage = "Images must be under 5 MB, other files under 25 MB, and attachments under 30 MB total";
export const uploadLimit = mime => mime.startsWith("image/") ? MAX_FILE : MAX_VIDEO;
const error = (status, message) => Object.assign(new Error(message), { status, code: "attachments" });
export const safeName = value => String(value || "image").replace(/[\\/\x00-\x1f\x7f]/g, "_").slice(0, 180);

export function rasterMime(data) {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a/.test(data.subarray(0, 6).toString())) return "image/gif";
  if (data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return "application/octet-stream";
}

const videoBrands = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso8", "iso9", "mp41", "mp42", "avc1", "dash", "msdh", "msix", "M4V ", "M4VH", "M4VP"]);
const nonVideoBrands = new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1", "avif", "avis", "M4A ", "M4B ", "M4P "]);
function ebmlValue(data, at, id = false) {
  const first = data[at];
  if (!first) return null;
  let width = 1, marker = 0x80;
  while (!(first & marker) && width <= 8) { width++; marker >>= 1; }
  if (width > (id ? 4 : 8) || at + width > data.length) return null;
  let value = id ? first : first & (marker - 1);
  for (let i = 1; i < width; i++) value = value * 256 + data[at + i];
  return Number.isSafeInteger(value) ? { value, next: at + width } : null;
}

/** Container signatures, not names or caller-supplied MIME types, select playback. */
export function mediaMime(data) {
  const image = rasterMime(data);
  if (image !== "application/octet-stream") return image;
  if (data.length >= 16 && data.subarray(4, 8).toString() === "ftyp") {
    const length = data.readUInt32BE(0);
    if (length < 16 || length > data.length || length > 4096 || length % 4) return "application/octet-stream";
    const major = data.subarray(8, 12).toString();
    if (nonVideoBrands.has(major)) return "application/octet-stream";
    const brands = [major];
    for (let at = 16; at < length; at += 4) brands.push(data.subarray(at, at + 4).toString());
    if (brands.includes("qt  ")) return "video/quicktime";
    if (brands.some(brand => videoBrands.has(brand))) return "video/mp4";
  }
  if (data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    const header = ebmlValue(data, 4);
    const end = header && header.next + header.value;
    if (!header || end > data.length || end > 4096) return "application/octet-stream";
    for (let at = header.next; at < end;) {
      const id = ebmlValue(data, at, true);
      const size = id && ebmlValue(data, id.next);
      if (!size || size.next + size.value > end) return "application/octet-stream";
      if (id.value === 0x4282 && data.subarray(size.next, size.next + size.value).toString() === "webm") return "video/webm";
      at = size.next + size.value;
    }
  }
  return "application/octet-stream";
}

function decode(value) {
  if (typeof value !== "string" || !value.length || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw error(400, "Invalid attachment");
  if (value.length > Math.ceil(MAX_VIDEO / 3) * 4) throw error(413, sizeMessage);
  const data = Buffer.from(value, "base64");
  if (data.length > MAX_VIDEO) throw error(413, sizeMessage);
  return data;
}

export function validateUploads(input = [], { imagesOnly = false, mediaOnly = false } = {}) {
  if (!Array.isArray(input) || input.length > 4) throw error(400, "Attach up to 4 files");
  let total = 0;
  return input.map(a => {
    if (!a || typeof a.name !== "string" || !a.name.trim()) throw error(400, "Invalid attachment");
    const data = decode(a.data);
    total += data.length;
    if (total > MAX_UPLOAD_TOTAL) throw error(413, sizeMessage);
    const mime = mediaMime(data);
    if (data.length > uploadLimit(mime)) throw error(413, sizeMessage);
    if (imagesOnly && !mime.startsWith("image/")) throw error(400, "Agent chats accept PNG, JPEG, GIF, and WebP images");
    if (mediaOnly && !/^(image|video)\//.test(mime)) throw error(400, "Agent chats accept images and MP4, MOV, or WebM videos");
    return { name: safeName(a.name), mime, data };
  });
}

// The legacy session-chat endpoint caps each text part at 64K and joins
// text-only parts with a newline. Split only at existing newlines: inserting
// one into a long JSON string, URL, or source line changes the user's input.
export const TEXT_PART_CHARS = 60000;
export function splitText(text, size = TEXT_PART_CHARS) {
  const parts = [];
  let rest = String(text || "");
  while (rest.length > size) {
    // Empty text parts are discarded by Hermes, so do not split at either end.
    const newline = rest.lastIndexOf("\n", Math.min(size, rest.length - 2));
    if (newline <= 0) throw Object.assign(new Error("This agent cannot receive a text line this long without changing it. Use the durable agent bridge."), { status: 413, code: "agent_text_too_long" });
    parts.push(rest.slice(0, newline)); rest = rest.slice(newline + 1);
  }
  if (rest || !parts.length) parts.push(rest);
  return parts;
}

export function hermesInput(text, attachments = [], { durable = false } = {}) {
  // Runs accept the original content without the legacy per-part truncation.
  const textParts = text ? (durable ? [text] : splitText(text)) : [];
  if (!attachments.length) return textParts.length > 1 ? textParts.map(part => ({ type: "text", text: part })) : text;
  // With images Hermes retains the blocks instead of newline-joining them.
  // Keep those separators explicitly (still below its 64K per-part limit).
  const images = attachments.filter(a => a.mime.startsWith("image/"));
  const videos = attachments.filter(a => a.mime.startsWith("video/"));
  const notice = videos.length ? `[Servant shared video attachments: ${videos.map(a => `${JSON.stringify(a.name)} (${a.mime}, ${a.data.length} bytes, SHA-256 ${crypto.createHash("sha256").update(a.data).digest("hex")})`).join("; ")}]. The videos are available to people in this conversation. This Hermes API accepts images and text only, so you have not received the video bytes and cannot inspect or describe their contents. Ask for a description or still frames if needed.` : "";
  return [
    ...textParts.map((part, index) => ({ type: "text", text: part + (!durable && images.length && index < textParts.length - 1 ? "\n" : "") })),
    ...(notice ? [{ type: "text", text: notice }] : []),
    ...images.map(a => ({ type: "image_url", image_url: { url: `data:${a.mime};base64,${Buffer.from(a.data).toString("base64")}` } })),
  ];
}

// Withhold transport markup without retaining an entire inline video payload.
// Discard state consumes chunks once and keeps only a possible closing-tag tail.
export function createMediaDeltaFilter() {
  let pending = "", discard = null;
  return (chunk = "", final = false) => {
    pending += chunk;
    let output = "";
    while (pending) {
      if (discard) {
        const end = discard === "data" ? pending.search(/[\s"'<>]/) : discard === "video" ? pending.toUpperCase().indexOf("</VIDEO>") : pending.indexOf(discard);
        if (end < 0) {
          pending = !final && discard === "video" ? pending.slice(-7) : "";
          break;
        }
        if (discard === "\n") output += "\n";
        const length = discard === "video" ? 8 : discard === "data" ? 0 : 1;
        pending = pending.slice(end + length); discard = null;
        continue;
      }
      if (pending.startsWith("![") || pending.startsWith("[")) {
        const image = pending.startsWith("![");
        const start = pending.indexOf("](");
        if (start < 0) {
          if (pending.length > 4096 && image) { discard = ")"; pending = ""; continue; }
          if (!final && pending.length <= 4096 && (image || !pending.includes("]") || pending.endsWith("]"))) break;
          if (image) { pending = ""; break; }
        } else {
          const url = pending.slice(start + 2);
          if (!image && !final && "DATA:VIDEO/".startsWith(url.toUpperCase())) break;
          if (image || /^data:video\//i.test(url)) { pending = url; discard = ")"; continue; }
        }
      }
      const upper = pending.slice(0, 16).toUpperCase();
      if (upper.startsWith("<VIDEO") && (pending.length === 6 || /[\s>]/.test(pending[6]))) {
        discard = "video"; continue;
      }
      if (upper.startsWith("MEDIA:")) { discard = "\n"; continue; }
      if (upper.startsWith("DATA:IMAGE/") || upper.startsWith("DATA:VIDEO/")) { discard = "data"; continue; }
      if (!final && ["![", "[", "<VIDEO", "MEDIA:", "DATA:IMAGE/", "DATA:VIDEO/"].some(token => token.startsWith(upper))) break;
      output += pending[0]; pending = pending.slice(1);
    }
    if (final) { pending = ""; discard = null; }
    return output;
  };
}

export function mediaCaption(text) {
  return String(text).replace(/!?\[[^\]]*\]\((?:data:(?:image|video)\/[^)]+|file:\/\/[^)]*)\)/gi, "")
    .replace(/!\[[^\]]*\]\(https?:\/\/[^)]*\)/gi, "")
    .replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, "")
    .replace(/(?:^|\n)\s*MEDIA:\s*[^\n]+/gi, "")
    .replace(/\[(?:Image|Video|Media) unavailable\]/g, "")
    .replace(/\s+/g, " ").trim();
}

export function normalizeMediaContent(content, extra = []) {
  const attachments = [];
  const seen = new Set();
  let total = 0;
  const add = (uri, name = "media") => {
    if (typeof uri !== "string" || !/^data:(?:image|video)\/[a-z0-9.+-]+;base64,/i.test(uri)) return false;
    try {
      const data = decode(uri.slice(uri.indexOf(",") + 1));
      const mime = mediaMime(data);
      if (!/^(image|video)\//.test(mime) || data.length > (mime.startsWith("video/") ? MAX_VIDEO : MAX_FILE) || attachments.length >= 20 || total + data.length > MAX_UPLOAD_TOTAL) return false;
      const hash = crypto.createHash("sha256").update(data).digest("hex");
      if (seen.has(hash)) return true;
      seen.add(hash); total += data.length;
      const subtype = mime.split("/")[1];
      const extension = subtype === "jpeg" ? "jpg" : subtype === "quicktime" ? "mov" : subtype;
      attachments.push({ name: safeName(/\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.${extension}`), mime, data });
      return true;
    } catch { return false; }
  };
  const textParts = [];
  const parts = Array.isArray(content) ? content : [content];
  for (const part of parts) {
    if (typeof part === "string") textParts.push(part);
    else if (part && typeof part === "object") {
      if (typeof part.text === "string") textParts.push(part.text);
      else if (typeof part.content === "string") textParts.push(part.content);
      const reference = part.video_url ?? part.image_url;
      const uri = typeof reference === "string" ? reference : reference?.url;
      const source = part.source?.type === "base64" ? `data:${part.source.media_type};base64,${part.source.data}` : undefined;
      if (uri || source || (["input_image", "input_video"].includes(part.type) && part.url)) {
        if (!add(uri || source || part.url, part.name || part.alt || (String(part.type).includes("video") ? "video" : "image"))) textParts.push(String(part.type).includes("video") ? "[Video unavailable]" : "[Image unavailable]");
      }
    }
  }
  let text = textParts.join("\n");
  text = text.replace(/!?\[([^\]]*)\]\((data:(image|video)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+)\)/gi,
    (_, name, uri, kind) => add(uri, name || kind) ? "" : `[${kind.toLowerCase() === "video" ? "Video" : "Image"} unavailable]`);
  text = text.replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, markup => {
    const sources = [...markup.matchAll(/\bsrc\s*=\s*["'](data:video\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+)["']/gi)];
    return sources.some(match => add(match[1], "video")) ? "" : "[Video unavailable]";
  });
  text = text.replace(/data:(image|video)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi,
    (uri, kind) => add(uri, kind) ? "" : `[${kind.toLowerCase() === "video" ? "Video" : "Image"} unavailable]`);
  text = text.replace(/!\[[^\]]*\]\(file:\/\/[^)]*\)/gi, "[Image unavailable]")
    .replace(/(?:^|\n)\s*MEDIA:\s*([^\n]+)/gi, (_, source) => /\.(mp4|mov|webm)\b/i.test(source) ? "\n[Video unavailable]" : "\n[Image unavailable]");
  // Some compatible agents use explicit attachment blocks instead of content parts.
  for (const file of Array.isArray(extra) ? extra : []) {
    if (!file || typeof file !== "object") continue;
    if (typeof file.data === "string") add(`data:${file.mime || "image/png"};base64,${file.data}`, file.name);
    else if (file.url) add(file.url, file.name);
  }
  // The agent's hidden "done" line (see close-marker.mjs) is never shown.
  return { text: splitCloseMarker(text).text.replace(/\n{3,}/g, "\n\n").trim(), attachments };
}

export function mediaPage(items, searchParams) {
  const value = searchParams.get("limit");
  const limit = value === null ? 50 : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw error(400, "Choose a media page size from 1 to 100");
  const after = searchParams.get("after");
  const offset = after ? items.findIndex(item => item.id === after) + 1 : 0;
  if (after && !offset) throw error(400, "That media cursor is no longer available. Refresh the gallery");
  const page = items.slice(offset, offset + limit);
  return { items: page, nextCursor: offset + page.length < items.length ? page.at(-1).id : null };
}
