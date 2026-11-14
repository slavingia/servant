import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { servePrototype, _resetLimits, _watching } from "./prototypes.mjs";

test("prototype pages reload live: script injected, change event sent, watcher stops when closed", async () => {
  _resetLimits();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-"));
  const folder = "proto-abc123";
  fs.mkdirSync(path.join(dir, folder));
  fs.writeFileSync(path.join(dir, folder, "index.html"), "<html><body>one</body></html>");
  const srv = http.createServer((req, res) => { if (!servePrototype(req, res, new URL(req.url, "http://x"), { dir })) { res.writeHead(404); res.end(); } });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/p/${folder}`;
  try {
    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /data-servant-hmr/);
    assert.equal((page.match(/data-servant-hmr/g) || []).length, 1);
    assert.match(page, /one<\/body>|one<script/);
    const ctrl = new AbortController();
    const res = await fetch(`${base}/__hmr`, { signal: ctrl.signal });
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = res.body.getReader();
    await reader.read(); // retry line
    fs.writeFileSync(path.join(dir, folder, "index.html"), "<html><body>two two</body></html>");
    const got = await Promise.race([reader.read(), new Promise((_, j) => setTimeout(() => j(new Error("no event")), 3000))]);
    assert.match(new TextDecoder().decode(got.value), /"files":\["index.html"\]/);
    assert.equal(_watching(), 1);
    ctrl.abort();
    await new Promise(r => setTimeout(r, 200));
    assert.equal(_watching(), 0);
    assert.equal((await fetch(`http://127.0.0.1:${srv.address().port}/p/../x/__hmr`)).status, 404);
  } finally { srv.closeAllConnections?.(); srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("with records preservation on, a removed prototype is moved aside (its link stops working), not destroyed", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { removePrototype, newFolder } = await import("./prototypes.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-proto-"));
  const kept = newFolder(), plain = newFolder();
  for (const f of [kept, plain]) { fs.mkdirSync(path.join(dir, f), { recursive: true }); fs.writeFileSync(path.join(dir, f, "index.html"), `<h1>${f}</h1>`); }
  removePrototype(dir, kept, { keep: true });
  assert.equal(fs.existsSync(path.join(dir, kept)), false, "no longer served from where it was");
  const held = fs.readdirSync(path.join(dir, ".removed")).flatMap(d => fs.readdirSync(path.join(dir, ".removed", d)));
  assert.deepEqual(held, [kept], "kept aside");
  removePrototype(dir, plain);
  assert.equal(fs.existsSync(path.join(dir, plain)), false);
  assert.equal(fs.readdirSync(path.join(dir, ".removed")).length, 1, "off: deleted as before, nothing more kept");
});

test("edit mode: the editor rides along only with ?edit=1; a save changes the words in the source and adds styles, inside the folder only", async () => {
  _resetLimits();
  const { savePrototypePage } = await import("./prototypes.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-edit-"));
  const folder = "proto-0123456789abcdef01";
  fs.mkdirSync(path.join(dir, folder, "sub"), { recursive: true });
  // Like the agent's prototypes: some words in the markup, some drawn by a script.
  const page = `<!DOCTYPE html><html><head><title>T</title></head><body><h1>Refunds</h1><p>Tax &amp; you</p><script>document.body.insertAdjacentHTML("beforeend", "<h2>Welcome, Jordan</h2><p>Due</p><p>Due</p>")</script></body></html>`;
  fs.writeFileSync(path.join(dir, folder, "index.html"), page);
  fs.writeFileSync(path.join(dir, folder, "sub", "a.html"), "<p>a</p>");
  fs.writeFileSync(path.join(dir, folder, "style.css"), "body{}");
  fs.writeFileSync(path.join(dir, "outside.html"), "keep");
  fs.symlinkSync(path.join(dir, "outside.html"), path.join(dir, folder, "link.html"));
  const srv = http.createServer((req, res) => { if (!servePrototype(req, res, new URL(req.url, "http://x"), { dir })) { res.writeHead(404); res.end(); } });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/p/${folder}/`;
  const read = () => fs.readFileSync(path.join(dir, folder, "index.html"), "utf8");
  try {
    assert.doesNotMatch(await (await fetch(base)).text(), /data-servant-editor/, "plain previews carry no editor");
    const editing = await (await fetch(`${base}?edit=1`)).text();
    assert.match(editing, /<script data-servant-editor>/);
    assert.match(editing, /Tap any text to change it/);
    const r = savePrototypePage(dir, folder, `/p/${folder}/`, {
      edits: [{ from: "Welcome, Jordan", to: "Hi, Jordan" }, { from: "Tax & you", to: "Taxes & you" }, { from: "Due", to: "Owed" }, { from: "Not here", to: "x" }],
      styles: [{ selector: "body > h1:nth-child(1)", css: { color: "rgb(0, 94, 162)", "font-size": "40px", background: "url(x)", "margin-top": "expression(1)" } }, { selector: "h1{}</style><script>", css: { color: "#000" } }],
    });
    assert.deepEqual(r, { path: "index.html", missed: ["Due", "Not here"] }, "ambiguous or missing words are named back, never guessed");
    let saved = read();
    assert.match(saved, /<h2>Hi, Jordan<\/h2>/, "words drawn by a script change in the script");
    assert.match(saved, /<p>Taxes &amp; you<\/p>/, "markup stays escaped");
    assert.match(saved, /<p>Due<\/p><p>Due<\/p>/);
    assert.match(saved, /<style data-servant-tweaks>\nbody > h1:nth-child\(1\)\{color:rgb\(0, 94, 162\) !important;font-size:40px !important\}\n<\/style>\n<\/head>/);
    assert.doesNotMatch(saved, /url\(x\)|expression|<\/style><script>/, "only plain colors and sizes, only plain selectors");
    // A second save merges into the same block.
    savePrototypePage(dir, folder, `/p/${folder}/`, { styles: [{ selector: "body > h1:nth-child(1)", css: { color: "#d11242" } }] });
    saved = read();
    assert.equal(saved.match(/data-servant-tweaks/g).length, 1);
    assert.match(saved, /\{color:#d11242 !important;font-size:40px !important\}/);
    assert.equal(fs.readdirSync(path.join(dir, folder, ".history")).length, 2, "old versions are kept");
    assert.equal((await fetch(`${base}.history/`)).status, 404, "history is never served");
    assert.deepEqual(savePrototypePage(dir, folder, `/p/${folder}/`, { edits: [{ from: "Nope", to: "x" }] }), { path: "index.html", missed: ["Nope"] });
    assert.equal(fs.readdirSync(path.join(dir, folder, ".history")).length, 2, "nothing applied, nothing written");
    savePrototypePage(dir, folder, `/p/${folder}/sub/a.html`, { edits: [{ from: "a", to: "b" }] });
    assert.equal(fs.readFileSync(path.join(dir, folder, "sub", "a.html"), "utf8"), "<p>b</p>");
    const one = { edits: [{ from: "keep", to: "x" }] };
    for (const [p, status] of [["/p/x/../../outside.html", 400], [`/p/${folder}/style.css`, 400], [`/p/${folder}/new.html`, 404], [`/p/${folder}/link.html`, 404], [`/p/${folder}/%2e%2e/outside.html`, 400], [`/p/${folder}/.history/x.html`, 400]]) {
      assert.throws(() => savePrototypePage(dir, folder, p, one), (e) => e.status === status, p);
    }
    assert.throws(() => savePrototypePage(dir, "../etc", "/", one), (e) => e.status === 404);
    assert.throws(() => savePrototypePage(dir, folder, "/", {}), (e) => e.status === 400);
    assert.equal(fs.readFileSync(path.join(dir, "outside.html"), "utf8"), "keep");
  } finally { srv.closeAllConnections?.(); srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
