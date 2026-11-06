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
import { publishUpdate, publishWeb } from "../server/ota.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "app");
const args = process.argv.slice(2);
const arg = (name, fallback = "") => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] ?? "" : fallback; };
const die = message => { console.error(`servant ota publish: ${message}`); process.exit(1); };
const env = { ...process.env, CI: "1" };

// Resolve app.config.js so flavor-specific identifiers and runtime versions are
// exactly the ones Expo embeds in the installed binary.
const config = JSON.parse(execFileSync("npx", ["expo", "config", "--type", "public", "--json"], { cwd: appDir, encoding: "utf8", env }));
// Expo deliberately removes local signing paths and metadata from its public
// config. Read only those build-time fields from the checked-in static config;
// keep using the resolved public config for flavor/runtime values and manifests.
const signing = JSON.parse(fs.readFileSync(path.join(appDir, "app.json"), "utf8")).expo?.updates;
const flavor = config.extra?.servantFlavor || "core";

const dataDir = arg("data") || process.env.SERVANT_DATA_DIR || path.join(os.homedir(), ".local", "share", "servant", "data");
const only = arg("platform");
// UX phone runtimes are flavor-isolated. The UX desktop intentionally has no
// interface-update runtime yet, so a default UX publish cannot replace the
// interface used by an upstream Servant desktop.
const chosen = only ? [only] : flavor === "ux" ? ["ios", "android"] : ["ios", "android", "web"];
if (chosen.some(p => !["ios", "android", "web"].includes(p))) die("--platform must be ios, android or web");
const platforms = chosen.filter(p => p !== "web");
const wantsWeb = chosen.includes("web");
if (wantsWeb && flavor === "ux") die("web interface updates are disabled for Servant UX until it has a dedicated desktop runtime; use SERVANT_APP_FLAVOR=core only for an upstream desktop publish");

if (!signing?.codeSigningCertificate) die("app.json has no updates.codeSigningCertificate");
const key = process.env.SERVANT_OTA_KEY_FILE || path.join(os.homedir(), ".config", "servant", "ota-keys", "private-key.pem");
if (!fs.existsSync(key)) die(`no signing key at ${key}. Generate one with: cd app && npx expo-updates codesigning:generate`);

// The runtime version must equal what the installed builds report, so compute it
// the same way expo-updates does for the "nativeVersion" policy.
const runtimeFor = platform => {
  const runtime = config[platform]?.runtimeVersion ?? config.runtimeVersion;
  if (typeof runtime === "string") return runtime;
  const policy = runtime?.policy;
  const native = platform === "ios" ? config.ios?.buildNumber : config.android?.versionCode;
  if (policy === "nativeVersion") return `${config.version}(${native})`;
  if (policy === "appVersion") return config.version;
  die(`runtimeVersion policy "${policy}" isn't supported here; use nativeVersion, appVersion or a fixed string`);
};
const runtimeVersions = Object.fromEntries(platforms.map(p => [p, runtimeFor(p)]));

const note = () => arg("note") || execFileSync("git", ["log", "-1", "--format=%h %s"], { cwd: root, encoding: "utf8" }).trim();

if (platforms.length) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "servant-ota-"));
  try {
    console.log(`Exporting ${platforms.join(" and ")} (runtime ${[...new Set(Object.values(runtimeVersions))].join(", ")})…`);
    execFileSync("npx", ["expo", "export", ...platforms.flatMap(p => ["--platform", p]), "--output-dir", out], { cwd: appDir, stdio: ["ignore", "inherit", "inherit"], env });
    for (const r of publishUpdate({ dir: path.join(dataDir, "ota"), exportDir: out, runtimeVersions, expoClient: config, note: note() })) console.log(`Published ${r.id} for ${r.platforms.join("+")} on runtime ${r.runtimeVersion}`);
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
