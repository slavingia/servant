#!/usr/bin/env node
// The generated config is JSON, a YAML subset Hermes accepts. Never clone an
// owner's profile: that copies credentials, memory, context and plugin state.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const templates = { member: "../config/profiles/member.json", researcher: "../config/profiles/researcher.json" };
const templatePath = kind => fileURLToPath(new URL(templates[kind], import.meta.url));
// Reference skills the Researcher Agent reads with skill_view (read-only). They hold knowledge, never data.
const researcherSkillsDir = fileURLToPath(new URL("../config/skills/researcher", import.meta.url));

// Copies the checked-in researcher skills into a researcher profile, replacing earlier copies of the same
// skills only. Other skills in the profile are left alone.
export function installResearcherSkills(directory) {
  const target = path.resolve(directory);
  const config = path.join(target, "config.yaml");
  if (!fs.existsSync(config)) throw new Error("That isn't a Hermes profile: it has no config.yaml.");
  if (!JSON.stringify(JSON.parse(fs.readFileSync(config, "utf8")).toolsets || []).includes("servant_researcher")) {
    throw new Error("Skills are installed only in researcher profiles.");
  }
  const skills = path.join(target, "skills");
  fs.mkdirSync(skills, { recursive: true, mode: 0o700 });
  const names = fs.readdirSync(researcherSkillsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  for (const name of names) {
    const destination = path.join(skills, name);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(path.join(researcherSkillsDir, name), destination, { recursive: true });
  }
  return names;
}

export function createMemberProfile(directory, { model = "", kind = "member" } = {}) {
  if (!templates[kind]) throw new Error("kind must be member or researcher");
  const target = path.resolve(directory);
  if (fs.existsSync(target)) throw new Error("Choose a new, empty profile directory; existing profiles are never overwritten.");
  const config = JSON.parse(fs.readFileSync(templatePath(kind), "utf8"));
  config.model = model;
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.chmodSync(target, 0o700);
  fs.writeFileSync(path.join(target, "config.yaml"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  if (kind === "researcher") installResearcherSkills(target);
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, model = "", kind = "member"] = process.argv.slice(2);
  if (directory === "--skills") {
    // Update the researcher skills in an existing researcher profile.
    try {
      if (!model || process.argv.length > 4) throw new Error("Usage: node scripts/member-profile.mjs --skills <existing-researcher-profile>");
      console.log(`Installed ${installResearcherSkills(model).join(", ")} in ${path.resolve(model)}. Restart its bridge to load them.`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  } else if (!directory || process.argv.length > 5) {
    console.error("Usage: node scripts/member-profile.mjs <new-profile-directory> [model] [member|researcher]\n       node scripts/member-profile.mjs --skills <existing-researcher-profile>");
    process.exitCode = 1;
  } else {
    try { console.log(`Created restricted ${kind} profile at ${createMemberProfile(directory, { model, kind })}`); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
