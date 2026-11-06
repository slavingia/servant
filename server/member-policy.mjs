// Keep runtime imports self-contained: the deployer stages executable modules.
// Tests cross-check these constants against the reviewable bridge policy JSON.
export const MEMBER_POLICY_VERSION = 1;
export const MEMBER_ALLOWED_TOOLS = Object.freeze([]);

// This is a bridge attestation, not a claim inferred from a model's answer or
// /v1/toolsets (which omits some implicit toolsets in supported Hermes versions).
export function assertMemberCapabilities(capabilities) {
  const isolation = capabilities?.servant?.memberPolicy;
  if (capabilities?.features?.servant_member_isolation !== true
      || isolation?.version !== MEMBER_POLICY_VERSION
      || isolation?.persistentMemory !== false
      || isolation?.localContext !== false
      || isolation?.localMedia !== false
      || !Array.isArray(isolation?.allowedTools)
      || isolation.allowedTools.length !== 0) {
    const error = new Error("The member agent needs the Servant restricted bridge. Run scripts/run-hermes-servant.py --member with the checked-in member profile.");
    error.code = "member_policy_unverified";
    error.status = 503;
    throw error;
  }
}

export async function verifyMemberUpstream(upstream, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!upstream?.key) throw Object.assign(new Error("The member agent requires its own API key."), { code: "member_policy_unverified", status: 503 });
  const url = new URL(upstream.url);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw Object.assign(new Error("The member agent must use an authenticated loopback bridge."), { code: "member_policy_unverified", status: 503 });
  }
  try {
    const response = await fetchImpl(new URL("/v1/capabilities", url), {
      headers: { authorization: `Bearer ${upstream.key}` },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error("Unavailable capabilities");
    const capabilities = await response.json();
    assertMemberCapabilities(capabilities);
    return capabilities;
  } catch (error) {
    if (error.code === "member_policy_unverified") throw error;
    throw Object.assign(new Error("The member agent policy could not be verified."), { code: "member_policy_unverified", status: 503 });
  }
}

// The researcher bridge (tier 4): web, search, vision, read-only skills and planning, and nothing that can
// run a shell or touch a file, so gh and git are impossible. Constants are cross-checked against
// researcher-policy.json by the tests, because the deployer stages only executable modules.
export const RESEARCHER_POLICY_VERSION = 1;
export const RESEARCHER_ALLOWED_TOOLS = Object.freeze([
  "clarify", "skill_view", "skills_list", "todo", "vision_analyze", "web_extract", "web_search",
]);

export function assertResearcherCapabilities(capabilities) {
  const policy = capabilities?.servant?.researcherPolicy;
  const tools = Array.isArray(policy?.allowedTools) ? [...policy.allowedTools].sort() : null;
  if (capabilities?.features?.servant_researcher_isolation !== true
      || policy?.version !== RESEARCHER_POLICY_VERSION
      || policy?.terminal !== false || policy?.files !== false || policy?.github !== false
      || policy?.persistentMemory !== false || policy?.localContext !== false || policy?.localMedia !== false
      || !tools || tools.length !== RESEARCHER_ALLOWED_TOOLS.length
      || tools.some((tool, i) => tool !== RESEARCHER_ALLOWED_TOOLS[i])) {
    const error = new Error("The researcher agent needs the Servant researcher bridge. Run scripts/run-hermes-servant.py --researcher with the checked-in researcher profile.");
    error.code = "researcher_policy_unverified";
    error.status = 503;
    throw error;
  }
}

export async function verifyResearcherUpstream(upstream, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!upstream?.key) throw Object.assign(new Error("The researcher agent requires its own API key."), { code: "researcher_policy_unverified", status: 503 });
  const url = new URL(upstream.url);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw Object.assign(new Error("The researcher agent must use an authenticated loopback bridge."), { code: "researcher_policy_unverified", status: 503 });
  }
  try {
    const response = await fetchImpl(new URL("/v1/capabilities", url), {
      headers: { authorization: `Bearer ${upstream.key}` }, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error("Unavailable capabilities");
    const capabilities = await response.json();
    assertResearcherCapabilities(capabilities);
    return capabilities;
  } catch (error) {
    if (error?.code === "researcher_policy_unverified") throw error;
    throw Object.assign(new Error("The researcher agent could not be verified."), { code: "researcher_policy_unverified", status: 503 });
  }
}
