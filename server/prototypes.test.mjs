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
