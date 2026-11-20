// Putting a folder of a project on the server so someone outside can open it (docs/access-tokens.md, "A folder from
// a project"). A page the agent built in a project's repository lives only on the computer the project is on; a
// reviewer's link has nothing to open. This copies that one folder into the prototypes directory, where the server
// already serves pages in a sandbox (prototypes.mjs). It is a copy as of now: publishing again replaces it.
//
// What is never copied: anything whose name starts with a dot (.git, .env), node_modules, links (so nothing outside
// the folder comes along), and anything that is not a plain file. The folder itself must lie inside the project.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
export const PUBLISH_LIMITS = { files: 2000, bytes: 200 * 1024 * 1024, file: 25 * 1024 * 1024, depth: 12 };
const SKIP = new Set(["node_modules"]);

/** The folder as the person named it, tidied: forward slashes, no leading or trailing slash. "" is the project's own folder. */
export function cleanFolder(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > 300 || /[\u0000-\u001f]/.test(value)) throw fault(400, "bad_request", "folder is the path of a folder inside the project, such as pages/permit-claim");
  const parts = value.replace(/\\/g, "/").split("/").filter(part => part && part !== ".");
  if (parts.some(part => part === ".." || part.startsWith(".") || SKIP.has(part))) throw fault(400, "bad_request", "That folder can't be published: it is hidden, or it steps outside the project");
  return parts.join("/");
}

/**
 * Where a project's folder really is, links resolved. Refuses a folder that is missing, that is a link leading out of
 * the project, or that has no index.html to open.
 */
export function sourceOf(projectPath, folder) {
  if (!projectPath) throw fault(409, "no_project_folder", "This project has no folder on the server's computer, so there is nothing to publish from it");
  let home;
  try { home = fs.realpathSync(projectPath); } catch { throw fault(409, "no_project_folder", "This project's folder is missing on the server's computer. Ask an owner to check the project's path"); }
  let at;
  try { at = fs.realpathSync(path.join(home, cleanFolder(folder))); } catch { throw fault(404, "not_found", `The project has no folder "${cleanFolder(folder)}". Check the name, including capital letters`); }
  if (at !== home && !at.startsWith(home + path.sep)) throw fault(400, "bad_request", "That folder leads outside the project, so it can't be published");
  if (!fs.statSync(at).isDirectory()) throw fault(400, "bad_request", "That is a file. Name the folder it is in");
  let index = null;
  try { index = fs.lstatSync(path.join(at, "index.html")); } catch { /* reported below */ }
  if (!index?.isFile()) throw fault(409, "no_index", "That folder has no index.html, so there is no page to open. Name the folder that holds the page");
  return at;
}

/**
 * Copy `from` into the folder `name` inside `dir`, replacing what was there in one step so nobody sees half a copy.
 * With `keep`, the copy it replaces is moved aside (`.removed`, never served) and not deleted.
 * Resolves to { files, bytes, skipped } where skipped counts what was left out on purpose.
 */
export function publishFolder({ from, dir, name, keep = false, limits = PUBLISH_LIMITS, now = Date.now }) {
  fs.mkdirSync(dir, { recursive: true });
  const staging = path.join(dir, `.next-${name}-${crypto.randomBytes(6).toString("hex")}`);
  let files = 0, bytes = 0, skipped = 0;
  const walk = (source, target, depth) => {
    if (depth > limits.depth) throw fault(413, "too_large", "That folder is nested too deep to publish");
    fs.mkdirSync(target, { recursive: true, mode: 0o755 });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIP.has(entry.name)) { skipped++; continue; }
      const here = path.join(source, entry.name), there = path.join(target, entry.name);
      // lstat, not the directory entry alone: a link is left out whatever it points to.
      const stat = fs.lstatSync(here);
      if (stat.isDirectory()) { walk(here, there, depth + 1); continue; }
      if (!stat.isFile()) { skipped++; continue; }
      if (stat.size > limits.file) throw fault(413, "too_large", `${entry.name} is larger than ${Math.round(limits.file / 1048576)} MB, so the folder can't be published. Remove it or make it smaller`);
      files++; bytes += stat.size;
      if (files > limits.files) throw fault(413, "too_large", `That folder has more than ${limits.files} files. Publish the folder that holds just the page`);
      if (bytes > limits.bytes) throw fault(413, "too_large", `That folder is larger than ${Math.round(limits.bytes / 1048576)} MB. Publish the folder that holds just the page`);
      fs.copyFileSync(here, there, fs.constants.COPYFILE_EXCL);
    }
  };
  try {
    walk(from, staging, 0);
    const final = path.join(dir, name);
    if (fs.existsSync(final)) {
      if (keep) {
        const holding = path.join(dir, ".removed", String(now()));
        fs.mkdirSync(holding, { recursive: true, mode: 0o700 });
        fs.renameSync(final, path.join(holding, name));
      } else {
        const old = path.join(dir, `.old-${name}-${crypto.randomBytes(6).toString("hex")}`);
        fs.renameSync(final, old);
        fs.rmSync(old, { recursive: true, force: true });
      }
    }
    fs.renameSync(staging, final);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { files, bytes, skipped };
}
