import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accessOf, accessibleProjects, cleanDate, cleanLogin, cleanOwner, cleanRepo, cleanStage, cleanStages, cleanStatus, createProjectFiles, createProjectStore, expandPath, migrateFolders, needsMigration, newItem, newProject, newRelease, patchCell, projectInstructions, projectPeople, projectSharedWith, projectView, releaseLines, releaseView, removeAccess, resolvePerson, setAccess, slugId } from "./projects.mjs";

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
  assert.match(vibe, /prototyping session/);
  assert.match(vibe, /PREVIEW: https:\/\/taxpayer-services-and-online-accounts\.github\.io\/design-prototypes\/vibe-abc12345\//);
  assert.match(vibe, /- Prototyping chats work only inside their own folder\./);
  assert.doesNotMatch(vibe, /on their behalf/);
  // Prototypes hosted by the server: its own folder, no git, the link from the server.
  const hosted = projectInstructions(prototypes, { chat: { mode: "vibe", vibeFolder: "proto-aaaa", hosted: "server" }, asker: users.usr_ana, level: null, files, full: true, prototypes: { dir: "/data/prototypes", url: "https://tsoa.example.test/p/proto-aaaa/", kit: "/kit" } });
  assert.match(hosted, /Build only inside \/data\/prototypes\/proto-aaaa\//);
  assert.match(hosted, /\/kit\/components\/starter\.html/);
  assert.match(hosted, /PREVIEW: https:\/\/tsoa\.example\.test\/p\/proto-aaaa\/$/m);
  assert.match(hosted, /nothing to commit, push or publish/);
  assert.doesNotMatch(hosted, /git pull|github\.io|GitHub:/);
  assert.match(projectInstructions(prototypes, { chat: { mode: "vibe", vibeFolder: "proto-aaaa", hosted: "server" }, asker: users.usr_ana, level: null, files, full: true, prototypes: { dir: "/d", url: "", kit: "/k" } }), /no public address/);
  assert.equal(projectInstructions(null, {}), "");
});

test("migration: folders become projects (owner merges, members write), chats and files follow", () => {
  const dir = tmp();
  const store = createProjectStore(path.join(dir, "projects.json"));
  // A file written by hand before the upgrade keeps its projects; folders are added after them.
  store.mutate(data => {
    data.projects.push({ id: "design-prototypes", name: "Design prototypes", path: "~/d", pages: "https://x/", workflow: "main", rules: [], owners: [], access: { merge: [], write: [], read: [] }, files: [] });
    data.projects.push({ id: "expo-irs", name: "The IRS app", path: "~/e", workflow: "pr", rules: [], owners: [], access: { merge: [], write: [], read: [] }, files: [] });
  });
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
      c6: { id: "c6", userId: "usr_ana", project: "expo" },
    },
  };
  assert.equal(needsMigration(state), true);
  assert.equal(migrateFolders(state, store, projectFiles, folderFiles), 2);
  const data = store.read();
  assert.deepEqual(data.projects.map(p => p.id), ["design-prototypes", "expo-irs", "refund-tracker", "refund-tracker-2"]);
  const tracker = data.projects[2];
  assert.deepEqual([tracker.owners, tracker.access, tracker.notes, tracker.files.length], [["usr_ana"], { merge: ["usr_ana"], write: ["usr_josh"], read: [] }, "Plain words.", 1]);
  assert.equal(accessOf(tracker, state.users.usr_josh, state.users, {}).level, "write");
  assert.deepEqual(state.chats.c1, { id: "c1", userId: "usr_ana", projectId: "refund-tracker", projectShared: true });
  assert.deepEqual(state.chats.c2, { id: "c2", userId: "usr_josh", projectId: "refund-tracker" });
  assert.deepEqual(state.chats.c3, { id: "c3", userId: "usr_josh" }, "a folder that no longer exists is simply dropped");
  assert.deepEqual(state.chats.c4, { id: "c4", userId: "usr_ana", projectId: "design-prototypes", mode: "vibe" }, "old hard-coded project ids stay when the file knows them");
  assert.deepEqual(state.chats.c5, { id: "c5", userId: "usr_ana" }, "ids the file doesn't know (mac) go");
  assert.deepEqual(state.chats.c6, { id: "c6", userId: "usr_ana", projectId: "expo-irs" }, "the old 'expo' id maps to expo-irs");
  assert.equal(state.users.usr_ana.folders, undefined);
  assert.equal(fs.readFileSync(projectFiles.pathOf("refund-tracker", { id: "fil_1" }), "utf8"), "spec");
  assert.equal(needsMigration(state), false);
  assert.equal(migrateFolders(state, store, projectFiles, folderFiles), 0, "running again changes nothing");
  assert.equal(store.read().projects.length, 4);
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

test("releases: the example's November 17 drop, cells default to \"to do, nobody yet\", and the file round-trips", () => {
  const file = path.join(tmp(), "projects.json");
  fs.writeFileSync(file, JSON.stringify(example));
  const store = createProjectStore(file);
  const irs = store.byId("expo-irs");
  assert.deepEqual(irs.stages, ["Build", "Design", "Functional/508 QA", "SAT", "Content"]);
  assert.deepEqual(irs.releases.map(r => [r.name, r.date, r.items.map(i => i.title)]), [["November 17", "2026-11-17", ["Trump accounts", "DMAF", "DUT", "Guest mode"]]]);
  const view = projectView(irs, accessOf(irs, users.usr_josh, users, example.people), users.usr_josh, users, example.people);
  assert.deepEqual(view.stages, irs.stages);
  assert.deepEqual(view.releases[0].items[0].stages["SAT"], { status: "todo", owner: null, ownerName: "" });
  // Items keep no cell until someone sets one; the view still shows every stage, and unknown ones are dropped.
  const item = newItem({ title: " Guest mode " });
  assert.equal(item.title, "Guest mode");
  assert.deepEqual(item.stages, {});
  item.stages.Old = { status: "done", owner: "usr_ana" };
  const shown = releaseView({ id: "rel_x", name: "Dec 1", date: "2026-12-01", items: [item] }, irs, users);
  assert.deepEqual(Object.keys(shown.items[0].stages), irs.stages);
  // A cell carries status, owner and an optional note; the view names the owner.
  patchCell(irs, item, "SAT", { status: "blocked", owner: "usr_josh", note: "  Waiting on test accounts " }, users, example.people);
  assert.deepEqual(item.stages.SAT, { status: "blocked", owner: "usr_josh", note: "Waiting on test accounts" });
  patchCell(irs, item, "SAT", { note: "" }, users, example.people);
  assert.equal(item.stages.SAT.note, undefined);
  assert.deepEqual(releaseView({ id: "r", name: "n", date: "2026-12-01", items: [item] }, irs, users).items[0].stages.SAT, { status: "blocked", owner: "usr_josh", ownerName: "Josh Struble" });
  // Saved releases come back as written; releases are listed soonest first whatever order the file has.
  store.mutate(data => { const p = data.projects.find(x => x.id === "expo-irs"); p.releases.unshift(newRelease({ name: "December 15", date: "2026-12-15" }, 5)); p.releases[1].items.push(item); });
  const again = projectView(store.byId("expo-irs"), { level: "merge", canEdit: true, canWrite: true }, users.usr_sahil, users, example.people);
  assert.deepEqual(again.releases.map(r => r.name), ["November 17", "December 15"]);
  assert.equal(again.releases[0].items[4].stages.SAT.ownerName, "Josh Struble");
  // Hand-written files: bad entries are dropped or defaulted, never crash the store.
  fs.writeFileSync(file, JSON.stringify({ projects: [{ id: "p", stages: ["Build", 3, ""], releases: [{ id: "r1", name: "", date: "soon", items: [{ id: "i1" }, "junk"] }, { name: "no id" }, null] }] }));
  const p = store.byId("p");
  assert.deepEqual(p.stages, ["Build"]);
  assert.deepEqual(p.releases, [{ id: "r1", name: "Release", date: "", items: [{ id: "i1", title: "i1", stages: {} }] }]);
});

test("releases: cleaning stages, dates, titles, statuses and owners", () => {
  assert.deepEqual(cleanStages([" Build ", "QA", ""]), ["Build", "QA"]);
  assert.throws(() => cleanStages("Build"), /list of names/);
  assert.throws(() => cleanStages(["Build", "build"]), /different name/);
  assert.throws(() => cleanStages(Array.from({ length: 11 }, (_, i) => `S${i}`)), /10 stages/);
  assert.equal(cleanDate("2026-11-17"), "2026-11-17");
  for (const bad of ["11/17/2026", "2026-13-01", "2026-02-30", "2026-11-17T00:00", 20261117, ""]) assert.throws(() => cleanDate(bad), /2026-11-17/, String(bad));
  assert.throws(() => newRelease({ name: " ", date: "2026-11-17" }), /Name the release/);
  assert.throws(() => newRelease({ name: "Nov", date: "next week" }), /Dates look like/);
  assert.throws(() => newItem({ title: "" }), /Give the item a name/);
  assert.throws(() => cleanStatus("waiting"), /todo, doing, done or blocked/);
  const project = { ...newProject({ name: "P", stages: ["Build", "SAT"] }, "usr_sahil", new Set()), access: { merge: ["usr_sahil"], write: ["usr_josh"], read: [] } };
  assert.equal(cleanStage(project, "SAT"), "SAT");
  assert.throws(() => cleanStage(project, "QA"), /one of this project's stages/);
  assert.equal(cleanOwner(project, null, users, {}), null);
  assert.equal(cleanOwner(project, "usr_josh", users, {}), "usr_josh");
  assert.throws(() => cleanOwner(project, "usr_ana", users, {}), /isn't in this project/, "not in the project");
  assert.throws(() => cleanOwner(project, "usr_gone", users, {}), /isn't in this project/, "removed");
  assert.throws(() => cleanOwner(project, "usr_nobody", users, {}), /isn't in this project/);
  const item = newItem({ title: "DUT" });
  assert.throws(() => patchCell(project, item, "SAT", { note: 7 }, users, {}), /note is text/);
  assert.throws(() => patchCell(project, item, "SAT", { status: "later" }, users, {}), /todo, doing/);
  assert.deepEqual(item.stages.SAT, { status: "todo", owner: null }, "nothing changes when the change is bad");
});

test("what the agent is told about releases: the next drops, each item's open stages and their owners", () => {
  const file = path.join(tmp(), "projects.json");
  fs.writeFileSync(file, JSON.stringify(example));
  const irs = createProjectStore(file).byId("expo-irs");
  const [trump, dmaf, dut, guest] = irs.releases[0].items;
  patchCell(irs, trump, "SAT", { status: "blocked", owner: "usr_josh", note: "Waiting on test accounts" }, users, example.people);
  patchCell(irs, trump, "Build", { status: "done", owner: "usr_sahil" }, users, example.people);
  patchCell(irs, trump, "Design", { status: "doing", owner: "usr_sahil" }, users, example.people);
  for (const s of irs.stages) patchCell(irs, dmaf, s, { status: "done", owner: "usr_josh" }, users, example.people);
  const lines = releaseLines(irs, users, "2026-11-04");
  assert.match(lines, /^Upcoming releases \(today is 2026-11-04\), with what isn't done yet and who owns it:\n- November 17 \(2026-11-17\): /);
  assert.match(lines, /Trump accounts: Design doing \(Sahil Lavingia\), Functional\/508 QA to do \(nobody yet\), SAT blocked \(Josh Struble: Waiting on test accounts\), Content to do \(nobody yet\); DMAF: all done; DUT: Build to do/);
  assert.doesNotMatch(lines, /Build done/, "finished stages are left out");
  // Past releases are left out; with nothing coming up there is no block at all. A project without stages says so.
  assert.equal(releaseLines(irs, users, "2026-11-18"), "");
  irs.releases.push(newRelease({ name: "Spring", date: "2027-03-01" }));
  assert.match(releaseLines(irs, users, "2026-11-18"), /^Upcoming releases.*\n- Spring \(2027-03-01\): no items yet$/);
  assert.match(releaseLines({ ...irs, stages: [] }, users, "2026-11-04"), /Trump accounts: no stages; DMAF: no stages/);
  // It sits in every project chat's instructions, after the access line and before the notes; vibe chats skip it.
  const tell = asker => projectInstructions(irs, { chat: {}, asker, level: "write", files, full: true, users, today: "2026-11-04" });
  const sys = tell(users.usr_josh);
  assert.ok(sys.indexOf("can write but not merge") < sys.indexOf("Upcoming releases"), "after the access line");
  assert.match(sys, /SAT blocked \(Josh Struble: Waiting on test accounts\)/);
  assert.doesNotMatch(projectInstructions({ ...irs, pages: "https://example.test/" }, { chat: { mode: "vibe", vibeFolder: "vibe-1" }, asker: users.usr_josh, level: null, files, full: true, users, today: "2026-11-04" }), /Upcoming releases/);
  void [dut, guest];
});
