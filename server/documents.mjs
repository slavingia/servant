// Documents and design files (Figma, Sketch, PSD, PDF, ZIP...) are too big for
// one encrypted request, so the app sends them in chunks. They live on disk
// beside the chat, never in SQLite, and only the full agent is told the path.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { safeName } from "./media.mjs";

export const MAX_DOCUMENT = 100 * 1024 * 1024;
// A multiple of 3, so each chunk's base64 joins cleanly with the next.
export const DOCUMENT_CHUNK = 3 * 1024 * 1024;
export const DOCUMENT_CHUNK_BODY = Math.ceil(DOCUMENT_CHUNK / 3) * 4 + 64 * 1024;
const STALE_MS = 24 * 60 * 60 * 1000;
const MIME = {
  pdf: "application/pdf", zip: "application/zip", fig: "application/x-figma", sketch: "application/x-sketch",
  psd: "application/x-photoshop", ai: "application/postscript", eps: "application/postscript", svg: "image/svg+xml",
  xd: "application/vnd.adobe.xd", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  key: "application/vnd.apple.keynote", pages: "application/vnd.apple.pages",
};
const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
const validId = id => typeof id === "string" && /^upl_[A-Za-z0-9_-]{16}$/.test(id);

/** Never an image/video type: those would be routed to previews or the model. */
export function documentMime(name) {
  const ext = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  return MIME[ext] || "application/octet-stream";
}

// The bytes sit beside meta.json in the upload's folder, so a document with that name (any case: Mac and Windows
// volumes ignore it) would be overwritten by its own metadata. The name people see is meta.name, never this.
const storedName = name => { const safe = name.replace(/^\.+/, "_"); return safe.toLowerCase() === "meta.json" ? `_${safe}` : safe; };

export function createDocumentStore(directory, { keep = () => false } = {}) {
  const chatDir = chatId => path.join(directory, chatId.replace(/[^A-Za-z0-9_-]/g, "_"));
  const uploadDir = (chatId, id) => path.join(chatDir(chatId), id);
  const readMeta = (chatId, id) => {
    if (!validId(id)) return null;
    try { return JSON.parse(fs.readFileSync(path.join(uploadDir(chatId, id), "meta.json"), "utf8")); } catch { return null; }
  };
  const writeMeta = (chatId, meta) => fs.writeFileSync(path.join(uploadDir(chatId, meta.id), "meta.json"), JSON.stringify(meta), { mode: 0o600 });
  const filePath = (chatId, meta) => path.join(uploadDir(chatId, meta.id), meta.filename);

  function sweep(chatId, now) {
    let names = [];
    try { names = fs.readdirSync(chatDir(chatId)); } catch { return; }
    for (const id of names) {
      const meta = readMeta(chatId, id);
      if (meta && !meta.committed && now - meta.createdAt > STALE_MS) fs.rmSync(uploadDir(chatId, id), { recursive: true, force: true });
    }
  }

  return {
    create({ chatId, userId, name, size, now = Date.now() }) {
      const clean = safeName(typeof name === "string" ? name.trim() : "");
      if (!clean || clean === "image") throw fault(400, "attachments", "Name the file before sending it");
      if (!Number.isSafeInteger(size) || size <= 0) throw fault(400, "attachments", "Couldn't read this file");
      if (size > MAX_DOCUMENT) throw fault(413, "attachments", "Choose documents under 100 MB each");
      sweep(chatId, now);
      const id = `upl_${crypto.randomBytes(12).toString("base64url")}`;
      fs.mkdirSync(uploadDir(chatId, id), { recursive: true, mode: 0o700 });
      const meta = { id, userId, name: clean, filename: storedName(clean), size, received: 0, createdAt: now, committed: false };
      fs.writeFileSync(filePath(chatId, meta), "", { mode: 0o600 });
      writeMeta(chatId, meta);
      return { id, chunkBytes: DOCUMENT_CHUNK, received: 0 };
    },
    // Sequential and idempotent: a retried chunk the server already has is a no-op.
    append({ chatId, userId, id, offset, data }) {
      const meta = readMeta(chatId, id);
      if (!meta || meta.userId !== userId) throw fault(404, "not_found", "That upload is gone. Attach the file again");
      if (typeof data !== "string" || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw fault(400, "attachments", "Invalid file data");
      const bytes = Buffer.from(data, "base64");
      if (!Number.isSafeInteger(offset) || offset < 0 || !bytes.length || bytes.length > DOCUMENT_CHUNK) throw fault(400, "attachments", "Invalid file chunk");
      if (offset + bytes.length <= meta.received) return { received: meta.received };
      if (offset !== meta.received) throw fault(409, "upload_offset", `Expected the chunk at ${meta.received}`);
      if (offset + bytes.length > meta.size) throw fault(413, "attachments", "The file is bigger than announced");
      fs.appendFileSync(filePath(chatId, meta), bytes);
      meta.received += bytes.length;
      writeMeta(chatId, meta);
      return { received: meta.received };
    },
    /** Resolves `{ name, upload }` message parts into stored document attachments. */
    resolve({ chatId, userId, parts }) {
      return parts.map(part => {
        const meta = readMeta(chatId, part.upload);
        if (!meta || meta.userId !== userId) throw fault(404, "not_found", "That upload is gone. Attach the file again");
        if (meta.received !== meta.size) throw fault(409, "upload_incomplete", "That file hasn't finished uploading");
        if (!meta.committed) { meta.committed = true; writeMeta(chatId, meta); }
        return { name: meta.name, mime: documentMime(meta.name), data: Buffer.alloc(0), size: meta.size, file: filePath(chatId, meta) };
      });
    },
    read(file, offset, length) {
      const handle = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(length);
        const read = fs.readSync(handle, buffer, 0, length, offset);
        return buffer.subarray(0, read);
      } finally { fs.closeSync(handle); }
    },
    owns: file => typeof file === "string" && path.resolve(file).startsWith(path.resolve(directory) + path.sep),
    // Records preservation: a deleted chat's uploaded documents are moved to `<dir>/.removed/<timestamp>/` instead of being removed.
    deleteChat: chatId => {
      const from = chatDir(chatId);
      if (keep() && fs.existsSync(from)) {
        const holding = path.join(directory, ".removed", String(Date.now()));
        fs.mkdirSync(holding, { recursive: true, mode: 0o700 });
        return void fs.renameSync(from, path.join(holding, path.basename(from)));
      }
      fs.rmSync(from, { recursive: true, force: true });
    },
  };
}

export function documentNotice(documents, { full = false } = {}) {
  if (!documents.length) return "";
  // Restricted agents never receive a local path.
  if (!full) return `[Servant: the person attached ${documents.map(a => `${JSON.stringify(a.name)} (${a.mime}, ${a.size.toLocaleString("en-US")} bytes)`).join("; ")}. You can't open attached files in this chat. Ask for the part you need as text or a screenshot.]`;
  return `[Servant: the person attached ${documents.length === 1 ? "a file" : `${documents.length} files`}: ${documents.map(a => `${JSON.stringify(a.name)} (${a.mime}, ${a.size.toLocaleString("en-US")} bytes) saved at ${a.file}`).join("; ")}. Open ${documents.length === 1 ? "it" : "them"} from disk with your tools when you need the contents (for example unzip, pdftotext, or read_file). Unpack an archive into a new folder next to it (never outside that folder). If it's a prototype or site they want hosted, serve or publish it and reply with the link. Don't paste the path back to the person.]`;
}
