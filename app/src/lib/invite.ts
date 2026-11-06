export type Invite = { code: string; server?: string; discovery?: string; serverKey?: string };

const CODE = /^[0-9A-Z]{5}-?[0-9A-Z]{5}$/i;

// Accepts an ordinary servant://pair link or this client's servant-ux://pair
// link (from a QR code, a tap or a paste).
export function parseInvite(input: string): Invite | null {
  const text = input.trim();
  if (!text) return null;
  // Native links and the web form use the same parameters.
  const match = text.match(/servant(?:-ux)?:\/\/pair\?[^\s]+/i) || text.match(/https:\/\/[^\s/?#]+\/join\?[^\s]+/i);
  if (!match) return null;
  const query = match[0].slice(match[0].indexOf("?") + 1);
  const params = new URLSearchParams(query);
  const code = params.get("code") || "";
  if (!CODE.test(code)) return null;
  // "hub" is the link parameter older servers write; keep reading it.
  const server = params.get("server") || params.get("hub") || undefined;
  const discovery = params.get("d") || undefined;
  if (!server && !discovery) return null;
  if (server && !/^https?:\/\//.test(server)) return null;
  if (discovery && !/^https:\/\//.test(discovery)) return null;
  const serverKey = params.get("key") || undefined;
  if (serverKey && !/^(02|03)[0-9a-f]{64}$/.test(serverKey)) return null;
  return { ...(serverKey ? { serverKey } : {}), code: code.toUpperCase(), server, discovery };
}
