// Terms of Service shown before joining. Keep VERSION and the item ids in step
// with server/terms.mjs; the server refuses an acceptance that doesn't match.
export const TERMS_VERSION = "2026-11-03";

export const TERMS_CHECKS = [
  { id: "terms", label: "I agree to the Terms of Service and I'm using Servant for work", detail: "Use Servant only for official work, follow your agency's rules, and keep your invite and device secure." },
  { id: "ai", label: "I'm responsible for how I use the agent", detail: "The agent can be wrong. I'll check what it tells me and does before I act on it, and I'm accountable for what I send or do with its help." },
  { id: "sensitive", label: "I won't share taxpayer or other sensitive information", detail: "Servant isn't approved for it yet. That includes anything I wouldn't be comfortable having reviewed." },
] as const;

export type TermsAcceptance = { version: string; items: string[] };

export const termsAcceptance = (): TermsAcceptance => ({ version: TERMS_VERSION, items: TERMS_CHECKS.map((c) => c.id) });
