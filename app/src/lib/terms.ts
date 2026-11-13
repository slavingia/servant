// Terms of Service shown before joining. Keep VERSION and the item ids in step
// with server/terms.mjs; the server refuses an acceptance that doesn't match.
export const TERMS_VERSION = "2026-11-11";

export const TERMS_CHECKS = [
  { id: "terms", label: "I agree to the Terms of Service and I'm using Servant for work", detail: "Use Servant for work, follow your organisation's rules, and keep your invite and device secure." },
  { id: "ai", label: "I'm responsible for how I use the agent", detail: "The agent can be wrong. I'll check what it tells me and does before I act on it, and I'm accountable for what I send or do with its help." },
  { id: "sensitive", label: "I won't share personal, confidential or other sensitive information", detail: "Your team's server has not been reviewed for it. That includes anything you wouldn't want a server administrator to read." },
] as const;

export type TermsAcceptance = { version: string; items: string[] };

export const termsAcceptance = (): TermsAcceptance => ({ version: TERMS_VERSION, items: TERMS_CHECKS.map((c) => c.id) });

// Public documents belong to the server being joined, not a previously signed-in
// account. Never pass an invite's query parameters or credentials to the browser.
export function termsLinks(server?: string): { terms: string; privacy: string } | null {
  if (!server) return null;
  try {
    const url = new URL(server);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    return { terms: `${base}/terms`, privacy: `${base}/privacy` };
  } catch { return null; }
}
