// Codes from Messages through a Shortcuts automation (docs/code-requests.md). iOS offers a code from a text only in the
// site the text names, so a Login.gov code never reaches Servant's keyboard. An automation on the phone opens
// servant://code?text=<the text, or just the code> when such a text arrives; Servant finds the code in it and answers
// the request that is waiting. The link never makes or reads a request. The text is never sent or kept: only the code
// goes to the server, the same way as a code typed on the Enter code screen.
import { expectedLength } from "./code-autosend.ts";
import type { CodeRequest } from "./server.ts";

/** How long the screen waits for an automation to ask, for a text that arrives before the request. */
export const LINK_WAIT_MS = 60_000;
/** How often it looks while it waits. */
export const LINK_POLL_MS = 2_000;

/** The code a link carries, and the site the text named when it named one. */
export type LinkCode = { code: string; site?: string };

// The last line of a site-bound text, "@login.gov #123456", sometimes followed by "%@other.example".
const BOUND = /(?:^|\s)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\s+#([A-Za-z0-9]{4,12})(?=\s|%|$)/;
const NUMBER = /(?:^|[^0-9A-Za-z])([0-9]{4,8})(?![0-9A-Za-z])/g;

/** The code in a link: the code itself, or the text it came in. Null unless there is exactly one. */
export function codeFromLink(value: unknown): LinkCode | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || raw.length > 2000) return null;
  const text = raw.trim();
  // Just the code, perhaps in groups of digits as people type them ("554 100", "554-100").
  if (/^[A-Za-z0-9]{4,12}$/.test(text)) return { code: text };
  if (/^[0-9]+(?:[ -][0-9]+)+$/.test(text)) {
    const code = text.replace(/[ -]/g, "");
    return code.length >= 4 && code.length <= 12 ? { code } : null;
  }
  // A whole text. A site-bound last line names the code outright.
  const bound = text.match(BOUND);
  if (bound) return { code: bound[2]!, site: bound[1]!.toLowerCase() };
  // Otherwise the one number in it: a six-digit one when there is exactly one, or the only number of 4 to 8 digits.
  const numbers = [...new Set([...text.matchAll(NUMBER)].map(match => match[1]!))];
  const six = numbers.filter(number => number.length === 6);
  const code = six.length === 1 ? six[0] : numbers.length === 1 ? numbers[0] : undefined;
  return code ? { code } : null;
}

/** The address the router is given for a code link: only the code (and the site it is for) goes on from the text. */
const CODE_LINK = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^/?#]*\/--)?\/*code\/?(\?[^#]*)?(?:#.*)?$/i;

/**
 * servant://code?text=… rewritten before the router sees it (+native-intent.tsx). The router decodes a link's
 * query twice and does not encode it again, which breaks a text with "#" or "&" in it; and the text, with whatever
 * else the message said, should go no further than this. Null for any other address. Never throws.
 */
export function codeLinkPath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const match = path.trim().match(CODE_LINK);
  if (!match) return null;
  let params: URLSearchParams;
  try { params = new URLSearchParams(match[1] ?? ""); } catch { return "/code?invalid=1"; }
  const found = codeFromLink(params.get("text") ?? params.get("code"));
  if (!found) return "/code?invalid=1";
  return `/code?${new URLSearchParams(found.site ? { code: found.code, site: found.site } : { code: found.code })}`;
}

/** The code on the screen, from the router's parameters: a rewritten link, or ?text= in a browser. */
export function codeFromParams(params: { text?: unknown; code?: unknown; site?: unknown }): LinkCode | null {
  const found = codeFromLink(params.text ?? params.code);
  const site = Array.isArray(params.site) ? params.site[0] : params.site;
  if (!found || found.site || typeof site !== "string" || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(site)) return found;
  return { ...found, site: site.toLowerCase() };
}

/** "6-digit code" or "8-character code", and where it is from when the text said. */
export function describeCode(found: LinkCode): string {
  const kind = /^\d+$/.test(found.code) ? "digit" : "character";
  return `${found.code.length}-${kind} code${found.site ? ` for ${found.site}` : ""}`;
}

/** A code fits a request that said how many characters to expect only when it has that many. */
export function fitsRequest(request: Pick<CodeRequest, "length">, code: string): boolean {
  const expected = expectedLength(request.length);
  return expected === null || code.length === expected;
}

export type LinkPlan =
  | { kind: "wait" }
  | { kind: "send"; request: CodeRequest }
  | { kind: "length"; request: CodeRequest; got: number }
  | { kind: "choose"; requests: CodeRequest[] };

/**
 * What to do with a code from a link, given the requests waiting. It is sent by itself only when exactly one is
 * waiting and the code fits it; with several, the person picks. With none, the automation may not have asked yet.
 */
export function planLink(requests: readonly CodeRequest[], code: string): LinkPlan {
  const waiting = requests.filter(request => request.status === "pending");
  if (!waiting.length) return { kind: "wait" };
  if (waiting.length > 1) return { kind: "choose", requests: waiting };
  const request = waiting[0]!;
  return fitsRequest(request, code) ? { kind: "send", request } : { kind: "length", request, got: code.length };
}
