// Explicit contract advertised only by deterministic test upstreams. Production
// obtains this attestation from the repository-owned restricted Hermes bridge.
export const restrictedTestCapabilities = {
  features: { servant_member_isolation: true },
  servant: { memberPolicy: { version: 1, allowedTools: [], persistentMemory: false, localContext: false, localMedia: false } },
};

// What the researcher bridge attests: web, search, vision and read-only skills, no shell, no files, no GitHub.
export const researcherTestCapabilities = {
  features: { servant_researcher_isolation: true, servant_durable_media_runs: false },
  servant: { researcherPolicy: {
    version: 1,
    allowedTools: ["clarify", "skill_view", "skills_list", "todo", "vision_analyze", "web_extract", "web_search"],
    terminal: false, files: false, github: false, persistentMemory: false, localContext: false, localMedia: false,
  } },
};
