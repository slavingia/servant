// Explicit contract advertised only by deterministic test upstreams. Production
// obtains this attestation from the repository-owned restricted Hermes bridge.
export const restrictedTestCapabilities = {
  features: { servant_member_isolation: true },
  servant: { memberPolicy: { version: 1, allowedTools: [], persistentMemory: false, localContext: false, localMedia: false } },
};
