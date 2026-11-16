export type MessagePoster = { id: string; name: string };

/** The person shown on a user message. The server names the poster only when it was not the chat's author (the
 * workspace owner jumping into a shared chat); every other message belongs to `fallback`, the chat's author. */
export function parsePoster(value: unknown): MessagePoster | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { id, name } = value as { id?: unknown; name?: unknown };
  return typeof id === "string" && id && typeof name === "string" && name ? { id, name } : undefined;
}

export function messagePerson(message: { postedBy?: unknown }, fallback: MessagePoster | { id?: string; name: string }): { id?: string; name: string } {
  return parsePoster(message.postedBy) ?? fallback;
}
