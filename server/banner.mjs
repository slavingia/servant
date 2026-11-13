// One server-wide banner (docs/features.md "Banner"). Set it in config.json and every signed-in app shows it
// above the screen, with no build or deploy (the config is read per request):
//   "banner": { "enabled": true, "message": "Do not use this app until cyber acceptance is granted." }
// Remove the key or set enabled to false to turn it off. Plain text only.
export const MAX_BANNER_CHARS = 280;

export function normalizeBanner(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.enabled !== true) return null;
  const message = typeof raw.message === "string" ? raw.message.replace(/\s+/g, " ").trim().slice(0, MAX_BANNER_CHARS) : "";
  return message ? { message } : null;
}
