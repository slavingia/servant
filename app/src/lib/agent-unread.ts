type UnreadChat = { unread?: number; archived?: boolean };

// Unread agent replies across your own chats, for the Agent tab badge. Closed
// (archived) chats don't count, matching the app icon badge.
export function agentUnreadTotal(chats: UnreadChat[]) {
  let total = 0;
  for (const chat of chats) {
    if (chat.archived) continue;
    const n = chat.unread;
    if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) total += n;
  }
  return total;
}

export function badgeText(n: number) {
  return n > 0 ? (n > 99 ? "99+" : String(n)) : undefined;
}
