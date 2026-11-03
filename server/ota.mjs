// Over-the-air app updates, served by this server (Expo Updates protocol v1).
//
// `servant ota publish` exports the app's JavaScript and assets into
// <data>/ota. Phones fetch GET /ota/manifest from the same address they use
// for everything else, download only the files that changed, and run the new
// JavaScript on the next launch. No app store review and no new build, as long
// as the update uses the native code already inside the installed build (the
// "runtime version").
//
// Integrity: every manifest is signed with an RSA key that stays on this Mac.
// The matching certificate is built into the app, which refuses anything
// else, so a tunnel, relay or CDN in the middle cannot change the code. The
// app also checks each file's SHA-256 against the signed manifest.
//
// The routes are public and carry only app code, never user data.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2", json: "application/json", mp3: "audio/mpeg",
  wav: "audio/wav", m4a: "audio/mp4", mp4: "video/mp4", ogg: "audio/ogg", txt: "text/plain", html: "text/html", js: "application/javascript",
};
const HASH = /^[A-Za-z0-9_-]{43}$/;
const PLATFORMS = ["ios", "android"];
const KEEP_PER_RUNTIME = 8;

export const mimeFor = ext => MIME[String(ext || "").replace(/^\./, "").toLowerCase()] || "application/octet-stream";
const sha256b64url = buf => crypto.createHash("sha256").update(buf).digest("base64url");
const md5hex = buf => crypto.createHash("md5").update(buf).digest("hex");

export function defaultKeyFile() {
  return process.env.SERVANT_OTA_KEY_FILE || path.join(os.homedir(), ".config", "servant", "ota-keys", "private-key.pem");
}

// ---------- store (shared by the server and `servant ota`) ----------

const entryDir = (dir, id) => path.join(dir, "updates", id);
const filesDir = dir => path.join(dir, "files");

export function listUpdates(dir) {
  let ids = [];
  try { ids = fs.readdirSync(path.join(dir, "updates")); } catch { return []; }
  const out = [];
  for (const id of ids) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(entryDir(dir, id), "update.json"), "utf8"))); } catch { /* half-written */ }
  }
  return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** The newest entry for this runtime: an update, a rollback, or nothing. */
export function latestFor(dir, runtimeVersion) {
  return listUpdates(dir).find(u => u.runtimeVersion === runtimeVersion) || null;
}

/**
 * Add an update from an `expo export` output directory.
 * `runtimeVersions` maps platform -> runtime version (they differ if the iOS and
 * Android native versions differ). Returns the stored update.
 */
export function publishUpdate({ dir, exportDir, runtimeVersions, expoClient = {}, note = "", now = Date.now() }) {
  const metadata = JSON.parse(fs.readFileSync(path.join(exportDir, "metadata.json"), "utf8"));
  const platforms = {};
  fs.mkdirSync(filesDir(dir), { recursive: true, mode: 0o700 });
  const store = (file, contentType) => {
    const buf = fs.readFileSync(file);
    const hash = sha256b64url(buf);
    const target = path.join(filesDir(dir), hash);
    if (!fs.existsSync(target)) { fs.writeFileSync(`${target}.tmp`, buf, { mode: 0o600 }); fs.renameSync(`${target}.tmp`, target); }
    fs.writeFileSync(`${target}.mime`, contentType, { mode: 0o600 });
    return { hash, key: md5hex(buf), contentType };
  };
  for (const platform of PLATFORMS) {
    const meta = metadata.fileMetadata?.[platform];
    if (!meta) continue;
    if (!runtimeVersions[platform]) throw new Error(`No runtime version for ${platform}`);
    const launch = store(path.join(exportDir, meta.bundle), "application/javascript");
    const assets = (meta.assets || []).map(a => {
      const ext = String(a.ext || "").replace(/^\./, "");
      const stored = store(path.join(exportDir, a.path), mimeFor(ext));
      return { ...stored, fileExtension: ext ? `.${ext}` : "" };
    });
    platforms[platform] = { runtimeVersion: runtimeVersions[platform], launchAsset: launch, assets };
  }
  if (!Object.keys(platforms).length) throw new Error("The export has no ios or android bundle");
  // One record per runtime version, so "latest for this build" is a single lookup.
  const records = new Map();
  for (const [platform, p] of Object.entries(platforms)) {
    const record = records.get(p.runtimeVersion) || { id: crypto.randomUUID(), type: "update", runtimeVersion: p.runtimeVersion, createdAt: new Date(now).toISOString(), note: String(note).slice(0, 300), platforms: {}, expoClient };
    record.platforms[platform] = p;
    records.set(p.runtimeVersion, record);
  }
  for (const record of records.values()) writeEntry(dir, record);
  prune(dir);
  return [...records.values()].map(r => ({ id: r.id, runtimeVersion: r.runtimeVersion, platforms: Object.keys(r.platforms) }));
}

function writeEntry(dir, entry) {
  const target = entryDir(dir, entry.id);
  fs.mkdirSync(`${target}.tmp`, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(`${target}.tmp`, "update.json"), JSON.stringify(entry, null, 2), { mode: 0o600 });
  fs.renameSync(`${target}.tmp`, target);
}

/** Tell phones on this runtime to go back to the update built into their app. */
export function publishRollback({ dir, runtimeVersion, now = Date.now() }) {
  const entry = { id: crypto.randomUUID(), type: "rollback", runtimeVersion, createdAt: new Date(now).toISOString(), platforms: {}, note: "Back to the version in the app" };
  writeEntry(dir, entry);
  return entry;
}

function prune(dir) {
  const byRuntime = new Map();
  for (const u of listUpdates(dir)) {
    const list = byRuntime.get(u.runtimeVersion) || []; list.push(u); byRuntime.set(u.runtimeVersion, list);
  }
  const keep = new Set();
  for (const list of byRuntime.values()) for (const u of list.slice(0, KEEP_PER_RUNTIME)) keep.add(u.id);
  for (const u of listUpdates(dir)) if (!keep.has(u.id)) fs.rmSync(entryDir(dir, u.id), { recursive: true, force: true });
  // Remove files no remaining update refers to.
  const used = new Set();
  for (const u of listUpdates(dir)) for (const p of Object.values(u.platforms || {})) for (const a of [p.launchAsset, ...p.assets]) used.add(a.hash);
  let files = [];
  try { files = fs.readdirSync(filesDir(dir)); } catch { /* none */ }
  for (const f of files) if (!used.has(f.replace(/\.(mime|tmp)$/, ""))) fs.rmSync(path.join(filesDir(dir), f), { force: true });
}

// ---------- serving ----------

function baseUrl(req) {
  const host = String(req.headers.host || "");
  if (!/^[A-Za-z0-9.\-:[\]]{1,255}$/.test(host)) return null;
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwarded === "https" || forwarded === "http" ? forwarded : req.socket?.encrypted ? "https" : "http";
  return `${proto}://${host}`;
}

export function createOta({ dir, keyFile = defaultKeyFile, log = console }) {
  let keyCache = null;
  const privateKey = () => {
    const file = typeof keyFile === "function" ? keyFile() : keyFile;
    if (keyCache?.file === file) return keyCache.key;
    try { keyCache = { file, key: crypto.createPrivateKey(fs.readFileSync(file)) }; return keyCache.key; }
    catch { return null; }
  };
  const sign = body => {
    const key = privateKey();
    return key ? crypto.sign("sha256", Buffer.from(body), key).toString("base64") : null;
  };

  const json = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(text);
  };

  function multipart(res, parts, headers = {}) {
    const boundary = `servant-${crypto.randomBytes(12).toString("hex")}`;
    const chunks = parts.map(p => `--${boundary}\r\ncontent-disposition: form-data; name="${p.name}"\r\ncontent-type: application/json\r\n${p.signature ? `expo-signature: sig="${p.signature}", keyid="main"\r\n` : ""}\r\n${p.body}\r\n`);
    // The iOS reader needs CRLF after every delimiter, including the closing one.
    const body = `${chunks.join("")}--${boundary}--\r\n`;
    res.writeHead(200, {
      "content-type": `multipart/mixed; boundary=${boundary}`,
      "expo-protocol-version": "1", "expo-sfv-version": "0",
      "cache-control": "private, max-age=0",
      ...headers,
    });
    res.end(body);
  }

  function manifestFor(entry, platform, base) {
    const p = entry.platforms[platform];
    const asset = a => ({ hash: a.hash, key: a.key, fileExtension: a.fileExtension || undefined, contentType: a.contentType, url: `${base}/ota/assets/${a.hash}` });
    return {
      id: entry.id,
      createdAt: entry.createdAt,
      runtimeVersion: p.runtimeVersion,
      launchAsset: { hash: p.launchAsset.hash, key: p.launchAsset.key, contentType: p.launchAsset.contentType, url: `${base}/ota/assets/${p.launchAsset.hash}` },
      assets: p.assets.map(asset),
      metadata: {},
      extra: { expoClient: entry.expoClient || {} },
    };
  }

  function manifest(req, res) {
    const platform = String(req.headers["expo-platform"] || "");
    const runtime = String(req.headers["expo-runtime-version"] || "");
    if (!PLATFORMS.includes(platform)) return json(res, 400, { error: "expo-platform must be ios or android" });
    if (!runtime || runtime.length > 100) return json(res, 400, { error: "expo-runtime-version is required" });
    if (String(req.headers["expo-protocol-version"] || "1") !== "1") return json(res, 406, { error: "Only Expo Updates protocol version 1 is supported" });
    const base = baseUrl(req);
    if (!base) return json(res, 400, { error: "Invalid Host header" });
    const wantsSignature = !!req.headers["expo-expect-signature"];
    if (wantsSignature && !privateKey()) {
      log.error?.("[servant] ota: the app expects signed updates but there is no signing key at", typeof keyFile === "function" ? keyFile() : keyFile);
      return json(res, 503, { error: "This server has no update signing key" });
    }
    const part = (name, value) => { const body = JSON.stringify(value); return { name, body, signature: wantsSignature ? sign(body) : null }; };
    const entry = latestFor(dir, runtime);
    if (!entry) return multipart(res, [part("directive", { type: "noUpdateAvailable" })]);
    if (entry.type === "rollback") return multipart(res, [part("directive", { type: "rollBackToEmbedded", parameters: { commitTime: entry.createdAt } })]);
    if (!entry.platforms[platform]) return multipart(res, [part("directive", { type: "noUpdateAvailable" })]);
    const extensions = JSON.stringify({ assetRequestHeaders: {} });
    return multipart(res, [part("manifest", manifestFor(entry, platform, base)), { name: "extensions", body: extensions, signature: null }]);
  }

  function asset(req, res, hash) {
    if (!HASH.test(hash)) return json(res, 404, { error: "No such file" });
    const file = path.join(filesDir(dir), hash);
    let stat;
    try { stat = fs.statSync(file); } catch { return json(res, 404, { error: "No such file" }); }
    let type = "application/octet-stream";
    try { type = fs.readFileSync(`${file}.mime`, "utf8").trim() || type; } catch { /* keep default */ }
    res.writeHead(200, { "content-type": type, "content-length": stat.size, "cache-control": "public, max-age=31536000, immutable" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
  }

  /** Returns true when the request was an /ota route. */
  function handle(req, res) {
    const url = new URL(req.url, "http://server");
    if (url.pathname !== "/ota/manifest" && !url.pathname.startsWith("/ota/assets/")) return false;
    if (req.method !== "GET" && req.method !== "HEAD") { json(res, 405, { error: "Use GET" }); return true; }
    try {
      if (url.pathname === "/ota/manifest") manifest(req, res);
      else asset(req, res, url.pathname.slice("/ota/assets/".length));
    } catch (error) {
      log.error?.("[servant] ota", error.message);
      if (!res.headersSent) json(res, 500, { error: "Couldn't serve the update" });
      else res.destroy();
    }
    return true;
  }

  return { handle, latestFor: runtime => latestFor(dir, runtime), hasKey: () => !!privateKey() };
}
