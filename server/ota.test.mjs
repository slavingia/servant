import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createOta, listUpdates, mimeFor, publishRollback, publishUpdate, publishWeb } from "./ota.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "servant-ota-"));
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

function fakeExport() {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "bundles"), { recursive: true });
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bundles", "ios.js"), "console.log('ios')");
  fs.writeFileSync(path.join(dir, "bundles", "android.js"), "console.log('android')");
  fs.writeFileSync(path.join(dir, "assets", "logo"), "PNGDATA");
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({ version: 0, bundler: "metro", fileMetadata: {
    ios: { bundle: "bundles/ios.js", assets: [{ path: "assets/logo", ext: "png" }] },
    android: { bundle: "bundles/android.js", assets: [{ path: "assets/logo", ext: "png" }] },
  } }));
  return dir;
}

async function serve(dir, keyFile) {
  const ota = createOta({ dir, keyFile, log: { error() {} } });
  const server = http.createServer((req, res) => { if (!ota.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, ota, close: () => new Promise(r => server.close(r)) };
}

const parts = async res => {
  const boundary = /boundary=(.+)$/.exec(res.headers.get("content-type"))[1];
  const text = await res.text();
  // The framing expo-updates' multipart reader requires: first delimiter at the start,
  // CRLF around every delimiter, and CRLF after the closing one.
  assert.ok(text.startsWith(`--${boundary}\r\n`), "starts with the first delimiter");
  assert.ok(text.endsWith(`\r\n--${boundary}--\r\n`), "ends with CRLF--boundary--CRLF");
  return text.split(`--${boundary}`).slice(1, -1).map(chunk => {
    const [head, ...rest] = chunk.replace(/^\r\n/, "").split("\r\n\r\n");
    const headers = Object.fromEntries(head.split("\r\n").map(l => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
    return { headers, body: rest.join("\r\n\r\n").replace(/\r\n$/, "") };
  });
};
const manifestHeaders = (runtime, platform = "ios", signed = true) => ({
  "expo-protocol-version": "1", "expo-platform": platform, "expo-runtime-version": runtime,
  accept: "multipart/mixed", ...(signed ? { "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"' } : {}),
});

test("publishes per platform, serves a signed manifest, and the app can verify it", async () => {
  const data = tmp(); const keyFile = path.join(tmp(), "key.pem");
  fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  const published = publishUpdate({ dir: data, exportDir: fakeExport(), runtimeVersions: { ios: "1.0.0(28)", android: "1.0.0(28)" }, note: "hello" });
  assert.equal(published.length, 1, "same runtime for both platforms shares one record");
  const s = await serve(data, keyFile);
  try {
    const res = await fetch(`${s.base}/ota/manifest`, { headers: manifestHeaders("1.0.0(28)") });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("expo-protocol-version"), "1");
    assert.match(res.headers.get("cache-control"), /max-age=0/);
    const [manifest, extensions] = await parts(res);
    assert.match(manifest.headers["content-disposition"], /name="manifest"/);
    // Verify the signature exactly as the client does: RSA-SHA256 over the raw part body.
    const sig = /sig="([^"]+)"/.exec(manifest.headers["expo-signature"])[1];
    assert.ok(crypto.verify("sha256", Buffer.from(manifest.body), publicKey, Buffer.from(sig, "base64")), "signature verifies");
    assert.ok(!crypto.verify("sha256", Buffer.from(manifest.body + " "), publicKey, Buffer.from(sig, "base64")), "a changed body fails");
    assert.match(manifest.headers["expo-signature"], /keyid="main"/);
    assert.match(extensions.headers["content-disposition"], /name="extensions"/);
    const body = JSON.parse(manifest.body);
    assert.equal(body.runtimeVersion, "1.0.0(28)");
    assert.match(body.id, /^[0-9a-f-]{36}$/);
    assert.equal(body.launchAsset.contentType, "application/javascript");
    assert.equal(body.assets[0].fileExtension, ".png");
    assert.ok(body.launchAsset.url.startsWith(`${s.base}/ota/assets/`), "asset URLs follow the address the phone used");
    // Every file downloads and matches its hash.
    for (const a of [body.launchAsset, ...body.assets]) {
      const file = await fetch(a.url);
      assert.equal(file.status, 200);
      assert.equal(crypto.createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("base64url"), a.hash);
    }
    assert.equal((await fetch(body.assets[0].url)).headers.get("content-type"), "image/png");
    assert.match((await fetch(body.assets[0].url)).headers.get("cache-control"), /immutable/);
  } finally { await s.close(); }
});

test("each platform gets its own bundle and a different runtime gets nothing", async () => {
  const data = tmp(); const keyFile = path.join(tmp(), "key.pem");
  fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  publishUpdate({ dir: data, exportDir: fakeExport(), runtimeVersions: { ios: "1.0.0(28)", android: "1.0.0(29)" } });
  assert.equal(listUpdates(data).length, 2, "different runtimes are separate records");
  const s = await serve(data, keyFile);
  try {
    const ios = JSON.parse((await parts(await fetch(`${s.base}/ota/manifest`, { headers: manifestHeaders("1.0.0(28)", "ios") })))[0].body);
    const android = JSON.parse((await parts(await fetch(`${s.base}/ota/manifest`, { headers: manifestHeaders("1.0.0(29)", "android") })))[0].body);
    assert.notEqual(ios.launchAsset.hash, android.launchAsset.hash);
    const none = await parts(await fetch(`${s.base}/ota/manifest`, { headers: manifestHeaders("9.9.9(1)") }));
    assert.deepEqual(JSON.parse(none[0].body), { type: "noUpdateAvailable" });
    const wrongPlatform = await parts(await fetch(`${s.base}/ota/manifest`, { headers: manifestHeaders("1.0.0(28)", "android") }));
    assert.deepEqual(JSON.parse(wrongPlatform[0].body), { type: "noUpdateAvailable" }, "ios-only runtime has nothing for android");
  } finally { await s.close(); }
});

test("a newer update wins, and a rollback sends phones back to the built-in version", async () => {
  const data = tmp(); const keyFile = path.join(tmp(), "key.pem");
  fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  const rv = { ios: "1.0.0(28)", android: "1.0.0(28)" };
  publishUpdate({ dir: data, exportDir: fakeExport(), runtimeVersions: rv, now: Date.now() - 60_000 });
  const e2 = fakeExport(); fs.writeFileSync(path.join(e2, "bundles", "ios.js"), "console.log('v2')");
  const [second] = publishUpdate({ dir: data, exportDir: e2, runtimeVersions: rv });
  const s = await serve(data, keyFile);
  try {
    const m = JSON.parse((await parts(await fetch(`${s.base}/ota/manifest`, { headers: manifestHeaders("1.0.0(28)") })))[0].body);
    assert.equal(m.id, second.id);
    publishRollback({ dir: data, runtimeVersion: "1.0.0(28)", now: Date.now() + 1000 });
    const [directive] = await parts(await fetch(`${s.base}/ota/manifest`, { headers: manifestHeaders("1.0.0(28)") }));
    assert.match(directive.headers["content-disposition"], /name="directive"/);
    assert.equal(JSON.parse(directive.body).type, "rollBackToEmbedded");
    const sig = /sig="([^"]+)"/.exec(directive.headers["expo-signature"])[1];
    assert.ok(crypto.verify("sha256", Buffer.from(directive.body), publicKey, Buffer.from(sig, "base64")), "directives are signed too");
  } finally { await s.close(); }
});

test("refuses to serve unsigned code to an app that expects a signature, and says why", async () => {
  const data = tmp();
  publishUpdate({ dir: data, exportDir: fakeExport(), runtimeVersions: { ios: "1.0.0(28)", android: "1.0.0(28)" } });
  const s = await serve(data, path.join(tmp(), "missing.pem"));
  try {
    const res = await fetch(`${s.base}/ota/manifest`, { headers: manifestHeaders("1.0.0(28)") });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /no update signing key/);
    // A client that doesn't ask for a signature is not given an unsigned update by accident of the key.
    assert.equal((await fetch(`${s.base}/ota/manifest`, { headers: manifestHeaders("1.0.0(28)", "ios", false) })).status, 200);
  } finally { await s.close(); }
});

test("rejects bad requests and path tricks", async () => {
  const data = tmp(); const keyFile = path.join(tmp(), "key.pem");
  fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  publishUpdate({ dir: data, exportDir: fakeExport(), runtimeVersions: { ios: "1", android: "1" } });
  fs.writeFileSync(path.join(data, "secret.txt"), "private");
  const s = await serve(data, keyFile);
  try {
    assert.equal((await fetch(`${s.base}/ota/manifest`, { headers: { "expo-platform": "windows", "expo-runtime-version": "1" } })).status, 400);
    assert.equal((await fetch(`${s.base}/ota/manifest`, { headers: { "expo-platform": "ios" } })).status, 400);
    assert.equal((await fetch(`${s.base}/ota/manifest`, { headers: manifestHeaders("1"), method: "POST" })).status, 405);
    for (const bad of ["../secret.txt", "..%2Fsecret.txt", "%2e%2e/secret.txt", "short", "x".repeat(43) + "/x"]) {
      const res = await fetch(`${s.base}/ota/assets/${bad}`);
      assert.equal(res.status, 404, bad);
    }
    assert.equal((await fetch(`${s.base}/ota/assets/${"A".repeat(43)}`)).status, 404);
  } finally { await s.close(); }
});

test("old updates are pruned but the files the newest one needs stay", () => {
  const data = tmp(); const rv = { ios: "1", android: "1" };
  for (let i = 0; i < 12; i++) {
    const e = fakeExport(); fs.writeFileSync(path.join(e, "bundles", "ios.js"), `console.log(${i})`);
    publishUpdate({ dir: data, exportDir: e, runtimeVersions: rv, now: Date.now() + i * 1000 });
  }
  assert.equal(listUpdates(data).length, 8);
  const files = fs.readdirSync(path.join(data, "files")).filter(f => !f.endsWith(".mime"));
  // 8 distinct ios bundles + 1 android bundle + 1 shared asset
  assert.equal(files.length, 10);
});

test("mime types", () => {
  assert.equal(mimeFor(".png"), "image/png");
  assert.equal(mimeFor("ttf"), "font/ttf");
  assert.equal(mimeFor("weird"), "application/octet-stream");
});

function fakeWeb() {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "_expo", "static", "js"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<html>servant</html>");
  fs.writeFileSync(path.join(dir, "_expo", "static", "js", "entry-abc123.js"), "console.log('web')");
  return dir;
}

test("the Mac app's web bundle is published, signed and served by hash", async () => {
  const data = tmp(); const keyFile = path.join(tmp(), "key.pem");
  fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  const r = publishWeb({ dir: data, webDir: fakeWeb(), shellApi: 1 });
  assert.equal(r.runtimeVersion, "mac-shell-1");
  const s = await serve(data, keyFile);
  try {
    const res = await fetch(`${s.base}/ota/web/manifest?runtime=mac-shell-1`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(crypto.verify("sha256", Buffer.from(text), publicKey, Buffer.from(res.headers.get("x-servant-signature"), "base64")));
    const m = JSON.parse(text);
    assert.equal(m.type, "update");
    assert.deepEqual(m.files.map(f => f.path), ["_expo/static/js/entry-abc123.js", "index.html"]);
    const file = m.files.find(f => f.path === "index.html");
    const body = Buffer.from(await (await fetch(`${s.base}/ota/assets/${file.hash}`)).arrayBuffer());
    assert.equal(crypto.createHash("sha256").update(body).digest("base64url"), file.hash);
    assert.equal(body.toString(), "<html>servant</html>");
    // Nothing for a shell it wasn't published for, a bad runtime is refused, and phones never see web updates.
    assert.equal(JSON.parse(await (await fetch(`${s.base}/ota/web/manifest?runtime=mac-shell-2`)).text()).type, "none");
    assert.equal((await fetch(`${s.base}/ota/web/manifest?runtime=1.0.0(28)`)).status, 400);
    assert.deepEqual(JSON.parse((await parts(await fetch(`${s.base}/ota/manifest`, { headers: manifestHeaders("mac-shell-1") })))[0].body), { type: "noUpdateAvailable" });
    // Rollback is signed too.
    publishRollback({ dir: data, runtimeVersion: "mac-shell-1", now: Date.now() + 1000 });
    const rb = await fetch(`${s.base}/ota/web/manifest?runtime=mac-shell-1`);
    assert.equal(JSON.parse(await rb.text()).type, "rollback");
  } finally { await s.close(); }
});

test("a web export with an unsafe file name or no index.html is refused", () => {
  const bad = tmp(); fs.writeFileSync(path.join(bad, "index.html"), "x"); fs.writeFileSync(path.join(bad, "a;b.js"), "x");
  assert.throws(() => publishWeb({ dir: tmp(), webDir: bad, shellApi: 1 }), /Unsafe file name/);
  assert.throws(() => publishWeb({ dir: tmp(), webDir: tmp(), shellApi: 1 }), /no index.html/);
  assert.throws(() => publishWeb({ dir: tmp(), webDir: fakeWeb(), shellApi: 0 }), /shellApi/);
});

test("publishing the web bundle keeps the phone updates and their files", () => {
  const data = tmp();
  publishUpdate({ dir: data, exportDir: fakeExport(), runtimeVersions: { ios: "1", android: "1" } });
  publishWeb({ dir: data, webDir: fakeWeb(), shellApi: 1 });
  assert.equal(listUpdates(data).length, 2);
  assert.ok(listUpdates(data).some(u => u.platforms.ios) && listUpdates(data).some(u => u.platforms.web));
  for (const u of listUpdates(data)) for (const p of Object.values(u.platforms)) for (const f of p.files ?? [p.launchAsset, ...p.assets]) assert.ok(fs.existsSync(path.join(data, "files", f.hash)), "file kept");
});
