export type Invite = { code: string; hub?: string; discovery?: string };

const CODE = /^[0-9A-Z]{5}-?[0-9A-Z]{5}$/i;

// Accepts a servant://pair?code=…&d=… link (from a QR code, a tap or a paste).
export function parseInvite(input: string): Invite | null {
  const text = input.trim();
  if (!text) return null;
  const match = text.match(/servant:\/\/pair\?[^\s]+/i);
  if (!match) return null;
  const query = match[0].slice(match[0].indexOf("?") + 1);
  const params = new URLSearchParams(query);
  const code = params.get("code") || "";
  if (!CODE.test(code)) return null;
  const hub = params.get("hub") || undefined;
  const discovery = params.get("d") || undefined;
  if (!hub && !discovery) return null;
  if (hub && !/^https?:\/\//.test(hub)) return null;
  if (discovery && !/^https:\/\//.test(discovery)) return null;
  return { code: code.toUpperCase(), hub, discovery };
}
