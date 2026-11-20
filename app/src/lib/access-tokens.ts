// Personal access tokens (docs/access-tokens.md): the words the Access tokens screen shows. The server decides
// everything; this says it plainly.
export type AccessToken = { id: string; name: string; hint: string; createdAt: number; expiresAt: number; lastUsedAt?: number; revokedAt?: number; state: "active" | "expired" | "revoked" };
export type AccessTokensPage = { enabled: boolean; tokens: AccessToken[]; defaultDays: number; address: string | null };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (at: number, now: number) => { const d = new Date(at); return `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() === new Date(now).getFullYear() ? "" : `, ${d.getFullYear()}`}`; };

/** Where a token stands, in a line: "Ends Feb 18 · last used Nov 20", "Expired Nov 2", "Revoked Nov 20". */
export function tokenLine(token: AccessToken, now = Date.now()): string {
  if (token.state === "revoked") return `Revoked ${day(token.revokedAt ?? now, now)}`;
  if (token.state === "expired") return `Expired ${day(token.expiresAt, now)}`;
  return `Ends ${day(token.expiresAt, now)} · ${token.lastUsedAt ? `last used ${day(token.lastUsedAt, now)}` : "never used"}`;
}
/** Live tokens first, newest first; then the ones that no longer work. */
export const orderTokens = (tokens: readonly AccessToken[]) => [...tokens].sort((a, b) => Number(a.state !== "active") - Number(b.state !== "active") || b.createdAt - a.createdAt);

/** How long a new token lasts: the choices offered, in days. */
export const TOKEN_DAYS = [7, 30, 90, 365] as const;
export const daysLabel = (days: number) => days === 7 ? "1 week" : days === 365 ? "1 year" : `${days} days`;

/** What to do with a token that was just made, for a shell where nothing can be installed. */
export function shellSetup(address: string | null, token: string): string {
  return [`$env:SERVANT_TOKEN = "${token}"`, `$Servant = "${address ?? "https://your-server/api/v1"}"`, `$Headers = @{ Authorization = "Bearer $env:SERVANT_TOKEN" }`, `Invoke-RestMethod "$Servant/me" -Headers $Headers`].join("\n");
}
export const OFF_LINE = "This server doesn't use access tokens yet. An owner can turn them on in the server's config.json.";
export const WHAT_LINE = "A token lets a script or a shell act as you, without the app: see prototypes, send one for review, and message your agent. It can't read channels, direct messages or cases. Keep it like a password.";
