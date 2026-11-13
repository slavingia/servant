// Per-instance feature flags (docs/features.md "Features"). An instance that only wants the agent
// turns channels, direct messages and meetings off in config.json:
//   "features": { "channels": false, "directMessages": false, "meetings": false }
// Every flag is on unless its value is exactly `false`, so a config.json that never
// mentions `features` behaves as before. Nothing is deleted when a flag is off; its
// routes answer 404 feature_off and its conversations drop out of lists and
// notifications until the flag is on again.
export const FEATURES = ["channels", "directMessages", "meetings", "secureInbox"];

export function normalizeFeatures(raw) {
  const given = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(FEATURES.map(name => [name, given[name] !== false]));
}

/** The flag that governs a conversation kind ("channel" or "dm"), or null for anything else. */
export const featureForKind = kind => kind === "channel" ? "channels" : kind === "dm" ? "directMessages" : null;

const LABELS = { channels: "channels", directMessages: "direct messages", meetings: "meetings", secureInbox: "the secure inbox" };
export const featureOffMessage = name => `This server doesn't use ${LABELS[name] || name}`;
