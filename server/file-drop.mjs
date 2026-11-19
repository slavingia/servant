// File drop: the owner drops a file on the app and it lands in one folder on the server's own computer (for example
// the Desktop of the Mac the server runs on). Off unless that folder is set, in SERVANT_FILE_DROP_DIR or `fileDrop.dir`
// in config.json. The bytes come up in chunks through the same store as chat documents (documents.mjs), then the
// finished file is copied into the folder under a name that never replaces one already there.
import fs from "node:fs";
import path from "node:path";
import { createDocumentStore, DOCUMENT_CHUNK_BODY, MAX_DOCUMENT } from "./documents.mjs";
import { safeName } from "./media.mjs";

const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
// The document store keeps uploads per chat; file drops are one folder of their own.
const SCOPE = "drop";
const SAVED_MARK = "saved.json";
const KEEP_SAVED_MS = 24 * 60 * 60 * 1000;

/** The name a dropped file gets in the folder: no folders in it, never hidden, never empty. */
export function dropName(name) {
  const clean = safeName(typeof name === "string" ? name.trim() : "").replace(/:/g, "_").replace(/^\.+/, "_");
  return clean && clean !== "image" ? clean : "";
}

/** "plan.pdf", then "plan 2.pdf", "plan 3.pdf": the way Finder names a second copy. */
export function numberedName(name, n) {
  if (n <= 1) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} ${n}${name.slice(dot)}` : `${name} ${n}`;
}

/**
 * @param {object} o
 * @param {string} o.directory  where unfinished uploads wait, inside the server's data directory
 * @param {() => string} o.folder  the configured folder, or "" when file drop is off
 */
export function createFileDrop({ directory, folder, now = Date.now }) {
  const store = createDocumentStore(directory);
  const uploadDir = id => path.join(directory, SCOPE, id);

  function target() {
    const dir = folder();
    if (!dir) throw fault(404, "file_drop_off", "File drop is off on this server. Set SERVANT_FILE_DROP_DIR to the folder files should land in");
    let stat = null;
    try { stat = fs.statSync(dir); } catch { /* reported below */ }
    if (!stat?.isDirectory()) throw fault(409, "file_drop_folder", "The file drop folder on the server is missing. Check SERVANT_FILE_DROP_DIR, then drop the file again");
    return fs.realpathSync(dir);
  }

  // Copies with COPYFILE_EXCL, so a file that is already in the folder is never replaced, even by a drop racing this one.
  function place(file, name) {
    const dir = target();
    for (let n = 1; n <= 1000; n++) {
      const final = numberedName(name, n);
      const to = path.join(dir, final);
      if (path.dirname(to) !== dir) throw fault(400, "attachments", "Rename the file before dropping it");
      try { fs.copyFileSync(file, to, fs.constants.COPYFILE_EXCL); return final; }
      catch (error) { if (error.code !== "EEXIST") throw fault(409, "file_drop_folder", "The server couldn't save the file to its file drop folder. Check the folder's permissions, then drop the file again"); }
    }
    throw fault(409, "file_drop_folder", "Too many files with this name are in the file drop folder. Rename the file and drop it again");
  }

  // Saved uploads keep a small marker for a day, so a last chunk sent twice gets the same answer and not a second copy.
  function sweep() {
    let ids = [];
    try { ids = fs.readdirSync(path.join(directory, SCOPE)); } catch { return; }
    for (const id of ids) {
      try { if (now() - JSON.parse(fs.readFileSync(path.join(uploadDir(id), SAVED_MARK), "utf8")).at > KEEP_SAVED_MS) fs.rmSync(uploadDir(id), { recursive: true, force: true }); }
      catch { /* not saved yet: the document store sweeps unfinished uploads itself */ }
    }
  }

  function create(user, body) {
    target();
    const name = dropName(body?.name);
    if (!name) throw fault(400, "attachments", "Name the file before dropping it");
    sweep();
    return store.create({ chatId: SCOPE, userId: user.id, name, size: body?.size, now: now() });
  }

  function append(user, id, body) {
    const { received } = store.append({ chatId: SCOPE, userId: user.id, id, offset: body?.offset, data: body?.data });
    const mark = path.join(uploadDir(id), SAVED_MARK);
    try { return { received, saved: JSON.parse(fs.readFileSync(mark, "utf8")).name }; } catch { /* not saved yet */ }
    let done;
    try { [done] = store.resolve({ chatId: SCOPE, userId: user.id, parts: [{ upload: id }] }); }
    catch (error) { if (error.code === "upload_incomplete") return { received }; throw error; }
    const saved = place(done.file, done.name);
    fs.writeFileSync(mark, JSON.stringify({ name: saved, at: now() }), { mode: 0o600 });
    fs.rmSync(done.file, { force: true });
    return { received, saved };
  }

  /** Answers /v1/file-drop routes. Only the owner: the folder is on the owner's own computer. */
  async function handle(req, res, { user, method, parts, send, fail, readBody }) {
    if (parts[1] !== "file-drop") return false;
    if (user.role !== "owner") return fail(res, 403, "forbidden", "Only the owner can drop files onto the server's computer"), true;
    if (method === "GET" && parts.length === 2) return target(), send(res, 200, { enabled: true, maxBytes: MAX_DOCUMENT }), true;
    if (method === "POST" && parts.length === 2) return send(res, 201, create(user, await readBody(req))), true;
    if (method === "POST" && parts.length === 3) return send(res, 200, append(user, parts[2], await readBody(req, DOCUMENT_CHUNK_BODY))), true;
    return fail(res, 404, "not_found", "Not found"), true;
  }

  return { handle, create, append, enabled: () => !!folder() };
}
