/** Hermes inserts a compacted-context message when a chat outgrows the model; it is bookkeeping, not part of the conversation. */
export const isContextSummary = (text: string | undefined) => /END OF CONTEXT SUMMARY/i.test(text || "");

/** Drop compacted-context messages so the chat shows only what people and the agent actually said. */
export function withoutContextSummaries<T extends { text?: string }>(messages: readonly T[]): T[] {
  return messages.filter(message => !isContextSummary(message.text));
}
