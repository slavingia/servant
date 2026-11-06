// Projects: a body of work the team shares. A project carries notes and
// reference files every chat in it sees, an optional GitHub repo and the path
// where the agent works on it, rules people and the agent both follow (the
// workflow: straight to main or pull requests, plus free-text rules) and who
// can read, write or merge. A project can also plan releases: dated drops whose
// items move through the project's stages, each stage owned by someone (the
// per-person to-dos). Projects live in projects.json beside the server data
// (docs/projects.md); the repo ships none. Files live on disk.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeName } from "./media.mjs";

export const MAX_PROJECTS = 100;
export const MAX_PROJECT_FILES = 25;
export const MAX_PROJECT_FILE = 20 * 1024 * 1024;
export const MAX_NOTES = 8000;
export const MAX_RULES = 30;
export const MAX_PEOPLE = 100;
export const MAX_STAGES = 10;
export const MAX_RELEASES = 50;
export const MAX_ITEMS = 50;
// What one stage of one release item can be. The words people see are in the app.
export const STATUSES = ["todo", "doing", "done", "blocked"];
const STATUS_WORDS = { todo: "to do", doing: "doing", done: "done", blocked: "blocked" };
// Each level includes the ones before it: merge ⊃ write ⊃ read.
export const LEVELS = ["read", "write", "merge"];
export const WORKFLOWS = ["main", "pr"];
// Vibe-coding chats build prototypes in this project (it needs "path" and "pages").
export const VIBE_PROJECT = "design-prototypes";
// Text files up to this much are inlined for restricted (member) agents, which never get file paths.
const INLINE_TEXT_TOTAL = 24000;
const TEXT = /\.(txt|md|markdown|csv|json|html?|css|js|ts|tsx|yml|yaml)$/i;
const HOME = os.homedir();

const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const newId = prefix => `${prefix}_${crypto.randomBytes(6).toString("base64url")}`;
export const validProjectId = id => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,47}$/.test(id);
export const rank = level => LEVELS.indexOf(level);
const lower = s => String(s).toLowerCase();
const text = (value, max) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

export function cleanName(value) {
  const name = text(value, 60);
  if (!name) throw fault(400, "bad_request", "Give the project a name");
  return name;
}
export function cleanNotes(value) {
  if (typeof value !== "string") throw fault(400, "bad_request", "Notes must be text");
  if (value.length > MAX_NOTES) throw fault(413, "bad_request", `Keep notes under ${MAX_NOTES.toLocaleString("en-US")} characters`);
  return value;
}
export const cleanDescription = value => text(value, 200);
export const cleanPath = value => text(value, 300);
export function cleanRules(value) {
  if (!Array.isArray(value) || value.some(r => typeof r !== "string")) throw fault(400, "bad_request", "Rules must be a list of lines");
  const rules = value.map(r => text(r, 300)).filter(Boolean);
  if (rules.length > MAX_RULES) throw fault(413, "bad_request", `Keep it to ${MAX_RULES} rules`);
  return rules;
}
export function cleanWorkflow(value) {
  if (!WORKFLOWS.includes(value)) throw fault(400, "bad_request", 'Workflow is "main" or "pr"');
  return value;
}
export function cleanRepo(value) {
  const repo = text(value, 100).replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw fault(400, "bad_request", "A repo looks like owner/name");
  return repo;
}
export function cleanUrl(value) {
  const url = text(value, 300);
  if (url && !/^https:\/\/\S+$/.test(url)) throw fault(400, "bad_request", "Links start with https://");
  return url;
}
export function cleanLevel(value) {
  if (!LEVELS.includes(value)) throw fault(400, "bad_request", "Access is read, write or merge");
  return value;
}
export function cleanLogin(value) {
  const login = text(value, 40).replace(/^@/, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login)) throw fault(400, "bad_request", "That isn't a GitHub username");
  return login;
}

export function cleanStages(value) {
  if (!Array.isArray(value) || value.some(s => typeof s !== "string")) throw fault(400, "bad_request", "Stages are a list of names");
  const stages = value.map(s => text(s, 30)).filter(Boolean);
  if (stages.length > MAX_STAGES) throw fault(413, "bad_request", `Keep it to ${MAX_STAGES} stages`);
  if (new Set(stages.map(lower)).size !== stages.length) throw fault(400, "bad_request", "Each stage needs a different name");
  return stages;
}
export function cleanReleaseName(value) {
  const name = text(value, 60);
  if (!name) throw fault(400, "bad_request", "Name the release");
  return name;
}
/** A plain calendar day, YYYY-MM-DD, that exists. */
export function cleanDate(value) {
  const m = typeof value === "string" ? DATE.exec(value) : null;
  if (!m || !new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString().startsWith(value)) throw fault(400, "bad_request", "Dates look like 2026-11-17");
  return value;
}
export function cleanTitle(value) {
  const title = text(value, 80);
  if (!title) throw fault(400, "bad_request", "Give the item a name");
  return title;
}
export function cleanStatus(value) {
  if (!STATUSES.includes(value)) throw fault(400, "bad_request", "Status is todo, doing, done or blocked");
  return value;
}
export function cleanStage(project, value) {
  if (!project.stages.includes(value)) throw fault(400, "bad_request", "That isn't one of this project's stages");
  return value;
}
/** A stage cell's owner is someone who can see the project (admins count), or nobody. */
export function cleanOwner(project, value, users, people) {
  if (value === null) return null;
  const user = typeof value === "string" ? users[value] : null;
  if (!user || user.removedAt || user.revokedAt || !accessOf(project, user, users, people).visible) throw fault(404, "not_found", "That person isn't in this project");
  return user.id;
}

/** A readable id from the name: "Refund tracker" → "refund-tracker", numbered when taken. */
export function slugId(name, taken = new Set()) {
  const base = lower(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export function newProject(body, ownerId, taken, now = Date.now()) {
  const name = cleanName(body.name);
  return { id: slugId(name, taken), name, description: cleanDescription(body.description), notes: cleanNotes(body.notes ?? ""),
    repo: cleanRepo(body.repo), path: cleanPath(body.path), workflow: body.workflow === undefined ? "main" : cleanWorkflow(body.workflow),
    rules: body.rules === undefined ? [] : cleanRules(body.rules), stages: body.stages === undefined ? [] : cleanStages(body.stages), releases: [],
    owners: [ownerId], access: { merge: [ownerId], write: [], read: [] }, files: [], createdAt: now, updatedAt: now };
}

// ---------- the file ----------

const EMPTY = { people: {}, projects: [] };
function normalize(data) {
  const list = Array.isArray(data?.projects) ? data.projects : [];
  return { people: data?.people && typeof data.people === "object" ? data.people : {},
    projects: list.filter(p => p && validProjectId(p.id)).map(p => ({ ...p, name: text(p.name, 60) || p.id, notes: typeof p.notes === "string" ? p.notes : "",
      workflow: WORKFLOWS.includes(p.workflow) ? p.workflow : "main", rules: Array.isArray(p.rules) ? p.rules.filter(r => typeof r === "string") : [],
      owners: Array.isArray(p.owners) ? p.owners.map(String) : [], access: Object.fromEntries(LEVELS.map(l => [l, Array.isArray(p.access?.[l]) ? p.access[l].map(String) : []])),
      files: Array.isArray(p.files) ? p.files : [],
      stages: Array.isArray(p.stages) ? p.stages.filter(s => typeof s === "string").map(s => text(s, 30)).filter(Boolean).slice(0, MAX_STAGES) : [],
      releases: Array.isArray(p.releases) ? p.releases.filter(r => r && typeof r.id === "string").map(r => ({ ...r, name: text(r.name, 60) || "Release", date: typeof r.date === "string" && DATE.test(r.date) ? r.date : "",
        items: Array.isArray(r.items) ? r.items.filter(i => i && typeof i.id === "string").map(i => ({ ...i, title: text(i.title, 80) || i.id, stages: i.stages && typeof i.stages === "object" ? i.stages : {} })) : [] })) : [] })) };
}

/**
 * projects.json: { "people": { "<GitHub login>": "<Servant name or id>" }, "projects": [...] }.
 * Re-read whenever the file changes on disk, so edits by hand need no restart.
 */
export function createProjectStore(file) {
  let cache = null, stamp = "";
  const read = () => {
    let stat = null;
    try { stat = fs.statSync(file); } catch { /* no file: no projects */ }
    const next = stat ? `${stat.mtimeMs}:${stat.size}` : "";
    if (cache && next === stamp) return cache;
    try { cache = normalize(stat ? JSON.parse(fs.readFileSync(file, "utf8")) : EMPTY); stamp = next; }
    catch (e) { console.error(`[servant] ${file}: ${e.message}`); cache ??= normalize(EMPTY); }
    return cache;
  };
  const save = data => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    cache = null;
  };
  return { file, read, byId: id => read().projects.find(p => p.id === id) || null,
    // Nothing is saved when fn throws (validation errors come out of here).
    mutate(fn) { const data = structuredClone(read()); const out = fn(data); save(data); return out; } };
}

// ---------- people and access ----------

/** Who a key in the file is: a Servant user (by id or name, or through the people map from a GitHub login), else just a GitHub login. */
export function resolvePerson(key, users, people = {}) {
  const k = String(key);
  const byName = name => Object.values(users).find(u => !u.removedAt && lower(u.name) === lower(name));
  const direct = users[k] || byName(k);
  if (direct) return { key: k, id: direct.id, name: direct.name };
  const mapped = people[k] ?? Object.entries(people).find(([login]) => lower(login) === lower(k))?.[1];
  const user = mapped ? users[mapped] || byName(mapped) : null;
  return user ? { key: k, id: user.id, name: user.name, github: k } : { key: k, name: k, github: k };
}

/** Everyone in a project with their highest level. Owners can merge. */
export function projectPeople(project, users, people) {
  const seen = new Map();
  const add = (key, level, owner) => {
    const p = resolvePerson(key, users, people);
    const id = p.id || lower(p.key);
    const prev = seen.get(id);
    if (!prev) return seen.set(id, { ...p, level, owner });
    if (rank(level) > rank(prev.level)) prev.level = level;
    prev.owner ||= owner;
    prev.github ||= p.github;
  };
  for (const level of LEVELS) for (const key of project.access[level]) add(key, level, false);
  for (const key of project.owners) add(key, "merge", true);
  return [...seen.values()].sort((a, b) => rank(b.level) - rank(a.level) || a.name.localeCompare(b.name));
}

/** What this person may do in a project. Servant admins (role owner) see and edit every project. */
export function accessOf(project, user, users, people) {
  const me = user ? projectPeople(project, users, people).find(p => p.id === user.id) : null;
  const level = me?.level ?? null;
  const canEdit = !!me?.owner || user?.role === "owner";
  return { level, owner: !!me?.owner, canEdit, canWrite: canEdit || rank(level) >= rank("write"), visible: canEdit || !!level };
}
export function accessibleProjects(data, user, users) {
  return data.projects.map(project => ({ project, access: accessOf(project, user, users, data.people) })).filter(x => x.access.visible);
}
/** Can this person read a chat because its author shared it with a project they are both in? */
export function projectSharedWith(data, users, chat, viewer) {
  if (!chat?.projectShared || !chat.projectId) return false;
  const project = data.projects.find(p => p.id === chat.projectId);
  return !!project && accessOf(project, viewer, users, data.people).visible;
}

/** Give one person (a Servant user id or GitHub login) exactly this level; owner true/false also changes who owns the project. */
export function setAccess(project, key, level, owner) {
  for (const l of LEVELS) project.access[l] = project.access[l].filter(k => k !== key);
  project.access[level].push(key);
  if (owner === true && !project.owners.includes(key)) project.owners.push(key);
  if (owner === false) project.owners = project.owners.filter(k => k !== key);
}
/** Take someone out entirely: every key that refers to them (id, name or mapped GitHub login) goes. */
export function removeAccess(project, target, users, people) {
  const refers = key => key === target || resolvePerson(key, users, people).id === target;
  for (const l of LEVELS) project.access[l] = project.access[l].filter(k => !refers(k));
  project.owners = project.owners.filter(k => !refers(k));
}

export function projectView(project, access, viewer, users, people, chats = []) {
  const inProject = chats.filter(c => c.projectId === project.id && !c.deletedAt);
  const list = projectPeople(project, users, people);
  const owner = list.find(p => p.owner && p.id) || null;
  return { id: project.id, name: project.name, description: project.description || "", notes: project.notes, repo: project.repo || "", path: project.path || "",
    pages: project.pages || "", workflow: project.workflow, rules: project.rules, files: project.files.map(({ id, name, size }) => ({ id, name, size })),
    stages: project.stages, releases: sortedReleases(project).map(r => releaseView(r, project, users)),
    people: list.map(({ key, id, name, github, level, owner: isOwner }) => ({ key, ...(id ? { id } : {}), name, ...(github ? { github } : {}), level, owner: isOwner })),
    access: access.level, canEdit: access.canEdit, canWrite: access.canWrite,
    chatCount: inProject.filter(c => c.userId === viewer.id).length,
    sharedCount: inProject.filter(c => c.userId !== viewer.id && c.projectShared).length,
    // Old app builds (the Folders screen) read these three.
    role: access.canEdit ? "owner" : "member", owner: owner ? { id: owner.id, name: owner.name } : { id: "", name: "Admin" },
    members: list.filter(p => p.id && p.id !== owner?.id).map(p => ({ id: p.id, name: p.name })),
    createdAt: project.createdAt, updatedAt: project.updatedAt };
}

// ---------- files ----------

export function createProjectFiles(directory) {
  const dir = projectId => path.join(directory, projectId);
  const fileFor = (projectId, file) => path.join(dir(projectId), file.id);
  return {
    add(project, name, bytes, now = Date.now()) {
      const clean = safeName(typeof name === "string" ? name.trim() : "");
      if (!clean || clean === "image") throw fault(400, "bad_request", "Name the file before adding it");
      if (!bytes.length) throw fault(400, "bad_request", "That file is empty");
      if (bytes.length > MAX_PROJECT_FILE) throw fault(413, "attachments", "Choose files under 20 MB each");
      if (project.files.length >= MAX_PROJECT_FILES) throw fault(409, "limit", `A project holds up to ${MAX_PROJECT_FILES} files`);
      const file = { id: `fil_${crypto.randomBytes(9).toString("base64url")}`, name: clean, size: bytes.length, addedAt: now };
      fs.mkdirSync(dir(project.id), { recursive: true, mode: 0o700 });
      fs.writeFileSync(fileFor(project.id, file), bytes, { mode: 0o600 });
      return file;
    },
    remove(projectId, file) { fs.rmSync(fileFor(projectId, file), { force: true }); },
    removeProject(projectId) { fs.rmSync(dir(projectId), { recursive: true, force: true }); },
    // Migration: a folder's files directory becomes the project's.
    adopt(from, projectId) { if (fs.existsSync(from) && !fs.existsSync(dir(projectId))) { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.renameSync(from, dir(projectId)); } },
    pathOf: fileFor,
    read(projectId, file) { return fs.readFileSync(fileFor(projectId, file)); },
  };
}

// ---------- releases ----------

const EMPTY_CELL = { status: "todo", owner: null };
export function newRelease(body, now = Date.now()) {
  return { id: newId("rel"), name: cleanReleaseName(body.name), date: cleanDate(body.date), items: [], createdAt: now, updatedAt: now };
}
// Cells appear as stages are set; a missing cell reads as "to do, nobody yet".
export const newItem = body => ({ id: newId("itm"), title: cleanTitle(body.title), stages: {} });
/** Change one stage of one item: any of status, owner (a user id or null) and note. */
export function patchCell(project, item, stage, body, users, people) {
  const cell = item.stages[stage] ??= { ...EMPTY_CELL };
  if (body.status !== undefined) cell.status = cleanStatus(body.status);
  if (body.owner !== undefined) cell.owner = cleanOwner(project, body.owner, users, people);
  if (body.note !== undefined) {
    if (body.note !== null && typeof body.note !== "string") throw fault(400, "bad_request", "A note is text");
    const note = text(body.note ?? "", 200);
    if (note) cell.note = note; else delete cell.note;
  }
  return cell;
}
const cellOf = (item, stage) => item.stages[stage] || EMPTY_CELL;
const sortedReleases = project => [...project.releases].sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
function cellView(cell, users) {
  const owner = cell.owner ? users[cell.owner] : null;
  return { status: STATUSES.includes(cell.status) ? cell.status : "todo", owner: owner ? owner.id : null, ownerName: owner ? owner.name : "", ...(cell.note ? { note: cell.note } : {}) };
}
/** A release as the app sees it: every item has a cell for every one of the project's stages. */
export function releaseView(release, project, users) {
  return { id: release.id, name: release.name, date: release.date,
    items: release.items.map(i => ({ id: i.id, title: i.title, stages: Object.fromEntries(project.stages.map(s => [s, cellView(cellOf(i, s), users)])) })) };
}
/** Today as YYYY-MM-DD where the server runs. */
export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/**
 * The next few releases for the agent: each item's unfinished stages and who owns
 * them, so a chat in the project knows "11/17: Trump accounts, SAT blocked (Josh)".
 */
export function releaseLines(project, users, today = localDate()) {
  const upcoming = sortedReleases(project).filter(r => r.date >= today).slice(0, 5);
  if (!upcoming.length) return "";
  const who = cell => `${cell.owner && users[cell.owner] ? users[cell.owner].name : "nobody yet"}${cell.note ? `: ${cell.note}` : ""}`;
  const item = i => {
    const open = project.stages.filter(s => cellOf(i, s).status !== "done");
    const state = !project.stages.length ? "no stages" : !open.length ? "all done" : open.map(s => `${s} ${STATUS_WORDS[cellOf(i, s).status] || "to do"} (${who(cellOf(i, s))})`).join(", ");
    return `${i.title}: ${state}`;
  };
  return `Upcoming releases (today is ${today}), with what isn't done yet and who owns it:\n${upcoming.map(r => `- ${r.name} (${r.date}): ${r.items.length ? r.items.map(item).join("; ") : "no items yet"}`).join("\n")}`;
}

// ---------- what the agent is told ----------

export const expandPath = p => p ? p.replace(/^~(?=$|\/)/, HOME) : "";
const previewUrl = (project, folder) => `${project.pages.replace(/\/?$/, "/")}${folder}/`;
export const vibePreview = (project, chat) => project?.pages && chat.vibeFolder ? previewUrl(project, chat.vibeFolder) : "";

/** A short folder name for a new vibe-coding prototype. */
export function vibeFolder(chatId) {
  return `vibe-${chatId.replace(/^cht_/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toLowerCase()}`;
}

function vibeLines(project, chat) {
  const folder = chat.vibeFolder;
  return [
    "This chat is a vibe-coding session for someone who isn't a programmer. They describe what they want; you build it.",
    `Work only in the git repository at ${expandPath(project.path)} (GitHub: ${project.repo}), inside the folder ${folder}/. Create it from components/starter.html if it doesn't exist yet. Follow the repository's AGENTS.md, DESIGN.md and components/README.md.`,
    "Each time they ask for something: make the change, keep the folder's README current, run `git pull --rebase` then commit and push to main (only the files in your folder plus regenerated catalog files), then wait for GitHub Pages to publish.",
    `End every reply that changed the prototype with the preview link on its own line, exactly: PREVIEW: ${previewUrl(project, folder)}`,
    "Use plain words. No code, file paths, commands or git terms in your replies unless they ask. Keep replies short: what changed and what they might try next.",
    "Use public information and made-up sample data only. Never touch other folders or other people's prototypes.",
  ];
}
// The two workflows, in the exact words people see in the app and the file.
export const WORKFLOW_TEXT = {
  main: "How we work: push to main, no PRs. Commit directly to main and push. Don't create feature branches or open pull requests.",
  pr: "How we work: open a PR, merge after checks. Work on a branch and open a pull request; merge it only after the checks pass and it has been reviewed.",
};
export function accessText(name, level) {
  if (level === "merge") return `${name} can merge: push and merge for them following the workflow above.`;
  if (level === "write") return `${name} can write but not merge: push following the workflow above, but never merge on their behalf; leave merging to someone who can.`;
  if (level === "read") return `${name} can read only: don't push or merge on their behalf; propose changes or open a PR for someone with write.`;
  return `${name} has no access to this project's repository: don't push, merge or change it on their behalf; propose changes instead.`;
}

/**
 * Instructions sent with every turn of a chat in a project (never saved in the
 * transcript): where the code is, how the team works, the rules, what the
 * person asking may do, the upcoming releases, then the shared notes and files.
 */
export function projectInstructions(project, { chat, asker, level, files, full, users = {}, today }) {
  if (!project) return "";
  const vibe = chat?.mode === "vibe";
  const repo = project.repo || project.path;
  const lines = vibe ? vibeLines(project, chat) : [
    `This chat belongs to the project "${project.name}"${project.description ? ` (${project.description})` : ""}. Everyone's chats in this project share the context below.`
    + (repo ? ` Work in ${expandPath(project.path) || "its checkout"}${project.repo ? ` (GitHub: ${project.repo})` : ""} unless asked otherwise, and follow its AGENTS.md if it has one.` : ""),
  ];
  if (repo) lines.push(WORKFLOW_TEXT[project.workflow]);
  if (project.rules.length) lines.push(`Rules for this project, for you and for the people in it:\n${project.rules.map(r => `- ${r}`).join("\n")}`);
  if (repo && !vibe) lines.push(accessText(asker?.name || "The person asking", level));
  const releases = vibe ? "" : releaseLines(project, users, today);
  if (releases) lines.push(releases);
  if (project.notes.trim()) lines.push(`Project notes from the team:\n${project.notes.trim()}`);
  const list = project.files;
  if (list.length && full) {
    lines.push(`Reference files for this project (read them when they help):\n${list.map(f => `- ${JSON.stringify(f.name)} (${f.size.toLocaleString("en-US")} bytes): ${files.pathOf(project.id, f)}`).join("\n")}`);
  } else if (list.length) {
    // Restricted agents never get local paths: share small text files inline, and only name the rest.
    let budget = INLINE_TEXT_TOTAL;
    const parts = [];
    for (const f of list) {
      if (TEXT.test(f.name) && f.size <= budget) {
        try {
          const content = files.read(project.id, f).toString("utf8");
          budget -= content.length;
          parts.push(`File ${JSON.stringify(f.name)}:\n${content}`);
          continue;
        } catch { /* fall through to name only */ }
      }
      parts.push(`File ${JSON.stringify(f.name)} (${f.size.toLocaleString("en-US")} bytes) exists but you can't open it in this chat.`);
    }
    lines.push(`Reference files for this project:\n${parts.join("\n\n")}`);
  }
  return lines.join("\n\n");
}

// ---------- migration from folders ----------

/**
 * Old per-person folders become projects: the person who made one owns it (and
 * can merge), its members can write. Chats follow (folderId → projectId,
 * folderShared → projectShared) and older chats' hard-coded "project" ids are
 * kept when the file knows them. Returns how many folders were converted.
 */
export function migrateFolders(state, store, files, folderFilesDir) {
  const owners = Object.values(state.users).filter(u => u.folders && Object.keys(u.folders).length);
  const ids = {};
  if (owners.length) {
    store.mutate(data => {
      const taken = new Set(data.projects.map(p => p.id));
      for (const owner of owners) for (const f of Object.values(owner.folders)) {
        const id = slugId(f.name, taken);
        taken.add(id);
        ids[f.id] = id;
        data.projects.push({ id, name: f.name, description: "", notes: f.notes || "", repo: "", path: "", workflow: "main", rules: [], stages: [], releases: [],
          owners: [owner.id], access: { merge: [owner.id], write: [...(f.members || [])], read: [] }, files: f.files || [], createdAt: f.createdAt, updatedAt: f.updatedAt });
      }
    });
    for (const [from, to] of Object.entries(ids)) files.adopt(path.join(folderFilesDir, from), to);
    for (const owner of owners) delete owner.folders;
  }
  for (const c of Object.values(state.chats)) {
    if (c.folderId) {
      if (ids[c.folderId]) { c.projectId = ids[c.folderId]; if (c.folderShared) c.projectShared = true; }
      delete c.folderId; delete c.folderShared;
    }
    if (typeof c.project === "string") {
      if (!c.projectId && store.byId(c.project)) c.projectId = c.project;
      delete c.project;
    }
  }
  return Object.keys(ids).length;
}
/** True when there is anything for migrateFolders to do. */
export const needsMigration = state => Object.values(state.users).some(u => u.folders && Object.keys(u.folders).length)
  || Object.values(state.chats).some(c => c.folderId || typeof c.project === "string");
