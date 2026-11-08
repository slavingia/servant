// Version history for prototypes Servant hosts (/p/<folder>/).
//
// After each agent reply in a design workspace, the published files are
// copied to <versions dir>/<folder>/<n>/ when they changed since the last copy.
// Copies are served read-only at /p/<folder>.v<n>/ (same sandbox and headers
// as the live page). Restoring copies a version back over the live files; the
// live files are saved as a version first, so a restore can itself be undone.
//
// Only ordinary files are copied: no dotfiles (the agent's own tooling), no
// symlinks, nothing over the size limits. Nothing here follows a link out of
// the folder.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FOLDER = /^[a-z0-9][a-z0-9-]{2,40}$/; // the same as prototypes.mjs
export const MAX_VERSIONS = 20;
const MAX_FILES = 500;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_DEPTH = 8;
export const VERSION_PATH = /^([a-z0-9][a-z0-9-]{2,40})\.v([1-9]\d{0,5})$/;

// The ordinary files in a folder, sorted, or null when it's over the limits.
function filesIn(root) {
  const out = [];
  let bytes = 0;
  const walk = (dir, rel, depth) => {
    if (depth > MAX_DEPTH) return false;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return true; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const file = path.join(dir, entry.name), name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (walk(file, name, depth + 1) === false) return false; continue; }
      if (!entry.isFile()) continue;
      const size = fs.statSync(file).size;
      bytes += size;
      out.push({ name, file, size });
      if (out.length > MAX_FILES || bytes > MAX_BYTES) return false;
    }
    return true;
  };
  return walk(root, "", 0) === false ? null : out;
}
function digest(files) {
  const hash = crypto.createHash("sha256");
  for (const f of files) hash.update(f.name).update("\0").update(fs.readFileSync(f.file)).update("\0");
  return hash.digest("hex");
}
const manifestFile = (versionsDir, folder) => path.join(versionsDir, folder, "versions.json");
/** The versions kept for a prototype, oldest first: [{ n, at, hash, files, bytes, restoredFrom? }]. */
export function listVersions(versionsDir, folder) {
  if (!FOLDER.test(folder || "")) return [];
  try {
    const list = JSON.parse(fs.readFileSync(manifestFile(versionsDir, folder), "utf8"));
    return Array.isArray(list) ? list.filter(v => Number.isInteger(v?.n) && v.n > 0 && typeof v.hash === "string") : [];
  } catch { return []; }
}
function writeManifest(versionsDir, folder, list) {
  const file = manifestFile(versionsDir, folder);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(list), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
// Copies files under `to`, never through a link: a folder or file in the way that's a symlink stops the copy.
function copyFiles(files, to) {
  for (const f of files) {
    const parts = f.name.split("/");
    let at = to;
    for (const part of parts) {
      at = path.join(at, part);
      try { if (fs.lstatSync(at).isSymbolicLink()) throw new Error(`refusing to copy through a link: ${f.name}`); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.copyFileSync(f.file, at);
  }
}

/**
 * Saves the live files as a new version when they differ from the newest one.
 * Returns the newest version (new or not), or null when there's nothing to keep
 * (no page yet, or over the limits).
 */
// What the author asked for, as a short description of the version (control characters out, at most 140 characters).
const requestNote = text => String(text || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
export function snapshotPrototype({ dir, versionsDir, folder, at = Date.now(), restoredFrom, request }) {
  if (!FOLDER.test(folder || "")) return null;
  const live = path.join(dir, folder);
  try { if (!fs.lstatSync(path.join(live, "index.html")).isFile()) return null; } catch { return null; }
  const files = filesIn(live);
  if (!files?.length) return null;
  const hash = digest(files);
  const list = listVersions(versionsDir, folder);
  const newest = list.at(-1);
  if (newest && newest.hash === hash && restoredFrom === undefined) return newest;
  const n = (newest?.n ?? 0) + 1;
  const home = path.join(versionsDir, folder);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = path.join(home, `${n}.tmp-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  copyFiles(files, tmp);
  fs.rmSync(path.join(home, String(n)), { recursive: true, force: true });
  fs.renameSync(tmp, path.join(home, String(n)));
  const version = { n, at, hash, files: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0), ...(restoredFrom ? { restoredFrom } : {}), ...(requestNote(request) ? { request: requestNote(request) } : {}) };
  const kept = [...list, version];
  for (const old of kept.slice(0, Math.max(0, kept.length - MAX_VERSIONS))) fs.rmSync(path.join(home, String(old.n)), { recursive: true, force: true });
  writeManifest(versionsDir, folder, kept.slice(-MAX_VERSIONS));
  return version;
}

/**
 * Puts a kept version back as the live prototype. The live files are saved
 * first, so the restore shows up as the newest version and can be undone.
 * Dotfiles in the live folder (the agent's own tooling) are left alone.
 */
export function restoreVersion({ dir, versionsDir, folder, n, at = Date.now() }) {
  const version = listVersions(versionsDir, folder).find(v => v.n === n);
  if (!version) return null;
  const source = path.join(versionsDir, folder, String(n));
  const files = filesIn(source);
  if (!files?.length) return null;
  snapshotPrototype({ dir, versionsDir, folder, at });
  const live = path.join(dir, folder);
  fs.mkdirSync(live, { recursive: true });
  for (const entry of fs.readdirSync(live, { withFileTypes: true })) {
    if (!entry.name.startsWith(".")) fs.rmSync(path.join(live, entry.name), { recursive: true, force: true });
  }
  copyFiles(files, live);
  return snapshotPrototype({ dir, versionsDir, folder, at, restoredFrom: n });
}

/**
 * Copies another prototype's live files into a new, empty prototype folder
 * (for Duplicate). Refuses a target that already has a page.
 */
export function copyPrototype({ dir, from, to }) {
  if (!FOLDER.test(from || "") || !FOLDER.test(to || "") || from === to) return false;
  try { if (!fs.lstatSync(path.join(dir, from, "index.html")).isFile()) return false; } catch { return false; }
  // Only into a design with nothing published: no files besides the agent's own dotfiles.
  try { if (fs.readdirSync(path.join(dir, to)).some(name => !name.startsWith("."))) return false; } catch (error) { if (error.code !== "ENOENT") return false; }
  const files = filesIn(path.join(dir, from));
  if (!files?.length) return false;
  try { copyFiles(files, path.join(dir, to)); } catch { return false; }
  return true;
}

/** Where a version's files are, for /p/<folder>.v<n>/…, or null. */
export function versionRoot(versionsDir, segment) {
  const match = String(segment || "").match(VERSION_PATH);
  if (!match) return null;
  const n = Number(match[2]);
  if (!listVersions(versionsDir, match[1]).some(v => v.n === n)) return null;
  return path.join(versionsDir, match[1], String(n));
}

export function removeVersions(versionsDir, folder) {
  if (FOLDER.test(folder || "")) fs.rmSync(path.join(versionsDir, folder), { recursive: true, force: true });
}
