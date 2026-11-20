// Sharing a prototype with a business owner (docs/prototype-reviews.md): the words the share sheet shows.
import type { OutsideReviewer, PrototypeComment, PrototypeShare } from "./server.ts";

/** A project's outside reviewers as a person types them: one a line, "name@example.gov, Product owner". */
export const outsideReviewerText = (list: readonly OutsideReviewer[] = []) => list.map(r => (r.label ? `${r.email}, ${r.label}` : r.email)).join("\n");
/** What was typed, as a list: the first thing on a line is the address, the rest (after a comma or a space) is their role. Repeats are dropped. */
export function parseOutsideReviewers(text: string): OutsideReviewer[] {
  const out: OutsideReviewer[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*([^\s,]+)[\s,]*(.*)$/.exec(line);
    if (!match || !match[1]) continue;
    const email = match[1].trim().toLowerCase();
    if (!out.some(r => r.email === email)) out.push({ email, label: match[2]!.replace(/\s+/g, " ").trim() });
  }
  return out;
}
/** One reviewer on a line: "jo.park@example.gov · Product owner". */
export const outsideReviewerLine = (r: OutsideReviewer) => (r.label ? `${r.email} · ${r.label}` : r.email);

/** Where a share stands, in a few words. */
export function shareStatus(share: Pick<PrototypeShare, "verifiedAt" | "endedAt">): string {
  if (share.endedAt) return "Ended";
  return share.verifiedAt ? "Has opened it" : "Hasn't opened it yet";
}
export const commentCount = (n: number) => (n === 1 ? "1 comment" : `${n} comments`);
/** One line under an address: "Has opened it · 2 comments". */
export const shareLine = (share: PrototypeShare) => [shareStatus(share), share.comments.length ? commentCount(share.comments.length) : null].filter(Boolean).join(" · ");
/** Where a comment was made: the words under the pointer and the page, "On “Pay now” · index.html". */
export const commentWhere = (comment: Pick<PrototypeComment, "anchor" | "page">) => [comment.anchor ? `On \u201c${comment.anchor}\u201d` : null, comment.page].filter(Boolean).join(" · ");
/** People still able to open their link first, then those whose share ended; newest first within each. */
export function orderShares<T extends Pick<PrototypeShare, "endedAt" | "createdAt">>(shares: readonly T[]): T[] {
  return [...shares].sort((a, b) => Number(!!a.endedAt) - Number(!!b.endedAt) || b.createdAt - a.createdAt);
}
/** A quick look before sending: the server decides which addresses are allowed. */
export const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/** Every comment on a prototype, oldest first, numbered, with who made it: what the builder's own preview pins. */
export type PinnedComment = PrototypeComment & { email: string; n: number };
export function numberedComments(shares: readonly PrototypeShare[]): PinnedComment[] {
  return shares.flatMap(share => share.comments.map(comment => ({ ...comment, email: share.email })))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map((comment, i) => ({ ...comment, n: i + 1 }));
}
/** The page a prototype's frame says it is on ("/p/<folder>/plans/compare.html"), as comments name it ("plans/compare.html"). */
export function pageOf(pathname: string): string {
  const page = String(pathname || "").replace(/^\/p\/[^/]+\//, "").replace(/[?#].*$/, "");
  return !page || page.endsWith("/") ? `${page}index.html` : page;
}
/** The pins to draw on one page: only comments made there that have a spot. */
export const pinsOn = (comments: readonly PinnedComment[], page: string) =>
  comments.filter(c => c.page === page && typeof c.x === "number" && typeof c.y === "number").map(c => ({ id: c.id, n: c.n, x: c.x as number, y: c.y as number }));
/** The comments nobody has handed to the agent yet, oldest first: what waits above the chat's message box. */
export const waitingComments = (comments: readonly PinnedComment[]) => comments.filter(comment => !comment.askedAt && !comment.setAsideAt);
/** Where a comment stands with the agent, for the share sheet: "Agent was asked" or "Agent started on it by itself"; nothing while it waits. */
export const commentAsked = (comment: Pick<PrototypeComment, "askedAt" | "askedBy" | "setAsideAt">) => comment.askedAt ? (comment.askedBy === "auto" ? "Agent started on it by itself" : "You asked Agent to work on it") : comment.setAsideAt ? "You set it aside" : null;
/** The line above the waiting comments: "1 comment from a reviewer", "3 comments from reviewers". */
export const waitingLine = (n: number) => (n === 1 ? "1 comment from a reviewer" : `${n} comments from reviewers`);
export const AUTO_WORK_LABEL = "Agent starts on their comments by itself";
/** In place of the hint when a comment can't start the agent by itself here: a reviewer is an outsider, so that needs an agent that asks before it acts. */
export const AUTO_WORK_UNCHECKED_HINT = "Not available for you on this server. A reviewer's comment can start Agent by itself only when your Agent has to ask before it reads or changes files. Their comments wait here for you.";
/** Whether a response from the server says comments may start the agent unattended (absent on an older server: yes). */
export const autoWorkAvailable = (response: unknown): boolean => (response as { autoWorkChecked?: unknown } | null)?.autoWorkChecked !== false;
export const AUTO_WORK_HINT = "Each comment this person makes is sent to Agent in this chat as it arrives, and counts toward your agent use. Off, their comments wait here for you.";
/** Under a comment in the builder's preview: who said it and where. */
export const commentBy = (comment: PinnedComment) => [comment.email, commentWhere(comment)].filter(Boolean).join(" · ");
