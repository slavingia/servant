#!/usr/bin/env node
// Publish an over-the-air app update to this Mac's Servant server.
//
//   node scripts/ota-publish.mjs [--note "what changed"] [--data DIR] [--platform ios|android|web]
//
// Exports the app's JavaScript and assets with `expo export`, files them under
// <data>/ota, and phones pick the update up on their next launch. See docs/ota.md.
// Run it from a checkout; the signing key stays in ~/.config/servant/ota-keys.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseAlsoRuntimes, publishUpdate, publishWeb } from "../server/ota.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "app");
const args = process.argv.slice(2);
const arg = (name, fallback = "") => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] ?? "" : fallback; };
const die = message => { console.error(`servant ota publish: ${message}`); process.exit(1); };

const dataDir = arg("data") || process.env.SERVANT_DATA_DIR || path.join(os.homedir(), ".local", "share", "servant", "data");
const only = arg("platform");
// Everything by default: both phone platforms and the Mac app's interface.
const chosen = only ? [only] : ["ios", "android", "web"];
if (chosen.some(p => !["ios", "android", "web"].includes(p))) die("--platform must be ios, android or web");
const platforms = chosen.filter(p => p !== "web");
const wantsWeb = chosen.includes("web");

const config = JSON.parse(fs.readFileSync(path.join(appDir, "app.json"), "utf8")).expo;
if (!config.updates?.codeSigningCertificate) die("app.json has no updates.codeSigningCertificate");
const key = process.env.SERVANT_OTA_KEY_FILE || path.join(os.homedir(), ".config", "servant", "ota-keys", "private-key.pem");
if (!fs.existsSync(key)) die(`no signing key at ${key}. Generate one with: cd app && npx expo-updates codesigning:generate`);

// The runtime version must equal what the installed builds report. With the "fingerprint"
// policy, ask expo-updates for it: it hashes the native code the same way the build did. Run
// with the same SERVANT_* settings as the build (bundle id, update address), since they are
// part of the native config.
const policy = config.runtimeVersion?.policy;
// The update address and bundle id are part of the native config, so a publish without them
// would compute a runtime no installed build has and reach nobody.
if (policy === "fingerprint" && platforms.some(p => p !== "web") && !process.env.SERVANT_OTA_URL) {
  die("set SERVANT_OTA_URL and SERVANT_BUNDLE_ID to what the builds used; the runtime version depends on them");
}
const runtimeFor = platform => {
  if (typeof config.runtimeVersion === "string") return config.runtimeVersion;
  if (policy === "fingerprint") {
    const out = execFileSync("npx", ["expo-updates", "runtimeversion:resolve", "--platform", platform], { cwd: appDir, encoding: "utf8", env: { ...process.env, CI: "1" } });
    const value = JSON.parse(out.slice(out.indexOf("{"))).runtimeVersion;
    if (!value) die(`couldn't work out the ${platform} runtime version`);
    return value;
  }
  const native = platform === "ios" ? config.ios?.buildNumber : config.android?.versionCode;
  if (policy === "nativeVersion") return `${config.version}(${native})`;
  if (policy === "appVersion") return config.version;
  die(`runtimeVersion policy "${policy}" isn't supported here; use fingerprint, nativeVersion, appVersion or a fixed string`);
};
const runtimeVersions = Object.fromEntries(platforms.map(p => [p, runtimeFor(p)]));
// Builds made before the fingerprint policy report "version(buildNumber)". List any still in
// use in <data>/ota/also-runtimes.txt, one "ios=1.0.0(51) android=1.0.0(50)" line per build,
// and each publish reaches them too. Only list builds whose native code matches this checkout.
const alsoFile = path.join(dataDir, "ota", "also-runtimes.txt");
const also = fs.existsSync(alsoFile) ? parseAlsoRuntimes(fs.readFileSync(alsoFile, "utf8"), platforms) : [];

const note = () => arg("note") || execFileSync("git", ["log", "-1", "--format=%h %s"], { cwd: root, encoding: "utf8" }).trim();
const env = { ...process.env, CI: "1" };

if (platforms.length) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "servant-ota-"));
  try {
    console.log(`Exporting ${platforms.join(" and ")} (runtime ${[...new Set(Object.values(runtimeVersions))].join(", ")})…`);
    execFileSync("npx", ["expo", "export", ...platforms.flatMap(p => ["--platform", p]), "--output-dir", out], { cwd: appDir, stdio: ["ignore", "inherit", "inherit"], env });
    const expoClient = JSON.parse(execFileSync("npx", ["expo", "config", "--type", "public", "--json"], { cwd: appDir, encoding: "utf8", env }));
    for (const [i, rv] of [runtimeVersions, ...also].entries()) {
      for (const r of publishUpdate({ dir: path.join(dataDir, "ota"), exportDir: out, runtimeVersions: rv, expoClient, note: note(), partial: i > 0 })) console.log(`Published ${r.id} for ${r.platforms.join("+")} on runtime ${r.runtimeVersion}`);
    }
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
}

if (wantsWeb) {
  // The Mac app's interface. Its shell API number lives in desktop/ota.mjs.
  const shellApi = Number(/export const SHELL_API = (\d+)/.exec(fs.readFileSync(path.join(root, "desktop", "ota.mjs"), "utf8"))?.[1]);
  if (!shellApi) die("couldn't read SHELL_API from desktop/ota.mjs");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "servant-ota-web-"));
  try {
    console.log("Exporting the Mac app interface…");
    execFileSync("npx", ["expo", "export", "--platform", "web", "--output-dir", out], { cwd: appDir, stdio: ["ignore", "inherit", "inherit"], env });
    const r = publishWeb({ dir: path.join(dataDir, "ota"), webDir: out, shellApi, note: note() });
    console.log(`Published ${r.id} for the Mac app (${r.runtimeVersion}, ${r.files} files, ${(r.bytes / 1048576).toFixed(1)} MB)`);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
}
console.log("Phones and Macs with a matching build load it the next time they open Servant.");
