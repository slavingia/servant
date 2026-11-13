// The server-wide banner (server/banner.mjs): one line of plain text the operator sets in config.json.
// Anything that is not a non-empty string message means no banner.
export type Banner = { message: string };

export function bannerFromServer(raw: unknown): Banner | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const message = (raw as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? { message: message.trim() } : undefined;
}

/** True when this device hid this exact message; a new message shows again. */
export const isBannerHidden = (message: string, hiddenMessage: string | null) => hiddenMessage === message;
