import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { BRIDGE, previewInfo, previewRoot, serveAppPreview, _resetPreviewLimits } from "./app-preview.mjs";

function exportFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-previews-"));
  const root = path.join(dir, "example-app");
  fs.mkdirSync(path.join(root, "_expo/static/js/web"), { recursive: true });
  fs.mkdirSync(path.join(root, "notices"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><html><head><title>Home</title></head><body><div id=root>Home</div></body></html>");
  fs.writeFileSync(path.join(root, "refund-status.html"), "<html><head></head><body>Refund</body></html>");
  fs.writeFileSync(path.join(root, "notices/index.html"), "<html><head></head><body>Notices</body></html>");
  fs.writeFileSync(path.join(root, "+not-found.html"), "<html><head></head><body>Not here</body></html>");
  fs.writeFileSync(path.join(root, "_expo/static/js/web/entry-0123456789abcdef0123.js"), "console.log(1)");
  fs.writeFileSync(path.join(root, ".secret"), "no");
  fs.writeFileSync(path.join(dir, "outside.html"), "<html>outside</html>");
  fs.symlinkSync(path.join(dir, "outside.html"), path.join(root, "escape.html"));
  fs.writeFileSync(path.join(root, "deployment-environment.json"), JSON.stringify({ commit: "abcdef0123456789", builtAt: "2026-11-17T10:00:00.000Z" }));
  return dir;
}

async function serve(dir, fn) {
  _resetPreviewLimits();
  const srv = http.createServer((req, res) => { if (!serveAppPreview(req, res, new URL(req.url, "http://x"), { dir })) { res.writeHead(418); res.end(); } });
  await new Promise(r => srv.listen(0, r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

test("a project's exported app is served at /a/<project>/, with clean URLs like the static export expects", async () => {
  const dir = exportFixture();
  await serve(dir, async base => {
    assert.equal((await fetch(`${base}/elsewhere`)).status, 418, "other paths aren't ours");
    const bare = await fetch(`${base}/a/example-app`, { redirect: "manual" });
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get("location"), "/a/example-app/");
    const home = await fetch(`${base}/a/example-app/`);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /<head><script data-servant-shim>/, "storage shim runs before the app's scripts");
    assert.match(html, /<script data-servant-bridge data-base="\/a\/example-app">/);
    assert.equal((html.match(/data-servant-bridge data-base/g) || []).length, 1);
    assert.match(home.headers.get("content-security-policy"), /^sandbox allow-scripts allow-forms allow-popups allow-modals;/, "pages never share this server's origin");
    assert.doesNotMatch(home.headers.get("content-security-policy"), /allow-same-origin/);
    assert.equal(home.headers.get("cache-control"), "no-store");
    assert.match(await (await fetch(`${base}/a/example-app/refund-status?persona=sample`)).text(), /Refund/);
    assert.match(await (await fetch(`${base}/a/example-app/notices`)).text(), /Notices/);
    const missing = await fetch(`${base}/a/example-app/no-such-screen`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /Not here/, "unknown screens get the app's own not-found page");
    const js = await fetch(`${base}/a/example-app/_expo/static/js/web/entry-0123456789abcdef0123.js`);
    assert.equal(js.status, 200);
    assert.equal(await js.text(), "console.log(1)", "scripts are served untouched");
    assert.match(js.headers.get("cache-control"), /immutable/);
    assert.equal(js.headers.get("content-security-policy"), null);
  });
});

test("nothing outside the project's export, no dot files, no other projects", async () => {
  const dir = exportFixture();
  await serve(dir, async base => {
    assert.equal((await fetch(`${base}/a/example-app/.secret`)).status, 404);
    assert.equal((await fetch(`${base}/a/example-app/%2e%2e/outside.html`)).status, 404);
    assert.notEqual(await (await fetch(`${base}/a/example-app/escape.html`)).text(), "<html>outside</html>");
    assert.equal((await fetch(`${base}/a/example-app/missing.png`)).status, 404, "a missing file isn't swapped for a page");
    const none = await fetch(`${base}/a/other-app/`);
    assert.equal(none.status, 404);
    assert.match(await none.text(), /no app preview yet/);
    assert.equal((await fetch(`${base}/a/Bad_Id/`)).status, 404);
    assert.equal((await fetch(`${base}/a/example-app/`, { method: "POST" })).status, 405);
  });
});

test("the project page learns where its preview is and what it was built from", () => {
  const dir = exportFixture();
  assert.equal(previewRoot(dir, "../x"), null);
  assert.equal(previewInfo(dir, "nothing-here"), null);
  assert.deepEqual(previewInfo(dir, "example-app"), { path: "/a/example-app/", builtAt: "2026-11-17T10:00:00.000Z", commit: "abcdef012" });
});

test("the bridge only talks to the screen around it, and right-click always comments", () => {
  assert.doesNotMatch(BRIDGE, /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/, "it never calls a server");
  assert.match(BRIDGE, /parent\.postMessage\(s,"\*"\)/);
  assert.match(BRIDGE, /ReactNativeWebView\.postMessage/);
  assert.match(BRIDGE, /addEventListener\("contextmenu",function\(e\)\{if\(mine\(e\)\)return;e\.preventDefault\(\);e\.stopPropagation\(\);at\(e,e\)\}/);
  assert.match(BRIDGE, /servant==="app-preview-mode"/);
  assert.match(BRIDGE, /\["pushState","replaceState"\]/, "it follows the app's own navigation");
});
