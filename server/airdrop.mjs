// AirDrop: the owner drops a file in the app and it lands on the server computer's
// Desktop (or AIRDROP_DIR). Chunked like chat documents, so it works through the
// encrypted tunnel from any device. The partial file is hidden until the last byte.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DOCUMENT_CHUNK, MAX_DOCUMENT } from "./documents.mjs";

export const MAX_AIRDROP = MAX_DOCUMENT;
const STALE_MS = 24 * 60 * 60 * 1000;
const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
const validId = id => typeof id === "string" && /^air_[A-Za-z0-9_-]{16}$/.test(id);

export const airdropDir = (env = process.env) => env.AIRDROP_DIR ? path.resolve(env.AIRDROP_DIR.replace(/^~(?=$|\/)/, os.homedir())) : path.join(os.homedir(), "Desktop");

/** A plain file name: no folders, no hidden or control characters. */
export function cleanName(value) {
  const base = String(value ?? "").split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f:]/g, "_").trim().replace(/^\.+/, "").slice(0, 180);
  return base || null;
}

/** "a.pdf" → "a (1).pdf", "a (2).pdf"… until nothing in the folder has that name. */
export function freeName(dir, name, exists = p => fs.existsSync(p)) {
  if (!exists(path.join(dir, name))) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; n < 10000; n++) { const next = `${stem} (${n})${ext}`; if (!exists(path.join(dir, next))) return next; }
  throw fault(409, "airdrop", "Too many files with that name");
}

export function createAirdrop({ dataDir, target = () => airdropDir() }) {
  const spool = path.join(dataDir, "airdrop");
  const metaPath = id => path.join(spool, `${id}.json`);
  const partPath = id => path.join(spool, `${id}.part`);
  const readMeta = id => { if (!validId(id)) return null; try { return JSON.parse(fs.readFileSync(metaPath(id), "utf8")); } catch { return null; } };
  const writeMeta = meta => fs.writeFileSync(metaPath(meta.id), JSON.stringify(meta), { mode: 0o600 });
  const drop = id => { fs.rmSync(metaPath(id), { force: true }); fs.rmSync(partPath(id), { force: true }); };
  const sweep = now => {
    let names = []; try { names = fs.readdirSync(spool); } catch { return; }
    for (const n of names) if (n.endsWith(".json")) { const m = readMeta(n.slice(0, -5)); if (m && now - m.createdAt > STALE_MS) drop(m.id); }
  };

  function create({ userId, name, size, now = Date.now() }) {
    const clean = cleanName(name);
    if (!clean) throw fault(400, "airdrop", "Name the file before sending it");
    if (!Number.isSafeInteger(size) || size <= 0) throw fault(400, "airdrop", "Couldn't read this file");
    if (size > MAX_AIRDROP) throw fault(413, "airdrop", "Choose files under 100 MB each");
    fs.mkdirSync(spool, { recursive: true, mode: 0o700 });
    sweep(now);
    const id = `air_${crypto.randomBytes(12).toString("base64url")}`;
    fs.writeFileSync(partPath(id), "", { mode: 0o600 });
    writeMeta({ id, userId, name: clean, size, received: 0, createdAt: now });
    return { id, chunkBytes: DOCUMENT_CHUNK, received: 0 };
  }

  // Sequential and idempotent, like documents.append. The last chunk moves the file into place.
  function append({ userId, id, offset, data }) {
    const meta = readMeta(id);
    if (!meta || meta.userId !== userId) throw fault(404, "not_found", "That upload is gone. Drop the file again");
    if (meta.saved) return { received: meta.size, saved: meta.saved };
    if (typeof data !== "string" || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw fault(400, "airdrop", "Invalid file data");
    const bytes = Buffer.from(data, "base64");
    if (!Number.isSafeInteger(offset) || offset < 0 || !bytes.length || bytes.length > DOCUMENT_CHUNK) throw fault(400, "airdrop", "Invalid file chunk");
    if (offset + bytes.length <= meta.received) return { received: meta.received };
    if (offset !== meta.received) throw fault(409, "upload_offset", `Expected the chunk at ${meta.received}`);
    if (offset + bytes.length > meta.size) throw fault(413, "airdrop", "The file is bigger than announced");
    fs.appendFileSync(partPath(id), bytes);
    meta.received += bytes.length;
    if (meta.received === meta.size) {
      const dir = target();
      fs.mkdirSync(dir, { recursive: true });
      const name = freeName(dir, meta.name);
      const dest = path.join(dir, name);
      try { fs.renameSync(partPath(id), dest); }
      catch (e) { if (e.code !== "EXDEV") throw e; fs.copyFileSync(partPath(id), dest, fs.constants.COPYFILE_EXCL); fs.rmSync(partPath(id), { force: true }); }
      fs.chmodSync(dest, 0o644);
      meta.saved = name;
    }
    writeMeta(meta);
    return meta.saved ? { received: meta.received, saved: meta.saved } : { received: meta.received };
  }

  return {
    create, append,
    folder: () => target(),
    /** POST /v1/airdrop {name,size} and POST /v1/airdrop/<id> {offset,data}. Owner only. */
    async handle(req, res, { user, method, parts, send, fail, readBody, chunkBody }) {
      if (parts[1] !== "airdrop") return false;
      if (user.role !== "owner") return fail(res, 403, "forbidden", "Only the owner can do that"), true;
      if (method === "GET" && parts.length === 2) return send(res, 200, { folder: path.basename(target()) }), true;
      if (method !== "POST") return fail(res, 405, "method_not_allowed", "Not allowed"), true;
      if (parts.length === 2) { const b = (await readBody(req)) || {}; return send(res, 201, create({ userId: user.id, name: b.name, size: b.size })), true; }
      if (parts.length === 3) { const b = (await readBody(req, chunkBody)) || {}; return send(res, 200, append({ userId: user.id, id: parts[2], offset: b.offset, data: b.data })), true; }
      return fail(res, 404, "not_found", "Not found"), true;
    },
  };
}
