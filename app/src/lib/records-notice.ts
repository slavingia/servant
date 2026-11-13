// When the server keeps records (server/records-preserve.mjs), "delete" hides content from view but does not destroy it. The app
// must not say "permanently deletes" or "can't be undone" in that case: it would be untrue, and for a records setting that matters.
export type DeleteKind = "agent-chat" | "dm" | "channel" | "meeting";

export function deleteDescription(kind: DeleteKind, recordsKept: boolean): string {
  if (kind === "meeting") {
    return recordsKept
      ? "This removes the recording, the notes and the transcript from your list. Your organization keeps a record of recordings for its records policy, so they are not erased. Work already handed to the agent stays in its chat."
      : "The recording, the notes and the transcript are deleted. Work already handed to the agent stays in its chat.";
  }
  if (recordsKept) {
    const what = kind === "agent-chat" ? "your conversation with the agent" : kind === "dm" ? "the conversation and its messages for everyone in it" : "the channel and its messages for everyone";
    return `This removes ${what} from view. Your organization keeps a record of messages for its records policy, so they are not erased.`;
  }
  return kind === "agent-chat"
    ? "This permanently deletes your conversation with the agent and everything in it. This can't be undone."
    : kind === "dm"
      ? "This permanently deletes the conversation and all its messages for everyone in it. This can't be undone."
      : "This permanently deletes the channel and all its messages for everyone. This can't be undone.";
}
