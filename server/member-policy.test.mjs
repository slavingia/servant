import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertMemberCapabilities, verifyMemberUpstream, MEMBER_POLICY_VERSION, MEMBER_ALLOWED_TOOLS } from "./member-policy.mjs";
import { createMemberProfile } from "../scripts/member-profile.mjs";

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
