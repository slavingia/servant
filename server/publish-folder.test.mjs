// A folder of a project copied onto the server for review: what comes along, what never does, and what is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanFolder, publishFolder, sourceOf } from "./publish-folder.mjs";

const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "servant-publish-")));
const write = (file, text = "x") => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const tree = dir => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => path.relative(dir, path.join(e.parentPath, e.name))).sort();

test("the folder's name is tidied, and hidden folders or steps out of the project are refused", () => {
  assert.deepEqual([cleanFolder("permit-claim"), cleanFolder("/pages//permit-claim/"), cleanFolder("./pages\\permit-claim"), cleanFolder(""), cleanFolder(undefined)], ["permit-claim", "pages/permit-claim", "pages/permit-claim", "", ""]);
  for (const bad of ["../other", "pages/../../etc", ".git", "pages/.secret", "node_modules/thing", 7, "a\u0000b", "x".repeat(301)]) assert.throws(() => cleanFolder(bad), { code: "bad_request" }, String(bad));
});

test("the source must be a folder inside the project with a page to open", () => {
  const root = scratch(), project = path.join(root, "project"), outside = path.join(root, "outside");
  write(path.join(project, "permit-claim/index.html"), "<h1>Permit claim</h1>");
  write(path.join(project, "notes/readme.md"));
  write(path.join(outside, "index.html"), "<h1>Not the project's</h1>");
  fs.symlinkSync(outside, path.join(project, "linked"));
  assert.equal(sourceOf(project, "permit-claim"), path.join(project, "permit-claim"));
  assert.throws(() => sourceOf(project, "missing"), { status: 404, code: "not_found" });
  assert.throws(() => sourceOf(project, "notes"), { status: 409, code: "no_index" });
  assert.throws(() => sourceOf(project, "permit-claim/index.html"), { status: 400 });
  assert.throws(() => sourceOf(project, "linked"), { status: 400, message: /leads outside the project/ }, "a link out of the project is not a way out");
  assert.throws(() => sourceOf("", "permit-claim"), { status: 409, code: "no_project_folder" });
  assert.throws(() => sourceOf(path.join(root, "gone"), "permit-claim"), { status: 409, code: "no_project_folder" });
  // An index.html that is itself a link is not a page of this folder.
  fs.mkdirSync(path.join(project, "trick"));
  fs.symlinkSync(path.join(outside, "index.html"), path.join(project, "trick/index.html"));
  assert.throws(() => sourceOf(project, "trick"), { code: "no_index" });
  fs.rmSync(root, { recursive: true, force: true });
});

test("plain files come along; dot files, node_modules and links never do", () => {
  const root = scratch(), from = path.join(root, "project/permit-claim"), dir = path.join(root, "prototypes");
  write(path.join(from, "index.html"), "<h1>Permit claim</h1>");
  write(path.join(from, "css/site.css"), "body{}");
  write(path.join(from, "img/logo.svg"), "<svg/>");
  write(path.join(from, ".env"), "SECRET=1");
  write(path.join(from, ".git/config"), "[core]");
  write(path.join(from, "css/.DS_Store"));
  write(path.join(from, "node_modules/pkg/index.js"));
  write(path.join(root, "private.txt"), "not for reviewers");
  fs.symlinkSync(path.join(root, "private.txt"), path.join(from, "linked.txt"));
  fs.symlinkSync(root, path.join(from, "up"));
  const out = publishFolder({ from, dir, name: "proto-0123456789abcdef01" });
  assert.deepEqual(tree(path.join(dir, "proto-0123456789abcdef01")), ["css/site.css", "img/logo.svg", "index.html"]);
  assert.deepEqual([out.files, out.bytes, out.skipped], [3, 21 + 6 + 6, 6]);
  assert.deepEqual(fs.readdirSync(dir), ["proto-0123456789abcdef01"], "nothing half-made is left beside it");
  fs.rmSync(root, { recursive: true, force: true });
});

test("publishing again replaces the copy in one step; with records kept, the old copy is moved aside, not deleted", () => {
  const root = scratch(), from = path.join(root, "permit-claim"), dir = path.join(root, "prototypes"), name = "proto-0123456789abcdef01";
  write(path.join(from, "index.html"), "first");
  write(path.join(from, "old.html"), "going away");
  publishFolder({ from, dir, name });
  fs.rmSync(path.join(from, "old.html"));
  write(path.join(from, "index.html"), "second");
  publishFolder({ from, dir, name });
  assert.deepEqual([tree(path.join(dir, name)), fs.readFileSync(path.join(dir, name, "index.html"), "utf8"), fs.readdirSync(dir)], [["index.html"], "second", [name]]);
  write(path.join(from, "index.html"), "third");
  publishFolder({ from, dir, name, keep: true, now: () => 1700000000000 });
  assert.equal(fs.readFileSync(path.join(dir, name, "index.html"), "utf8"), "third");
  assert.equal(fs.readFileSync(path.join(dir, ".removed/1700000000000", name, "index.html"), "utf8"), "second");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a folder that is too big is refused and what was published before stays as it was", () => {
  const root = scratch(), from = path.join(root, "permit-claim"), dir = path.join(root, "prototypes"), name = "proto-0123456789abcdef01";
  write(path.join(from, "index.html"), "small");
  publishFolder({ from, dir, name });
  for (let i = 0; i < 4; i++) write(path.join(from, `page-${i}.html`), "more");
  assert.throws(() => publishFolder({ from, dir, name, limits: { files: 3, bytes: 1e9, file: 1e9, depth: 12 } }), { status: 413, message: /more than 3 files/ });
  assert.throws(() => publishFolder({ from, dir, name, limits: { files: 100, bytes: 10, file: 1e9, depth: 12 } }), { status: 413, message: /larger than/ });
  assert.throws(() => publishFolder({ from, dir, name, limits: { files: 100, bytes: 1e9, file: 4, depth: 12 } }), { status: 413, message: /index\.html is larger/ });
  write(path.join(from, "a/b/c/deep.html"));
  assert.throws(() => publishFolder({ from, dir, name, limits: { files: 100, bytes: 1e9, file: 1e9, depth: 2 } }), { status: 413, message: /nested too deep/ });
  assert.deepEqual([tree(path.join(dir, name)), fs.readdirSync(dir)], [["index.html"], [name]]);
  fs.rmSync(root, { recursive: true, force: true });
});
