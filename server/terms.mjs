// Terms of Service people agree to before they can join. Bump VERSION whenever
// the text or the three checks change; the app mirrors this in app/src/lib/terms.ts.
export const TERMS_VERSION = "2026-11-03";
export const TERMS_ITEMS = ["terms", "ai", "sensitive"];

// Returns the acceptance to record, or null when it isn't complete and current.
export function validTermsAcceptance(input) {
  if (!input || typeof input !== "object" || input.version !== TERMS_VERSION) return null;
  const items = Array.isArray(input.items) ? input.items : [];
  if (!TERMS_ITEMS.every(item => items.includes(item))) return null;
  return { version: TERMS_VERSION, items: [...TERMS_ITEMS] };
}
