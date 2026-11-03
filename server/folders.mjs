// Folders: a person's own groups of agent chats around one product or topic.
// A folder carries shared context (notes plus reference files) that every chat
// in it sees. Metadata lives on the user record; files live on disk.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { safeName } from "./media.mjs";

export const MAX_FOLDERS = 50;
export const MAX_FOLDER_FILES = 25;
export const MAX_FOLDER_FILE = 20 * 1024 * 1024;
export const MAX_NOTES = 8000;
// Text files up to this much are inlined for restricted (member) agents, which never get file paths.
const INLINE_TEXT_TOTAL = 24000;
const TEXT = /\.(txt|md|markdown|csv|json|html?|css|js|ts|tsx|yml|yaml)$/i;

const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
export const validFolderId = id => typeof id === "string" && /^fld_[A-Za-z0-9_-]{12,24}$/.test(id);

export function cleanName(value) {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  if (!name) throw fault(400, "bad_request", "Give the folder a name");
  return name;
}
export function cleanNotes(value) {
  if (typeof value !== "string") throw fault(400, "bad_request", "Notes must be text");
  if (value.length > MAX_NOTES) throw fault(413, "bad_request", `Keep notes under ${MAX_NOTES.toLocaleString("en-US")} characters`);
  return value;
}

export function newFolder(name, notes = "", now = Date.now()) {
  return { id: `fld_${crypto.randomBytes(9).toString("base64url")}`, name: cleanName(name), notes: cleanNotes(notes), files: [], createdAt: now, updatedAt: now };
}

export const MAX_MEMBERS = 30;

/** The folder with this id, wherever it lives (on its owner's record), and who owns it. */
export function locateFolder(users, folderId) {
  for (const owner of Object.values(users || {})) {
    const folder = owner.folders?.[folderId];
    if (folder) return { owner, folder };
  }
  return null;
}
/** What this person may do with a folder: "owner", "member", or null for no access. */
export function folderAccess(users, userId, folderId) {
  if (!validFolderId(folderId)) return null;
  const hit = locateFolder(users, folderId);
  if (!hit) return null;
  if (hit.owner.id === userId) return { ...hit, role: "owner" };
  return (hit.folder.members || []).includes(userId) ? { ...hit, role: "member" } : null;
}
export function accessibleFolders(users, userId) {
  const out = [];
  for (const owner of Object.values(users || {})) {
    for (const folder of Object.values(owner.folders || {})) {
      if (owner.id === userId) out.push({ owner, folder, role: "owner" });
      else if ((folder.members || []).includes(userId)) out.push({ owner, folder, role: "member" });
    }
  }
  return out;
}
/** Can this person read a chat because its author shared it with the folder they are both in? */
export function folderSharedWith(users, chat, viewerId) {
  return !!chat?.folderShared && !!chat.folderId && !!folderAccess(users, viewerId, chat.folderId);
}

export function folderView({ owner, folder, role }, viewerId, chats = [], users = {}) {
  const inFolder = chats.filter(c => c.folderId === folder.id && !c.deletedAt);
  const person = id => ({ id, name: users[id]?.name || "Former member" });
  return { id: folder.id, name: folder.name, notes: folder.notes || "", files: (folder.files || []).map(({ id, name, size }) => ({ id, name, size })),
    role, owner: person(owner.id), members: (folder.members || []).filter(id => users[id]).map(person),
    chatCount: inFolder.filter(c => c.userId === viewerId).length,
    sharedCount: inFolder.filter(c => c.userId !== viewerId && c.folderShared).length,
    createdAt: folder.createdAt, updatedAt: folder.updatedAt };
}

export function createFolderFiles(directory) {
  const dir = folderId => path.join(directory, folderId);
  const fileFor = (folderId, file) => path.join(dir(folderId), file.id);
  return {
    add(folder, name, bytes, now = Date.now()) {
      const clean = safeName(typeof name === "string" ? name.trim() : "");
      if (!clean || clean === "image") throw fault(400, "bad_request", "Name the file before adding it");
      if (!bytes.length) throw fault(400, "bad_request", "That file is empty");
      if (bytes.length > MAX_FOLDER_FILE) throw fault(413, "attachments", "Choose files under 20 MB each");
      if ((folder.files || []).length >= MAX_FOLDER_FILES) throw fault(409, "limit", `A folder holds up to ${MAX_FOLDER_FILES} files`);
      const file = { id: `fil_${crypto.randomBytes(9).toString("base64url")}`, name: clean, size: bytes.length, addedAt: now };
      fs.mkdirSync(dir(folder.id), { recursive: true, mode: 0o700 });
      fs.writeFileSync(fileFor(folder.id, file), bytes, { mode: 0o600 });
      return file;
    },
    remove(folderId, file) { fs.rmSync(fileFor(folderId, file), { force: true }); },
    removeFolder(folderId) { fs.rmSync(dir(folderId), { recursive: true, force: true }); },
    pathOf: fileFor,
    read(folderId, file) { return fs.readFileSync(fileFor(folderId, file)); },
  };
}

/** What the agent is told about a chat's folder, sent with every turn. */
export function folderInstructions(folder, files, { full }) {
  if (!folder) return "";
  const lines = [`This chat belongs to the folder "${folder.name}". The person keeps the chats in this folder together because they are about the same product, so treat the context below as shared background for all of them.${folder.members?.length ? " Several people work in this folder on the same task; the notes and files below are shared by all of them, while each person has their own private chats." : ""}`];
  if (folder.notes?.trim()) lines.push(`Folder notes from the person:\n${folder.notes.trim()}`);
  const list = folder.files || [];
  if (list.length && full) {
    lines.push(`Reference files for this folder (read them when they help):\n${list.map(f => `- ${JSON.stringify(f.name)} (${f.size.toLocaleString("en-US")} bytes): ${files.pathOf(folder.id, f)}`).join("\n")}`);
  } else if (list.length) {
    // Restricted agents never get local paths: share small text files inline, and only name the rest.
    let budget = INLINE_TEXT_TOTAL;
    const parts = [];
    for (const f of list) {
      if (TEXT.test(f.name) && f.size <= budget) {
        try {
          const text = files.read(folder.id, f).toString("utf8");
          budget -= text.length;
          parts.push(`File ${JSON.stringify(f.name)}:\n${text}`);
          continue;
        } catch { /* fall through to name only */ }
      }
      parts.push(`File ${JSON.stringify(f.name)} (${f.size.toLocaleString("en-US")} bytes) exists but you can't open it in this chat.`);
    }
    lines.push(`Reference files for this folder:\n${parts.join("\n\n")}`);
  }
  return lines.join("\n\n");
}
