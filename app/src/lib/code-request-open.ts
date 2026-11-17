// Which code request an open app should bring up by itself (components/CodeRequestOpener.tsx, docs/code-requests.md).
import type { CodeRequest } from "./server";

export const CODE_REQUEST_ID = /^code_[A-Za-z0-9_-]{12}$/;

/** The newest request still waiting that this app has not brought up yet, or null. */
export function codeRequestToOpen(requests: Pick<CodeRequest, "id" | "status" | "createdAt" | "expiresAt">[], shown: ReadonlySet<string>, now: number): string | null {
  const waiting = requests.filter(r => r.status === "pending" && r.expiresAt > now && CODE_REQUEST_ID.test(r.id) && !shown.has(r.id));
  waiting.sort((a, b) => b.createdAt - a.createdAt);
  return waiting[0]?.id ?? null;
}

/** The request id of the Enter code screen at this path, if it is one. */
export function codeRequestAt(pathname: string): string | null {
  const m = /^\/code\/([^/?#]+)$/.exec(pathname);
  return m && CODE_REQUEST_ID.test(m[1]) ? m[1] : null;
}
