import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VIBE_PROJECT, accessOf, accessibleProjects, cleanDate, configureProjects, cleanLogin, cleanOwner, cleanRepo, cleanReviewers, ownsCell, cleanStage, cleanStages, cleanStatus, createProjectFiles, createProjectStore, expandPath, migrateFolders, needsMigration, newItem, newProject, newRelease, patchCell, projectInstructions, projectPeople, projectSharedWith, projectView, releaseLines, releaseView, removeAccess, resolvePerson, setAccess, slugId } from "./projects.mjs";

test("a project made through the API can never take the reserved prototyping id", () => {
  assert.equal(VIBE_PROJECT, "prototypes", "the default when config.json has no prototypesProject");
  assert.equal(slugId("Prototypes"), "prototypes-2");
  assert.equal(slugId("  PROTOTYPES!", new Set(["prototypes"])), "prototypes-2");
  assert.equal(newProject({ name: "Prototypes", path: "~/" }, "usr_ana", new Set()).id, "prototypes-2");
  assert.equal(slugId("Refund tracker"), "refund-tracker", "other names are unaffected");
  // config.json prototypesProject moves the reservation; a bad id falls back to the default.
  try {
    assert.equal(configureProjects({ prototypesProject: "design-kit" }), "design-kit");
    assert.equal(VIBE_PROJECT, "design-kit");
    assert.equal(slugId("Design kit"), "design-kit-2");
    assert.equal(slugId("Prototypes"), "prototypes", "the default id is free once another is configured");
    assert.equal(configureProjects({ prototypesProject: "Not An Id!" }), "prototypes");
  } finally { configureProjects({}); }
  assert.equal(VIBE_PROJECT, "prototypes");
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "servant-projects-"));
const users = {
  usr_pat: { id: "usr_pat", name: "Pat Tester", role: "owner" },
  usr_jo: { id: "usr_jo", name: "Jo Park", role: "member" },
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
  assert.deepEqual(data.projects.map(p => [p.id, p.workflow]), [["servant", "main"], ["prototypes", "main"], ["example-app", "pr"]]);
  const app = data.projects[2];
  const people = projectPeople(app, users, data.people);
  assert.deepEqual(people.find(p => p.id === "usr_pat"), { key: "pat-example", id: "usr_pat", name: "Pat Tester", github: "pat-example", level: "merge", owner: true });
  assert.deepEqual(people.find(p => p.id === "usr_jo"), { key: "jo-park", id: "usr_jo", name: "Jo Park", github: "jo-park", level: "merge", owner: false });
  assert.deepEqual(people.find(p => p.key === "qa-bot"), { key: "qa-bot", name: "qa-bot", github: "qa-bot", level: "read", owner: false });
  assert.equal(people.length, 4);
  assert.equal(people[0].level, "merge", "sorted by level, merge first");
  // Ana isn't in the example app project, so she doesn't see it (only Prototypes); Pat (admin) and Jo do.
  assert.deepEqual(accessibleProjects(data, users.usr_ana, users).map(x => x.project.id), ["prototypes"]);
  assert.deepEqual(accessibleProjects(data, users.usr_jo, users).map(x => x.project.id), ["servant", "prototypes", "example-app"]);
  assert.equal(accessibleProjects(data, users.usr_pat, users).length, 3);
  // A bare display name is not a key (people pick their own names); only user ids and the admin's login map resolve.
  assert.equal(resolvePerson("jo park", users, {}).id, undefined);
  assert.equal(resolvePerson("Gone Person", users, {}).id, undefined);
  assert.equal(resolvePerson("JO-PARK", users, data.people).id, "usr_jo", "login case doesn't matter either");
});

test("access: merge includes write includes read; owners can edit and merge; admins edit everything", () => {
  const project = { ...newProject({ name: "P" }, "usr_jo", new Set()), access: { merge: [], write: [], read: ["usr_ana"] } };
  const anyone = { id: "usr_x", name: "X", role: "member" };
  assert.deepEqual(accessOf(project, users.usr_jo, users, {}), { level: "merge", owner: true, canEdit: true, canWrite: true, visible: true });
  assert.deepEqual(accessOf(project, users.usr_ana, users, {}), { level: "read", owner: false, canEdit: false, canWrite: false, visible: true });
  assert.deepEqual(accessOf(project, anyone, users, {}), { level: null, owner: false, canEdit: false, canWrite: false, visible: false });
  assert.deepEqual(accessOf(project, users.usr_pat, users, {}), { level: null, owner: false, canEdit: true, canWrite: true, visible: true }, "admin: can edit, but no repo access of their own");
  setAccess(project, "usr_ana", "write");
  assert.deepEqual(project.access, { merge: [], write: ["usr_ana"], read: [] });
  assert.equal(accessOf(project, users.usr_ana, users, {}).canWrite, true);
  setAccess(project, "usr_ana", "merge", true);
  assert.deepEqual(project.owners, ["usr_jo", "usr_ana"]);
  setAccess(project, "usr_ana", "read", false);
  assert.deepEqual([project.owners, project.access.read], [["usr_jo"], ["usr_ana"]]);
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
  assert.equal(projectSharedWith(data, users, chat, users.usr_jo), true);
  assert.equal(projectSharedWith(data, users, chat, anyone), false);
  assert.equal(projectSharedWith(data, users, { projectId: "p" }, users.usr_jo), false);
  const view = projectView(project, accessOf(project, users.usr_jo, users, {}), users.usr_jo, users, {}, [{ projectId: "p", userId: "usr_jo" }, { projectId: "p", userId: "usr_ana", projectShared: true }]);
  assert.deepEqual([view.chatCount, view.sharedCount, view.role, view.owner, view.access, view.canEdit], [1, 1, "owner", { id: "usr_jo", name: "Jo Park" }, "merge", true]);
});

test("what the agent is told: the workflow in plain words, the rules, and what the asker may do", () => {
  const data = createProjectStore((() => { const f = path.join(tmp(), "p.json"); fs.writeFileSync(f, JSON.stringify(example)); return f; })()).read();
  const [servant, prototypes, app] = data.projects;
  const tell = (project, asker, extra = {}) => projectInstructions(project, { chat: { mode: undefined }, asker, level: accessOf(project, asker, users, data.people).level, files, full: true, ...extra });
  const main = tell(servant, users.usr_pat);
  assert.match(main, /project "Servant" \(The team chat app/);
  assert.match(main, new RegExp(`Work in ${expandPath("~/servant").replace(/\//g, "\\/")} \\(GitHub: slavingia\\/servant\\)`));
  assert.match(main, /How we work: push to main, no PRs\. Commit directly to main and push\. Don't create feature branches or open pull requests\./);
  assert.match(main, /Rules for this project.*\n- Iterate on main with small follow-up commits/);
  assert.match(main, /Pat Tester can merge: push and merge for them/);
  const pr = tell(app, users.usr_jo);
  assert.match(pr, /How we work: open a PR, merge after checks\. Work on a branch and open a pull request; merge it only after the checks pass/);
  assert.doesNotMatch(pr, /push to main/);
  assert.match(pr, /- Say "the example app", never its old code name\./);
  // Each access level reads differently; someone not in the project gets the strictest line.
  assert.match(tell(app, { id: "usr_ana", name: "Ana Ruiz" }), /Ana Ruiz has no access to this project's repository: don't push, merge or change it on their behalf/);
  assert.match(tell(app, { id: "usr_sam", name: "Sam Lee" }, { level: "read" }), /Sam Lee can read only: don't push or merge on their behalf; propose changes or open a PR for someone with write\./);
  assert.match(tell(app, { id: "usr_x", name: "Mo" }, { level: "write" }), /Mo can write but not merge: push following the workflow above, but never merge on their behalf/);
  // Notes and files come after the rules; a project without a repo has no workflow or access lines.
  const plain = { ...newProject({ name: "Refunds", notes: "Audience: customers." }, "usr_ana", new Set()), files: [{ id: "fil_1", name: "brief.md", size: 11 }] };
  const notesOnly = tell(plain, users.usr_ana);
  assert.match(notesOnly, /project "Refunds"\. Everyone's chats/);
  assert.doesNotMatch(notesOnly, /How we work|can merge|can read/);
  assert.match(notesOnly, /Project notes from the team:\nAudience: customers\./);
  assert.match(notesOnly, /"brief\.md" \(11 bytes\): \/files\/refunds\/fil_1/);
  assert.match(tell(plain, users.usr_ana, { full: false }), /File "brief\.md":\ninline text/, "restricted agents get small text files inline, never paths");
  // Vibe coding: the prototype folder, the preview line, the project's rules, but no access line.
  const vibe = projectInstructions(prototypes, { chat: { mode: "vibe", vibeFolder: "vibe-abc12345" }, asker: users.usr_ana, level: null, files, full: true });
  assert.match(vibe, /prototyping session/);
  assert.match(vibe, /PREVIEW: https:\/\/example-org\.github\.io\/prototypes\/vibe-abc12345\//);
  assert.match(vibe, /- Prototyping chats work only inside their own folder\./);
  assert.doesNotMatch(vibe, /on their behalf/);
  // Prototypes hosted by the server: its own folder, no git, the link from the server.
  const hosted = projectInstructions(prototypes, { chat: { mode: "vibe", vibeFolder: "proto-aaaa", hosted: "server" }, asker: users.usr_ana, level: null, files, full: true, prototypes: { dir: "/data/prototypes", url: "https://team.example.test/p/proto-aaaa/", kit: "/kit" } });
  assert.match(hosted, /Build only inside \/data\/prototypes\/proto-aaaa\//);
  assert.match(hosted, /\/kit\/components\/starter\.html/);
  assert.match(hosted, /PREVIEW: https:\/\/team\.example\.test\/p\/proto-aaaa\/$/m);
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
    data.legacy = { expo: "example-app" };
    data.projects.push({ id: "prototypes", name: "Prototypes", path: "~/d", pages: "https://x/", workflow: "main", rules: [], owners: [], access: { merge: [], write: [], read: [] }, files: [] });
    data.projects.push({ id: "example-app", name: "The example app", path: "~/e", workflow: "pr", rules: [], owners: [], access: { merge: [], write: [], read: [] }, files: [] });
  });
  const projectFiles = createProjectFiles(path.join(dir, "project-files"));
  const folderFiles = path.join(dir, "folder-files");
  fs.mkdirSync(path.join(folderFiles, "fld_aaaaaaaaaaaa"), { recursive: true });
  fs.writeFileSync(path.join(folderFiles, "fld_aaaaaaaaaaaa", "fil_1"), "spec");
  const state = {
    users: {
      usr_ana: { id: "usr_ana", name: "Ana Ruiz", folders: {
        fld_aaaaaaaaaaaa: { id: "fld_aaaaaaaaaaaa", name: "Refund tracker", notes: "Plain words.", members: ["usr_jo"], files: [{ id: "fil_1", name: "spec.md", size: 4 }], createdAt: 1, updatedAt: 2 },
        fld_bbbbbbbbbbbb: { id: "fld_bbbbbbbbbbbb", name: "Refund tracker", notes: "", files: [], createdAt: 3, updatedAt: 3 } } },
      usr_jo: { id: "usr_jo", name: "Jo Park" },
    },
    chats: {
      c1: { id: "c1", userId: "usr_ana", folderId: "fld_aaaaaaaaaaaa", folderShared: true },
      c2: { id: "c2", userId: "usr_jo", folderId: "fld_aaaaaaaaaaaa" },
      c3: { id: "c3", userId: "usr_jo", folderId: "fld_gone" },
      c4: { id: "c4", userId: "usr_ana", project: "prototypes", mode: "vibe" },
      c5: { id: "c5", userId: "usr_ana", project: "mac" },
      c6: { id: "c6", userId: "usr_ana", project: "expo" },
    },
  };
  assert.equal(needsMigration(state), true);
  assert.equal(migrateFolders(state, store, projectFiles, folderFiles), 2);
  const data = store.read();
  assert.deepEqual(data.projects.map(p => p.id), ["prototypes", "example-app", "refund-tracker", "refund-tracker-2"]);
  assert.deepEqual(data.legacy, { expo: "example-app" }, "the legacy map survives the save");
  const tracker = data.projects[2];
  assert.deepEqual([tracker.owners, tracker.access, tracker.notes, tracker.files.length], [["usr_ana"], { merge: ["usr_ana"], write: ["usr_jo"], read: [] }, "Plain words.", 1]);
  assert.equal(accessOf(tracker, state.users.usr_jo, state.users, {}).level, "write");
  assert.deepEqual(state.chats.c1, { id: "c1", userId: "usr_ana", projectId: "refund-tracker", projectShared: true });
  assert.deepEqual(state.chats.c2, { id: "c2", userId: "usr_jo", projectId: "refund-tracker" });
  assert.deepEqual(state.chats.c3, { id: "c3", userId: "usr_jo" }, "a folder that no longer exists is simply dropped");
  assert.deepEqual(state.chats.c4, { id: "c4", userId: "usr_ana", projectId: "prototypes", mode: "vibe" }, "old hard-coded project ids stay when the file knows them");
  assert.deepEqual(state.chats.c5, { id: "c5", userId: "usr_ana" }, "ids the file doesn't know (mac) go");
  assert.deepEqual(state.chats.c6, { id: "c6", userId: "usr_ana", projectId: "example-app" }, "the old 'expo' id maps through projects.json legacy");
  assert.equal(state.users.usr_ana.folders, undefined);
  assert.equal(fs.readFileSync(projectFiles.pathOf("refund-tracker", { id: "fil_1" }), "utf8"), "spec");
  assert.equal(needsMigration(state), false);
  assert.equal(migrateFolders(state, store, projectFiles, folderFiles), 0, "running again changes nothing");
  assert.equal(store.read().projects.length, 4);
});

test("migration without a legacy map: an old chat project id is kept only when a project has exactly that id", () => {
  const dir = tmp();
  const store = createProjectStore(path.join(dir, "projects.json"));
  store.mutate(data => { data.projects.push({ id: "expo", name: "Expo", workflow: "main", rules: [], owners: [], access: { merge: [], write: [], read: [] }, files: [] }); });
  const state = { users: {}, chats: { a: { id: "a", project: "expo" }, b: { id: "b", project: "example-app" }, c: { id: "c", project: "constructor" } } };
  migrateFolders(state, store, createProjectFiles(path.join(dir, "pf")), path.join(dir, "ff"));
  assert.deepEqual(state.chats, { a: { id: "a", projectId: "expo" }, b: { id: "b" }, c: { id: "c" } });
  assert.equal(store.read().legacy, undefined, "no legacy key is written when there was none");
  // A legacy entry is ignored while a project still has the old id.
  store.mutate(data => { data.legacy = { expo: "example-app", bad: "Not An Id!" }; data.projects.push({ id: "example-app", name: "App", owners: [], access: {} }); });
  assert.deepEqual(store.read().legacy, { expo: "example-app" }, "entries pointing at invalid ids are dropped");
  const again = { users: {}, chats: { a: { id: "a", project: "expo" } } };
  migrateFolders(again, store, createProjectFiles(path.join(dir, "pf")), path.join(dir, "ff"));
  assert.deepEqual(again.chats.a, { id: "a", projectId: "expo" });
});

test("ids and cleaning: readable slugs, repos as owner/name, GitHub usernames", () => {
  assert.equal(slugId("  The example app! "), "the-example-app");
  assert.equal(slugId("Servant", new Set(["servant", "servant-2"])), "servant-3");
  assert.equal(slugId("***"), "project");
  assert.equal(cleanRepo("https://github.com/slavingia/servant.git"), "slavingia/servant");
  assert.throws(() => cleanRepo("not a repo"), /owner\/name/);
  assert.equal(cleanLogin("@jo-park"), "jo-park");
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
  const app = store.byId("example-app");
  assert.deepEqual(app.stages, ["Build", "Design", "QA", "Accessibility", "Content"]);
  assert.deepEqual(app.releases.map(r => [r.name, r.date, r.items.map(i => i.title)]), [["November 17", "2026-11-17", ["Guest mode", "Dark mode", "Payments v2", "Accessibility pass"]]]);
  const view = projectView(app, accessOf(app, users.usr_jo, users, example.people), users.usr_jo, users, example.people);
  assert.deepEqual(view.stages, app.stages);
  assert.deepEqual(view.releases[0].items[0].stages["QA"], { status: "todo", owner: null, ownerName: "" });
  // Items keep no cell until someone sets one; the view still shows every stage, and unknown ones are dropped.
  const item = newItem({ title: " Offline mode " });
  assert.equal(item.title, "Offline mode");
  assert.deepEqual(item.stages, {});
  item.stages.Old = { status: "done", owner: "usr_ana" };
  const shown = releaseView({ id: "rel_x", name: "Dec 1", date: "2026-12-01", items: [item] }, app, users);
  assert.deepEqual(Object.keys(shown.items[0].stages), app.stages);
  // A cell carries status, owner and an optional note; the view names the owner.
  patchCell(app, item, "QA", { status: "blocked", owner: "usr_jo", note: "  Waiting on test accounts " }, users, example.people);
  assert.deepEqual(item.stages.QA, { status: "blocked", owner: "usr_jo", note: "Waiting on test accounts" });
  patchCell(app, item, "QA", { note: "" }, users, example.people);
  assert.equal(item.stages.QA.note, undefined);
  assert.deepEqual(releaseView({ id: "r", name: "n", date: "2026-12-01", items: [item] }, app, users).items[0].stages.QA, { status: "blocked", owner: "usr_jo", ownerName: "Jo Park" });
  // Saved releases come back as written; releases are listed soonest first whatever order the file has.
  store.mutate(data => { const p = data.projects.find(x => x.id === "example-app"); p.releases.unshift(newRelease({ name: "December 15", date: "2026-12-15" }, 5)); p.releases[1].items.push(item); });
  const again = projectView(store.byId("example-app"), { level: "merge", canEdit: true, canWrite: true }, users.usr_pat, users, example.people);
  assert.deepEqual(again.releases.map(r => r.name), ["November 17", "December 15"]);
  assert.equal(again.releases[0].items[4].stages.QA.ownerName, "Jo Park");
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
  const project = { ...newProject({ name: "P", stages: ["Build", "QA"] }, "usr_pat", new Set()), access: { merge: ["usr_pat"], write: ["usr_jo"], read: [] } };
  assert.equal(cleanStage(project, "QA"), "QA");
  assert.throws(() => cleanStage(project, "Design"), /one of this project's stages/);
  assert.equal(cleanOwner(project, null, users, {}), null);
  assert.equal(cleanOwner(project, "usr_jo", users, {}), "usr_jo");
  assert.throws(() => cleanOwner(project, "usr_ana", users, {}), /isn't in this project/, "not in the project");
  assert.throws(() => cleanOwner(project, "usr_gone", users, {}), /isn't in this project/, "removed");
  assert.throws(() => cleanOwner(project, "usr_nobody", users, {}), /isn't in this project/);
  const item = newItem({ title: "Payments v2" });
  assert.throws(() => patchCell(project, item, "QA", { note: 7 }, users, {}), /note is text/);
  assert.throws(() => patchCell(project, item, "QA", { status: "later" }, users, {}), /todo, doing/);
  assert.deepEqual(item.stages.QA, { status: "todo", owner: null }, "nothing changes when the change is bad");
});

test("what the agent is told about releases: the next drops, each item's open stages and their owners", () => {
  const file = path.join(tmp(), "projects.json");
  fs.writeFileSync(file, JSON.stringify(example));
  const app = createProjectStore(file).byId("example-app");
  const [guest, dark, payments, a11y] = app.releases[0].items;
  patchCell(app, guest, "QA", { status: "blocked", owner: "usr_jo", note: "Waiting on test accounts" }, users, example.people);
  patchCell(app, guest, "Build", { status: "done", owner: "usr_pat" }, users, example.people);
  patchCell(app, guest, "Design", { status: "doing", owner: "usr_pat" }, users, example.people);
  for (const s of app.stages) patchCell(app, dark, s, { status: "done", owner: "usr_jo" }, users, example.people);
  const lines = releaseLines(app, users, "2026-11-04");
  assert.match(lines, /^Upcoming releases \(today is 2026-11-04\), with what isn't done yet and who owns it:\n- November 17 \(2026-11-17\): /);
  assert.match(lines, /Guest mode: Design doing \(Pat Tester\), QA blocked \(Jo Park: Waiting on test accounts\), Accessibility to do \(nobody yet\), Content to do \(nobody yet\); Dark mode: all done; Payments v2: Build to do/);
  assert.doesNotMatch(lines, /Build done/, "finished stages are left out");
  // Past releases are left out; with nothing coming up there is no block at all. A project without stages says so.
  assert.equal(releaseLines(app, users, "2026-11-18"), "");
  app.releases.push(newRelease({ name: "Spring", date: "2027-03-01" }));
  assert.match(releaseLines(app, users, "2026-11-18"), /^Upcoming releases.*\n- Spring \(2027-03-01\): no items yet$/);
  assert.match(releaseLines({ ...app, stages: [] }, users, "2026-11-04"), /Guest mode: not done; Dark mode: not done/);
  // With no stages a feature is its own tick; parts are listed when open; a fully checked release says it can ship.
  const bare = { ...app, stages: [], releases: [{ ...app.releases[0], items: [{ id: "i", title: "Refunds", stages: {}, parts: [{ id: "p1", title: "Copy", done: true }, { id: "p2", title: "Spanish", done: false }] }] }] };
  assert.match(releaseLines(bare, users, "2026-11-04"), /Refunds: Spanish not done/);
  bare.releases[0].items[0].parts[1].done = true;
  assert.match(releaseLines(bare, users, "2026-11-04"), /\(2026-11-17\), every feature checked, ready to ship: Refunds: all done/);
  // It sits in every project chat's instructions, after the access line and before the notes; vibe chats skip it.
  const tell = asker => projectInstructions(app, { chat: {}, asker, level: "write", files, full: true, users, today: "2026-11-04" });
  const sys = tell(users.usr_jo);
  assert.ok(sys.indexOf("can write but not merge") < sys.indexOf("Upcoming releases"), "after the access line");
  assert.match(sys, /QA blocked \(Jo Park: Waiting on test accounts\)/);
  assert.doesNotMatch(projectInstructions({ ...app, pages: "https://example.test/" }, { chat: { mode: "vibe", vibeFolder: "vibe-1" }, asker: users.usr_jo, level: null, files, full: true, users, today: "2026-11-04" }), /Upcoming releases/);
  void [payments, a11y];
});

test("reviewers: each stage has its people for every feature, and a cell with no owner is theirs", () => {
  // The team's model: Copy, Design, Eng, QA and UT each have named reviewers.
  const roster = { Copy: ["@annie-content"], Design: ["jo-park"], Eng: ["slavingia"], QA: ["sam-qa"], UT: ["pat-tester", "@ana-ruiz", "ana-ruiz"] };
  assert.deepEqual(cleanReviewers(roster), { Copy: ["annie-content"], Design: ["jo-park"], Eng: ["slavingia"], QA: ["sam-qa"], UT: ["pat-tester", "ana-ruiz"] }, "@ dropped, repeats folded");
  assert.deepEqual(cleanReviewers({ QA: [] }), {}, "an empty stage is left out");
  for (const bad of [null, [], "QA", { QA: "sam-qa" }, { QA: [1] }, { QA: ["not a login"] }, JSON.parse('{"__proto__":["x"]}'), { constructor: ["x"] }, { QA: ["a", "b", "c", "d", "e", "f"] }]) assert.throws(() => cleanReviewers(bad), undefined, JSON.stringify(bad));
  const people = { "jo-park": "usr_jo", "pat-example": "Pat Tester" };
  const app = { stages: ["Design", "QA"], reviewers: { Design: ["jo-park"], QA: ["pat-example", "someone-new"] }, releases: [], owners: [], access: { merge: [], write: [], read: [] }, files: [], rules: [], notes: "" };
  const item = { id: "i", title: "Paper notices", stages: { QA: { status: "doing", owner: "usr_ana" } } };
  assert.equal(ownsCell(app, item, "Design", users.usr_jo, users, people), true, "Jo reviews Design, and nobody's assigned");
  assert.equal(ownsCell(app, item, "Design", users.usr_pat, users, people), false);
  assert.equal(ownsCell(app, item, "QA", users.usr_pat, users, people), false, "an assigned owner wins over the stage's reviewers");
  assert.equal(ownsCell(app, item, "QA", users.usr_ana, users, people), true);
  const view = projectView(app, { level: "merge", canEdit: true, canWrite: true }, users.usr_pat, users, people);
  assert.deepEqual(view.reviewers, { Design: [{ key: "jo-park", id: "usr_jo", name: "Jo Park", github: "jo-park" }], QA: [{ key: "pat-example", id: "usr_pat", name: "Pat Tester", github: "pat-example" }, { key: "someone-new", name: "someone-new", github: "someone-new" }] }, "not yet on Servant: shown by username");
  // The agent names the reviewers for an unassigned stage.
  const lines = releaseLines({ ...app, releases: [{ id: "r", name: "November 18", date: "2026-11-18", items: [item] }] }, users, "2026-11-13", people);
  assert.match(lines, /Paper notices: Design to do \(Jo Park\), QA doing \(Ana Ruiz\)/);
  // A file from before reviewers, or a hand edit gone wrong, still loads.
  const file = path.join(tmp(), "projects.json");
  fs.writeFileSync(file, JSON.stringify({ projects: [{ ...app, id: "a", name: "A", reviewers: undefined }, { ...app, id: "b", name: "B", reviewers: { QA: "x", Design: ["jo-park", 3] } }] }));
  const store = createProjectStore(file);
  assert.deepEqual([store.byId("a").reviewers, store.byId("b").reviewers], [{}, { Design: ["jo-park"] }]);
});

test("security: a display name never grants access, and stage names can't pollute Object.prototype", () => {
  const store = createProjectStore((() => { const f = path.join(tmp(), "p.json"); fs.writeFileSync(f, JSON.stringify(example)); return f; })());
  const data = store.read();
  const mallory = { id: "usr_mal", name: "pat-example", role: "member" };
  const all = { ...users, usr_mal: mallory };
  const servant = data.projects.find(p => p.owners.includes("pat-example"));
  // Someone who chose the name "pat-example" is not the GitHub login pat-example, so no access at all.
  const got = accessOf(servant, mallory, all, data.people);
  assert.equal(got.owner, false);
  assert.equal(got.canEdit, false);
  assert.equal(got.level, null);
  assert.equal(got.visible, false);
  // The real mapping through the admin's people map still works, and so does a user id key.
  assert.equal(resolvePerson("pat-example", users, data.people).id, "usr_pat");
  assert.equal(resolvePerson("usr_jo", users, {}).id, "usr_jo");
  assert.equal(resolvePerson("jo park", users, {}).id, undefined, "a name is not a key");
  assert.equal(resolvePerson("__proto__", users, data.people).id, undefined);
  assert.equal(resolvePerson("constructor", users, {}).id, undefined);
  // Stage names that would write through to Object.prototype are refused.
  for (const bad of ["__proto__", "constructor", "prototype", "__PROTO__"]) assert.throws(() => cleanStages([bad]), /isn't allowed/);
  assert.deepEqual(cleanStages(["Build", "QA"]), ["Build", "QA"]);
  // Even a project file that already holds such a stage can't be used to pollute.
  const item = { id: "itm_1", stages: {} };
  assert.throws(() => patchCell({ owners: [], access: { read: [], write: [], merge: [] }, stages: ["__proto__"] }, item, "__proto__", { status: "done" }, users, {}), /stages/);
  assert.equal(({}).status, undefined);
  // "." and ".." can't be the owner or name of a repo (they'd reshape the GitHub API path).
  for (const bad of ["../x", "x/..", "./x", "x/."]) assert.throws(() => cleanRepo(bad), /owner\/name/);
  assert.equal(cleanRepo("slavingia/servant"), "slavingia/servant");
  assert.equal(cleanRepo("a.b/c-d.js"), "a.b/c-d.js");
});

test("with records preservation on, removing a project file or a whole project moves it aside instead of deleting it", () => {
  const dir = tmp();
  const files = createProjectFiles(path.join(dir, "project-files"), { keep: () => true });
  const project = { id: "refunds", files: [] };
  const a = files.add(project, "plan.txt", Buffer.from("the plan"));
  files.add(project, "budget.txt", Buffer.from("the budget"));
  files.remove("refunds", a);
  const held = () => fs.readdirSync(path.join(dir, "project-files", ".removed")).flatMap(d => fs.readdirSync(path.join(dir, "project-files", ".removed", d)));
  assert.equal(held().length, 1, "the removed file is kept");
  const kept = path.join(dir, "project-files", ".removed", fs.readdirSync(path.join(dir, "project-files", ".removed"))[0]);
  assert.equal(fs.readFileSync(path.join(kept, fs.readdirSync(kept)[0]), "utf8"), "the plan", "with its contents");
  files.removeProject("refunds");
  assert.equal(fs.existsSync(path.join(dir, "project-files", "refunds")), false, "the project is gone from where it was served");
  assert.ok(held().length >= 2, "and the rest of it was kept");
  const plain = createProjectFiles(path.join(dir, "plain"));
  const c = plain.add({ id: "p2", files: [] }, "x.txt", Buffer.from("x"));
  plain.remove("p2", c);
  assert.equal(fs.existsSync(path.join(dir, "plain", ".removed")), false, "off: deleted as before, nothing kept");
});
