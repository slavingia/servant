import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AppIcon } from "./AppIcon";
import { Button } from "./Button";
import { api, ServerError, type Account } from "../lib/server";
import { commentBy, waitingLine, type PinnedComment } from "../lib/prototype-reviews";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

// What reviewers said about this chat's prototype, waiting above the message box until the person whose chat it is
// decides (docs/prototype-reviews.md). "Ask Agent to work on this" sends the comment to Agent as a message in this
// chat; from then on it is in the conversation like any other, and leaves this list. The newest shows; the rest
// open from the line above it.
export function ReviewComments({ account, chatId, comments, onAsked }: {
  account: Account; chatId: string;
  /** The comments nobody has handed to Agent yet, oldest first. */
  comments: readonly PinnedComment[];
  /** A comment was handed over: the chat has a new message and the list is out of date. */
  onAsked: (commentId: string) => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (!comments.length) return null;
  const ask = async (comment: PinnedComment) => {
    if (busy) return;
    setBusy(comment.id); setError("");
    try { await api.workOnPrototypeComment(account, chatId, comment.id); onAsked(comment.id); }
    catch (reason) { setError(reason instanceof ServerError ? reason.message : "Couldn't ask Agent. Try again."); }
    finally { setBusy(null); }
  };
  const shown = open ? comments : comments.slice(-1);
  return <View testID="review-comments" style={styles.box}>
    {comments.length > 1
      ? <Pressable testID="review-comments-toggle" accessibilityRole="button" accessibilityLabel={`${waitingLine(comments.length)}. ${open ? "Show only the newest" : "Show all"}`} accessibilityState={{ expanded: open }} aria-expanded={open}
          onPress={() => setOpen(value => !value)} style={styles.head}>
          <Text style={styles.count}>{waitingLine(comments.length)}</Text>
          <AppIcon name={open ? "chevronDown" : "chevronRight"} size={16} color={colors.muted} />
        </Pressable>
      : <Text style={[styles.count, styles.single]}>{waitingLine(1)}</Text>}
    {shown.map(comment => <View key={comment.id} testID={`review-comment-${comment.id}`} style={styles.comment}>
      <Text style={styles.by}>{commentBy(comment)}</Text>
      <Text selectable style={styles.text}>{comment.text}</Text>
      <View style={styles.actions}>
        <Button testID={`review-work-${comment.id}`} label="Ask Agent to work on this" accessibilityLabel={`Ask Agent to work on ${comment.email}'s comment: ${comment.text.slice(0, 80)}`} kind="secondary" compact busy={busy === comment.id} disabled={!!busy} onPress={() => void ask(comment)} />
      </View>
    </View>)}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  box: { marginHorizontal: space.side, marginBottom: space.xs, padding: space.sm, borderRadius: radius.md, backgroundColor: colors.surface, gap: space.xs },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 },
  count: { ...typography.label, color: colors.muted },
  single: { paddingVertical: space.xxs },
  comment: { gap: space.xxs, paddingLeft: space.sm, borderLeftWidth: 2, borderLeftColor: colors.line },
  by: { ...typography.caption, color: colors.muted },
  text: { ...typography.body, color: colors.ink },
  actions: { flexDirection: "row" },
  error: { ...typography.caption, color: colors.red },
}));
