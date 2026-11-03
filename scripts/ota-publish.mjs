#!/usr/bin/env node
// Publish an over-the-air app update to this Mac's Servant server.
//
//   node scripts/ota-publish.mjs [--note "what changed"] [--data DIR] [--platform ios|android]
//
// Exports the app's JavaScript and assets with `expo export`, files them under
// <data>/ota, and phones pick the update up on their next launch. See docs/ota.md.
// Run it from a checkout; the signing key stays in ~/.config/servant/ota-keys.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { publishUpdate } from "../server/ota.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "app");
const args = process.argv.slice(2);
const arg = (name, fallback = "") => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] ?? "" : fallback; };
const die = message => { console.error(`servant ota publish: ${message}`); process.exit(1); };

const dataDir = arg("data") || process.env.SERVANT_DATA_DIR || path.join(os.homedir(), ".local", "share", "servant", "data");
const only = arg("platform");
const platforms = only ? [only] : ["ios", "android"];
if (platforms.some(p => !["ios", "android"].includes(p))) die("--platform must be ios or android");

const config = JSON.parse(fs.readFileSync(path.join(appDir, "app.json"), "utf8")).expo;
if (!config.updates?.codeSigningCertificate) die("app.json has no updates.codeSigningCertificate");
const key = process.env.SERVANT_OTA_KEY_FILE || path.join(os.homedir(), ".config", "servant", "ota-keys", "private-key.pem");
if (!fs.existsSync(key)) die(`no signing key at ${key}. Generate one with: cd app && npx expo-updates codesigning:generate`);

// The runtime version must equal what the installed builds report, so compute it
// the same way expo-updates does for the "nativeVersion" policy.
const policy = config.runtimeVersion?.policy;
const runtimeFor = platform => {
  if (typeof config.runtimeVersion === "string") return config.runtimeVersion;
  const native = platform === "ios" ? config.ios?.buildNumber : config.android?.versionCode;
  if (policy === "nativeVersion") return `${config.version}(${native})`;
  if (policy === "appVersion") return config.version;
  die(`runtimeVersion policy "${policy}" isn't supported here; use nativeVersion, appVersion or a fixed string`);
};
const runtimeVersions = Object.fromEntries(platforms.map(p => [p, runtimeFor(p)]));

const out = fs.mkdtempSync(path.join(os.tmpdir(), "servant-ota-"));
try {
  console.log(`Exporting ${platforms.join(" and ")} (runtime ${[...new Set(Object.values(runtimeVersions))].join(", ")})…`);
  execFileSync("npx", ["expo", "export", ...platforms.flatMap(p => ["--platform", p]), "--output-dir", out], { cwd: appDir, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, CI: "1" } });
  const expoClient = JSON.parse(execFileSync("npx", ["expo", "config", "--type", "public", "--json"], { cwd: appDir, encoding: "utf8", env: { ...process.env, CI: "1" } }));
  const note = arg("note") || execFileSync("git", ["log", "-1", "--format=%h %s"], { cwd: root, encoding: "utf8" }).trim();
  const result = publishUpdate({ dir: path.join(dataDir, "ota"), exportDir: out, runtimeVersions, expoClient, note });
  for (const r of result) console.log(`Published ${r.id} for ${r.platforms.join("+")} on runtime ${r.runtimeVersion}`);
  console.log("Phones with a matching build load it the next time they open Servant.");
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
