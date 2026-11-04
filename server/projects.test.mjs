import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accessOf, accessibleProjects, cleanLogin, cleanRepo, createProjectFiles, createProjectStore, expandPath, migrateFolders, needsMigration, newProject, projectInstructions, projectPeople, projectSharedWith, projectView, removeAccess, resolvePerson, setAccess, slugId } from "./projects.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "servant-projects-"));
const users = {
  usr_sahil: { id: "usr_sahil", name: "Sahil Lavingia", role: "owner" },
  usr_josh: { id: "usr_josh", name: "Josh Struble", role: "member" },
  usr_ana: { id: "usr_ana", name: "Ana Ruiz", role: "member" },
  usr_gone: { id: "usr_gone", name: "Gone Person", role: "member", removedAt: 1 },
};
const example = JSON.parse(fs.readFileSync(new URL("../docs/projects.example.json", import.meta.url), "utf8"));
const files = { pathOf: (pid, f) => `/files/${pid}/${f.id}`, read: () => Buffer.from("inline text") };

test("projects.json: missing means no projects; saves are re-read, and so are edits by hand", () => {
  const file = path.join(tmp(), "projects.json");
  const store = createProjectStore(file);
  assert.deepEqual(store.read(), { people: {}, projects: [] });
  const id = store.mutate(data => { const p = newProject({ name: "Refund tracker", notes: "Plain words." }, "usr_ana", new Set()); data.projects.push(p); return p.id; });
  assert.equal(id, "refund-tracker");
  assert.equal(store.byId(id).owners[0], "usr_ana");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).projects[0].access, { merge: ["usr_ana"], write: [], read: [] });
  // Edited on disk (a different size, so the stamp changes): picked up without a restart.
  fs.writeFileSync(file, JSON.stringify({ people: { ana: "Ana Ruiz" }, projects: [{ id: "x", name: "By hand", access: { read: ["ana"] } }, { id: "Bad Id!" }] }));
  assert.deepEqual(store.read().projects.map(p => p.id), ["x"], "entries with bad ids are skipped");
  assert.deepEqual(store.byId("x").access, { read: ["ana"], write: [], merge: [] });
  assert.equal(store.byId("x").workflow, "main");
  // A broken file keeps the last good copy instead of dropping every project.
  fs.writeFileSync(file, "{ not json");
  assert.equal(store.byId("x").name, "By hand");
  // Nothing is saved when the change throws.
  assert.throws(() => store.mutate(() => { throw new Error("no"); }), /no/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
  const configured = createProjectStore(path.join(tmp(), "nested", "team.json"));
  configured.mutate(data => data.projects.push(newProject({ name: "Nested" }, "usr_ana", new Set())));
  assert.ok(fs.existsSync(configured.file));
});

test("the example file: three projects, GitHub logins mapped to people, unmapped ones shown as logins", () => {
  const file = path.join(tmp(), "projects.json");
  fs.writeFileSync(file, JSON.stringify(example));
  const data = createProjectStore(file).read();
  assert.deepEqual(data.projects.map(p => [p.id, p.workflow]), [["servant", "main"], ["design-prototypes", "main"], ["expo-irs", "pr"]]);
  const irs = data.projects[2];
  const people = projectPeople(irs, users, data.people);
  assert.deepEqual(people.find(p => p.id === "usr_sahil"), { key: "slavingia", id: "usr_sahil", name: "Sahil Lavingia", github: "slavingia", level: "merge", owner: true });
  assert.deepEqual(people.find(p => p.id === "usr_josh"), { key: "JoshStruble", id: "usr_josh", name: "Josh Struble", github: "JoshStruble", level: "merge", owner: false });
  assert.deepEqual(people.find(p => p.key === "Hai-RS"), { key: "Hai-RS", name: "Hai-RS", github: "Hai-RS", level: "read", owner: false });
  assert.equal(people.length, 18);
  assert.equal(people[0].level, "merge", "sorted by level, merge first");
  // Ana isn't in the IRS app project, so she doesn't see it; Sahil (admin) and Josh do.
  assert.deepEqual(accessibleProjects(data, users.usr_ana, users).map(x => x.project.id), []);
  assert.deepEqual(accessibleProjects(data, users.usr_josh, users).map(x => x.project.id), ["design-prototypes", "expo-irs"]);
  assert.equal(accessibleProjects(data, users.usr_sahil, users).length, 3);
  // Names resolve case-insensitively; removed people don't resolve.
  assert.equal(resolvePerson("josh struble", users, {}).id, "usr_josh");
  assert.equal(resolvePerson("Gone Person", users, {}).id, undefined);
  assert.equal(resolvePerson("joshstruble", users, data.people).id, "usr_josh", "login case doesn't matter either");
});

test("access: merge includes write includes read; owners can edit and merge; admins edit everything", () => {
  const project = { ...newProject({ name: "P" }, "usr_josh", new Set()), access: { merge: [], write: [], read: ["usr_ana"] } };
  const anyone = { id: "usr_x", name: "X", role: "member" };
  assert.deepEqual(accessOf(project, users.usr_josh, users, {}), { level: "merge", owner: true, canEdit: true, canWrite: true, visible: true });
  assert.deepEqual(accessOf(project, users.usr_ana, users, {}), { level: "read", owner: false, canEdit: false, canWrite: false, visible: true });
  assert.deepEqual(accessOf(project, anyone, users, {}), { level: null, owner: false, canEdit: false, canWrite: false, visible: false });
  assert.deepEqual(accessOf(project, users.usr_sahil, users, {}), { level: null, owner: false, canEdit: true, canWrite: true, visible: true }, "admin: can edit, but no repo access of their own");
  setAccess(project, "usr_ana", "write");
  assert.deepEqual(project.access, { merge: [], write: ["usr_ana"], read: [] });
  assert.equal(accessOf(project, users.usr_ana, users, {}).canWrite, true);
  setAccess(project, "usr_ana", "merge", true);
  assert.deepEqual(project.owners, ["usr_josh", "usr_ana"]);
  setAccess(project, "usr_ana", "read", false);
  assert.deepEqual([project.owners, project.access.read], [["usr_josh"], ["usr_ana"]]);
  // Listed twice (by login and by id): the higher level wins, and removing takes every key away.
  const people = { anagh: "Ana Ruiz" };
  project.access.merge.push("anagh");
  assert.equal(accessOf(project, users.usr_ana, users, people).level, "merge");
  assert.equal(projectPeople(project, users, people).filter(p => p.id === "usr_ana").length, 1);
  removeAccess(project, "usr_ana", users, people);
  assert.equal(accessOf(project, users.usr_ana, users, people).visible, false);
  assert.deepEqual(project.access, { merge: [], write: [], read: [] });
  // Shared chats open to everyone in the project, nobody else.
  const data = { people: {}, projects: [project] };
  const chat = { projectId: "p", projectShared: true };
  assert.equal(projectSharedWith(data, users, chat, users.usr_josh), true);
  assert.equal(projectSharedWith(data, users, chat, anyone), false);
  assert.equal(projectSharedWith(data, users, { projectId: "p" }, users.usr_josh), false);
  const view = projectView(project, accessOf(project, users.usr_josh, users, {}), users.usr_josh, users, {}, [{ projectId: "p", userId: "usr_josh" }, { projectId: "p", userId: "usr_ana", projectShared: true }]);
  assert.deepEqual([view.chatCount, view.sharedCount, view.role, view.owner, view.access, view.canEdit], [1, 1, "owner", { id: "usr_josh", name: "Josh Struble" }, "merge", true]);
});

test("what the agent is told: the workflow in plain words, the rules, and what the asker may do", () => {
  const data = createProjectStore((() => { const f = path.join(tmp(), "p.json"); fs.writeFileSync(f, JSON.stringify(example)); return f; })()).read();
  const [servant, prototypes, irs] = data.projects;
  const tell = (project, asker, extra = {}) => projectInstructions(project, { chat: { mode: undefined }, asker, level: accessOf(project, asker, users, data.people).level, files, full: true, ...extra });
  const main = tell(servant, users.usr_sahil);
  assert.match(main, /project "Servant" \(The team chat app/);
  assert.match(main, new RegExp(`Work in ${expandPath("~/servant").replace(/\//g, "\\/")} \\(GitHub: slavingia\\/servant\\)`));
  assert.match(main, /How we work: push to main, no PRs\. Commit directly to main and push\. Don't create feature branches or open pull requests\./);
  assert.match(main, /Rules for this project.*\n- Iterate on main with small follow-up commits/);
  assert.match(main, /Sahil Lavingia can merge: push and merge for them/);
  const pr = tell(irs, users.usr_josh);
  assert.match(pr, /How we work: open a PR, merge after checks\. Work on a branch and open a pull request; merge it only after the checks pass/);
  assert.doesNotMatch(pr, /push to main/);
  assert.match(pr, /- Say "the IRS app", never "IRS2Go"\./);
  // Each access level reads differently; someone not in the project gets the strictest line.
  assert.match(tell(irs, { id: "usr_ana", name: "Ana Ruiz" }), /Ana Ruiz has no access to this project's repository: don't push, merge or change it on their behalf/);
  assert.match(tell(irs, { id: "usr_hai", name: "Hai" }, { level: "read" }), /Hai can read only: don't push or merge on their behalf; propose changes or open a PR for someone with write\./);
  assert.match(tell(irs, { id: "usr_x", name: "Mo" }, { level: "write" }), /Mo can write but not merge: push following the workflow above, but never merge on their behalf/);
  // Notes and files come after the rules; a project without a repo has no workflow or access lines.
  const plain = { ...newProject({ name: "Refunds", notes: "Audience: taxpayers." }, "usr_ana", new Set()), files: [{ id: "fil_1", name: "brief.md", size: 11 }] };
  const notesOnly = tell(plain, users.usr_ana);
  assert.match(notesOnly, /project "Refunds"\. Everyone's chats/);
  assert.doesNotMatch(notesOnly, /How we work|can merge|can read/);
  assert.match(notesOnly, /Project notes from the team:\nAudience: taxpayers\./);
  assert.match(notesOnly, /"brief\.md" \(11 bytes\): \/files\/refunds\/fil_1/);
  assert.match(tell(plain, users.usr_ana, { full: false }), /File "brief\.md":\ninline text/, "restricted agents get small text files inline, never paths");
  // Vibe coding: the prototype folder, the preview line, the project's rules, but no access line.
  const vibe = projectInstructions(prototypes, { chat: { mode: "vibe", vibeFolder: "vibe-abc12345" }, asker: users.usr_ana, level: null, files, full: true });
  assert.match(vibe, /vibe-coding session/);
  assert.match(vibe, /PREVIEW: https:\/\/taxpayer-services-and-online-accounts\.github\.io\/design-prototypes\/vibe-abc12345\//);
  assert.match(vibe, /- Vibe-coding chats work only inside their own folder\./);
  assert.doesNotMatch(vibe, /on their behalf/);
  assert.equal(projectInstructions(null, {}), "");
});

test("migration: folders become projects (owner merges, members write), chats and files follow", () => {
  const dir = tmp();
  const store = createProjectStore(path.join(dir, "projects.json"));
  // A file written by hand before the upgrade keeps its projects; folders are added after them.
  store.mutate(data => { data.projects.push({ id: "design-prototypes", name: "Design prototypes", path: "~/d", pages: "https://x/", workflow: "main", rules: [], owners: [], access: { merge: [], write: [], read: [] }, files: [] }); });
  const projectFiles = createProjectFiles(path.join(dir, "project-files"));
  const folderFiles = path.join(dir, "folder-files");
  fs.mkdirSync(path.join(folderFiles, "fld_aaaaaaaaaaaa"), { recursive: true });
  fs.writeFileSync(path.join(folderFiles, "fld_aaaaaaaaaaaa", "fil_1"), "spec");
  const state = {
    users: {
      usr_ana: { id: "usr_ana", name: "Ana Ruiz", folders: {
        fld_aaaaaaaaaaaa: { id: "fld_aaaaaaaaaaaa", name: "Refund tracker", notes: "Plain words.", members: ["usr_josh"], files: [{ id: "fil_1", name: "spec.md", size: 4 }], createdAt: 1, updatedAt: 2 },
        fld_bbbbbbbbbbbb: { id: "fld_bbbbbbbbbbbb", name: "Refund tracker", notes: "", files: [], createdAt: 3, updatedAt: 3 } } },
      usr_josh: { id: "usr_josh", name: "Josh Struble" },
    },
    chats: {
      c1: { id: "c1", userId: "usr_ana", folderId: "fld_aaaaaaaaaaaa", folderShared: true },
      c2: { id: "c2", userId: "usr_josh", folderId: "fld_aaaaaaaaaaaa" },
      c3: { id: "c3", userId: "usr_josh", folderId: "fld_gone" },
      c4: { id: "c4", userId: "usr_ana", project: "design-prototypes", mode: "vibe" },
      c5: { id: "c5", userId: "usr_ana", project: "mac" },
    },
  };
  assert.equal(needsMigration(state), true);
  assert.equal(migrateFolders(state, store, projectFiles, folderFiles), 2);
  const data = store.read();
  assert.deepEqual(data.projects.map(p => p.id), ["design-prototypes", "refund-tracker", "refund-tracker-2"]);
  const tracker = data.projects[1];
  assert.deepEqual([tracker.owners, tracker.access, tracker.notes, tracker.files.length], [["usr_ana"], { merge: ["usr_ana"], write: ["usr_josh"], read: [] }, "Plain words.", 1]);
  assert.equal(accessOf(tracker, state.users.usr_josh, state.users, {}).level, "write");
  assert.deepEqual(state.chats.c1, { id: "c1", userId: "usr_ana", projectId: "refund-tracker", projectShared: true });
  assert.deepEqual(state.chats.c2, { id: "c2", userId: "usr_josh", projectId: "refund-tracker" });
  assert.deepEqual(state.chats.c3, { id: "c3", userId: "usr_josh" }, "a folder that no longer exists is simply dropped");
  assert.deepEqual(state.chats.c4, { id: "c4", userId: "usr_ana", projectId: "design-prototypes", mode: "vibe" }, "old hard-coded project ids stay when the file knows them");
  assert.deepEqual(state.chats.c5, { id: "c5", userId: "usr_ana" }, "ids the file doesn't know (mac) go");
  assert.equal(state.users.usr_ana.folders, undefined);
  assert.equal(fs.readFileSync(projectFiles.pathOf("refund-tracker", { id: "fil_1" }), "utf8"), "spec");
  assert.equal(needsMigration(state), false);
  assert.equal(migrateFolders(state, store, projectFiles, folderFiles), 0, "running again changes nothing");
  assert.equal(store.read().projects.length, 3);
});

test("ids and cleaning: readable slugs, repos as owner/name, GitHub usernames", () => {
  assert.equal(slugId("  The IRS app! "), "the-irs-app");
  assert.equal(slugId("Servant", new Set(["servant", "servant-2"])), "servant-3");
  assert.equal(slugId("***"), "project");
  assert.equal(cleanRepo("https://github.com/slavingia/servant.git"), "slavingia/servant");
  assert.throws(() => cleanRepo("not a repo"), /owner\/name/);
  assert.equal(cleanLogin("@JoshStruble"), "JoshStruble");
  assert.throws(() => cleanLogin("-bad"), /GitHub username/);
  assert.throws(() => newProject({ name: " " }, "usr_a", new Set()), /Give the project a name/);
  assert.throws(() => newProject({ name: "P", workflow: "trunk" }, "usr_a", new Set()), /"main" or "pr"/);
  assert.throws(() => newProject({ name: "P", rules: "one" }, "usr_a", new Set()), /list of lines/);
  assert.deepEqual(newProject({ name: "P", rules: [" keep it short ", ""] }, "usr_a", new Set()).rules, ["keep it short"]);
});
