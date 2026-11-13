#!/usr/bin/env node
// The generated config is JSON, a YAML subset Hermes accepts. Never clone an
// owner's profile: that copies credentials, memory, context and plugin state.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const templates = { member: "../config/profiles/member.json", researcher: "../config/profiles/researcher.json" };
const templatePath = kind => fileURLToPath(new URL(templates[kind], import.meta.url));

export function createMemberProfile(directory, { model = "", kind = "member" } = {}) {
  if (!templates[kind]) throw new Error("kind must be member or researcher");
  const target = path.resolve(directory);
  if (fs.existsSync(target)) throw new Error("Choose a new, empty profile directory; existing profiles are never overwritten.");
  const config = JSON.parse(fs.readFileSync(templatePath(kind), "utf8"));
  config.model = model;
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.chmodSync(target, 0o700);
  fs.writeFileSync(path.join(target, "config.yaml"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, model = "", kind = "member"] = process.argv.slice(2);
  if (!directory || process.argv.length > 5) {
    console.error("Usage: node scripts/member-profile.mjs <new-profile-directory> [model] [member|researcher]");
    process.exitCode = 1;
  } else {
    try { console.log(`Created restricted ${kind} profile at ${createMemberProfile(directory, { model, kind })}`); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
