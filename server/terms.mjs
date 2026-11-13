// Terms of Service people agree to before they can join. Bump VERSION whenever
// the text or the three checks change; the app mirrors this in app/src/lib/terms.ts.
export const TERMS_VERSION = "2026-11-11";
export const TERMS_ITEMS = ["terms", "ai", "sensitive"];
// Older distributed clients show the original, stricter workplace wording.
// Keep accepting it and record its actual version; never relabel old consent.
const SUPPORTED_VERSIONS = new Set([TERMS_VERSION, "2026-11-03"]);

// Returns the acceptance to record, or null when it isn't complete and supported.
export function validTermsAcceptance(input) {
  if (!input || typeof input !== "object" || !SUPPORTED_VERSIONS.has(input.version)) return null;
  const items = Array.isArray(input.items) ? input.items : [];
  if (!TERMS_ITEMS.every(item => items.includes(item))) return null;
  return { version: input.version, items: [...TERMS_ITEMS] };
}
