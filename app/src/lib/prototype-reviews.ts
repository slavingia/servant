// Sharing a prototype with a business owner (docs/prototype-reviews.md): the words the share sheet shows.
import type { PrototypeComment, PrototypeShare } from "./server.ts";

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
