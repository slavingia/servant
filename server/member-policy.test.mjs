import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertMemberCapabilities, verifyMemberUpstream, MEMBER_POLICY_VERSION, MEMBER_ALLOWED_TOOLS } from "./member-policy.mjs";
import { createMemberProfile, installResearcherSkills } from "../scripts/member-profile.mjs";

const attestation = () => ({ features: { servant_member_isolation: true }, servant: { memberPolicy: {
  version: 1, allowedTools: [], persistentMemory: false, localContext: false, localMedia: false,
} } });

test("staged server policy constants match the bridge's reviewable policy", () => {
  const source = JSON.parse(fs.readFileSync(new URL("./member-policy.json", import.meta.url), "utf8"));
  assert.equal(MEMBER_POLICY_VERSION, source.version);
  assert.deepEqual(MEMBER_ALLOWED_TOOLS, source.allowedTools);
});

test("member turns require explicit bridge attestation, not ordinary Hermes tool listing", () => {
  assert.doesNotThrow(() => assertMemberCapabilities(attestation()));
  for (const data of [{}, { features: { run_submission: true } }, { data: [] }]) {
    assert.throws(() => assertMemberCapabilities(data), { code: "member_policy_unverified" });
  }
  for (const field of ["persistentMemory", "localContext", "localMedia"]) {
    const data = attestation(); data.servant.memberPolicy[field] = true;
    assert.throws(() => assertMemberCapabilities(data));
  }
  const data = attestation(); data.servant.memberPolicy.allowedTools = ["future_tool"];
  assert.throws(() => assertMemberCapabilities(data));
});

test("member policy probe uses authenticated loopback, rejects redirects and unsafe upstreams", async () => {
  let request;
  await verifyMemberUpstream({ url: "http://127.0.0.1:8643", key: "test-key" }, { fetchImpl: async (...args) => {
    request = args; return Response.json(attestation());
  } });
  assert.equal(request[0].pathname, "/v1/capabilities");
  assert.equal(request[1].headers.authorization, "Bearer test-key");
  assert.equal(request[1].redirect, "error");
  for (const url of ["https://example.com", "http://127.0.0.1.attacker.example", "http://user:pass@localhost:8643"]) {
    await assert.rejects(verifyMemberUpstream({ url, key: "test-key" }));
  }
  await assert.rejects(verifyMemberUpstream({ url: "http://localhost:8643" }));
  await assert.rejects(verifyMemberUpstream({ url: "http://localhost:8643", key: "test-key" }, {
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
  }));
  await assert.rejects(verifyMemberUpstream({ url: "http://localhost:8643", key: "test-key" }, {
    fetchImpl: async () => { throw new TypeError("Connection refused"); },
  }), { status: 503, code: "member_policy_unverified" });
});

test("profile setup creates private empty-memory profile and never overwrites existing state", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-member-profile-"));
  try {
    const target = path.join(directory, "member");
    createMemberProfile(target, { model: "test-model" });
    const config = JSON.parse(fs.readFileSync(path.join(target, "config.yaml"), "utf8"));
    assert.equal(config.model, "test-model");
    assert.deepEqual(config.memory, { memory_enabled: false, user_profile_enabled: false, provider: "" });
    assert.deepEqual(config.toolsets, []);
    assert.deepEqual(config.mcp_servers, {});
    assert.equal(fs.statSync(target).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(target, "config.yaml")).mode & 0o777, 0o600);
    assert.throws(() => createMemberProfile(target), /never overwritten/);
    assert.deepEqual(fs.readdirSync(target), ["config.yaml"]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("researcher profiles get the checked-in reference skills; member profiles don't", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-researcher-profile-"));
  try {
    const researcher = path.join(directory, "researcher");
    createMemberProfile(researcher, { model: "test-model", kind: "researcher" });
    const skill = path.join(researcher, "skills", "civic-research-studio", "SKILL.md");
    const text = fs.readFileSync(skill, "utf8");
    assert.match(text, /^---\nname: civic-research-studio\ndescription: .{20,1024}\n---\n/);
    for (const file of ["methods.md", "ab-testing.md", "study-file.md", "servant.md"]) {
      assert.ok(fs.existsSync(path.join(researcher, "skills", "civic-research-studio", "references", file)), file);
    }
    // Reinstalling replaces only the checked-in skills.
    fs.writeFileSync(skill, "stale");
    fs.mkdirSync(path.join(researcher, "skills", "someone-elses"));
    assert.deepEqual(installResearcherSkills(researcher), ["civic-research-studio"]);
    assert.equal(fs.readFileSync(skill, "utf8"), text);
    assert.ok(fs.existsSync(path.join(researcher, "skills", "someone-elses")));
    const member = path.join(directory, "member");
    createMemberProfile(member, { model: "test-model" });
    assert.deepEqual(fs.readdirSync(member), ["config.yaml"]);
    assert.throws(() => installResearcherSkills(member), /only in researcher profiles/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

// The reference skills are knowledge for the Researcher Agent: no data, no links to GitHub it can't open anyway.
test("researcher skills hold no records, identifiers or personal details", () => {
  const root = fileURLToPath(new URL("../config/skills/researcher", import.meta.url));
  const files = fs.readdirSync(root, { recursive: true }).filter(file => file.endsWith(".md")).map(file => fs.readFileSync(path.join(root, file), "utf8"));
  assert.ok(files.length >= 5);
  for (const text of files) {
    assert.doesNotMatch(text, /\brhe_[a-f0-9]{16}\b|\bR_[A-Za-z0-9]{10,}\b|[\w.+-]+@[\w-]+\.[\w.]+|\b\d{3}-\d{2}-\d{4}\b/);
  }
});

import { assertResearcherCapabilities, verifyResearcherUpstream, RESEARCHER_POLICY_VERSION, RESEARCHER_ALLOWED_TOOLS } from "./member-policy.mjs";

const researcherAttestation = () => ({ features: { servant_researcher_isolation: true }, servant: { researcherPolicy: {
  version: 1, allowedTools: [...RESEARCHER_ALLOWED_TOOLS], terminal: false, files: false, github: false,
  persistentMemory: false, localContext: false, localMedia: false,
} } });

test("researcher constants match the bridge's reviewable policy, and it can never run a shell or read a file", () => {
  const source = JSON.parse(fs.readFileSync(new URL("./researcher-policy.json", import.meta.url), "utf8"));
  assert.equal(RESEARCHER_POLICY_VERSION, source.version);
  assert.deepEqual([...RESEARCHER_ALLOWED_TOOLS].sort(), [...source.allowedTools].sort());
  for (const tool of ["terminal", "process", "read_file", "write_file", "patch", "search_files", "execute_code", "delegate_task",
    "browser_navigate", "memory", "session_search", "skill_manage", "cronjob", "send_message", "mcp"]) {
    assert.ok(!RESEARCHER_ALLOWED_TOOLS.includes(tool), `${tool} must not be allowed`);
  }
  for (const domain of ["github.com", "*.github.com", "githubusercontent.com", "github.io", "ghcr.io"]) {
    assert.ok(source.blockedWebDomains.includes(domain), `${domain} must be blocked`);
  }
});

test("researcher turns need the bridge's own attestation", () => {
  assert.doesNotThrow(() => assertResearcherCapabilities(researcherAttestation()));
  assert.throws(() => assertResearcherCapabilities(attestation()), { code: "researcher_policy_unverified" });   // the member agent doesn't qualify
  for (const field of ["terminal", "files", "github"]) {
    const data = researcherAttestation(); data.servant.researcherPolicy[field] = true;
    assert.throws(() => assertResearcherCapabilities(data), { code: "researcher_policy_unverified" });
  }
  for (const field of ["persistentMemory", "localContext", "localMedia"]) {
    const data = researcherAttestation(); data.servant.researcherPolicy[field] = true;
    assert.throws(() => assertResearcherCapabilities(data));
  }
  const extra = researcherAttestation(); extra.servant.researcherPolicy.allowedTools.push("terminal");
  assert.throws(() => assertResearcherCapabilities(extra), { code: "researcher_policy_unverified" });
  const fewer = researcherAttestation(); fewer.servant.researcherPolicy.allowedTools.pop();
  assert.throws(() => assertResearcherCapabilities(fewer));
});

test("the full agent can't pass as a researcher", async () => {
  const full = { features: { servant_researcher_isolation: false, servant_durable_media_runs: true }, servant: { bridgeVersion: 1 } };
  await assert.rejects(verifyResearcherUpstream({ url: "http://127.0.0.1:8645", key: "k" }, { fetchImpl: async () => Response.json(full) }), { code: "researcher_policy_unverified" });
  await assert.rejects(verifyResearcherUpstream({ url: "https://example.com", key: "k" }, { fetchImpl: async () => Response.json(researcherAttestation()) }), { code: "researcher_policy_unverified" });
  await assert.rejects(verifyResearcherUpstream({ url: "http://127.0.0.1:8646", key: "" }), { code: "researcher_policy_unverified" });
});
