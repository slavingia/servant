import { useEffect, useState } from "react";
import { Alert, Keyboard, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Conversation, Post } from "../lib/hub";
import { colors } from "../lib/theme";

export function when(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function Avatar({ name, agent, size = 36 }: { name: string; agent?: boolean; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={[styles.avatar, { width: size, height: size, borderRadius: agent ? size / 2 : 8 }, agent && { backgroundColor: colors.navy }]}
    >
      <Text style={[styles.avatarText, { fontSize: size * 0.4 }]}>{agent ? "AI" : initials || "?"}</Text>
    </View>
  );
}

// Splits text so @mentions stand out.
function Rich({ text, style }: { text: string; style: object }) {
  const parts = text.split(/(@[\w-]+)/g);
  return (
    <Text selectable style={style}>
      {parts.map((p, i) =>
        p.startsWith("@") ? (
          <Text key={i} style={styles.mention}>
            {p}
          </Text>
        ) : (
          p
        ),
      )}
    </Text>
  );
}

type PostProps = {
  post: Post;
  me: string;
  compact?: boolean; // same author as the post above, within five minutes
  onOpenThread?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
};

export function PostRow({ post, me, compact, onOpenThread, onEdit, onDelete }: PostProps) {
  const mine = post.user.id === me;
  const actions = () => {
    if (post.deleted || post.pending) return;
    const options = [
      ...(onOpenThread ? [{ text: "Reply in thread", onPress: onOpenThread }] : []),
      ...(mine && onEdit ? [{ text: "Edit", onPress: onEdit }] : []),
      ...(mine && onDelete ? [{ text: "Delete", style: "destructive" as const, onPress: onDelete }] : []),
    ];
    if (!options.length) return;
    if (Platform.OS === "web") return options[0]!.onPress();
    Alert.alert("Message", undefined, [...options, { text: "Cancel", style: "cancel" }]);
  };
  const label = `${post.user.name}, ${when(post.createdAt)}. ${post.deleted ? "Message deleted" : post.text}${post.replyCount ? `. ${post.replyCount} ${post.replyCount === 1 ? "reply" : "replies"}` : ""}`;
  return (
    <Pressable onLongPress={actions} accessible={!(onOpenThread && post.replyCount > 0)} accessibilityLabel={label} accessibilityHint={onOpenThread || mine ? "Long press to reply in a thread" + (mine ? ", edit or delete" : "") : undefined} style={[styles.post, compact && styles.postCompact]}>
      <View style={styles.gutter}>{compact ? null : <Avatar name={post.user.name} agent={post.user.agent} />}</View>
      <View style={{ flex: 1 }}>
        {compact ? null : (
          <View style={styles.meta}>
            <Text style={styles.author}>{post.user.name}</Text>
            {post.user.agent ? <Text style={styles.agentTag}>Agent</Text> : null}
            <Text style={styles.time}>{when(post.createdAt)}</Text>
          </View>
        )}
        {post.deleted ? (
          <Text style={styles.deleted}>Message deleted</Text>
        ) : post.pending && !post.text ? (
          <Text style={styles.deleted}>Thinking…</Text>
        ) : (
          <Rich text={post.text + (post.editedAt ? " " : "")} style={styles.body} />
        )}
        {post.editedAt && !post.deleted ? <Text style={styles.edited}>Edited</Text> : null}
        {onOpenThread && post.replyCount > 0 ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`${post.replyCount} ${post.replyCount === 1 ? "reply" : "replies"}, open thread`} onPress={onOpenThread} hitSlop={8} style={styles.replies}>
            <Text style={styles.repliesText}>
              {post.replyCount} {post.replyCount === 1 ? "reply" : "replies"}
            </Text>
            {post.lastReplyAt ? <Text style={styles.time}> · {when(post.lastReplyAt)}</Text> : null}
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  );
}

export function Composer({
  placeholder,
  onSend,
  initial = "",
  sendLabel = "Send",
  onCancel,
}: {
  placeholder: string;
  onSend: (text: string) => Promise<boolean>;
  initial?: string;
  sendLabel?: string;
  onCancel?: () => void;
}) {
  const insets = useSafeAreaInsets();
  // The home-indicator inset only applies when the keyboard is down; above the keyboard the
  // composer should sit flush.
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => setKeyboard(true));
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setKeyboard(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setText("");
    const ok = await onSend(body);
    if (!ok) setText(body);
    setBusy(false);
  };
  const off = !text.trim() || busy;
  return (
    <View style={[styles.composer, { paddingBottom: keyboard ? 10 : Math.max(insets.bottom, 10) }]}>
      {onCancel ? (
        <Pressable accessibilityRole="button" onPress={onCancel} style={styles.cancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      ) : null}
      <TextInput
        testID="composer-input"
        accessibilityLabel={placeholder}
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor="#8A8F96"
        multiline
        style={styles.input}
        onSubmitEditing={Platform.OS === "web" ? send : undefined}
        blurOnSubmit={false}
      />
      <Pressable testID="composer-send" accessibilityRole="button" accessibilityState={{ disabled: off }} onPress={send} disabled={off} style={[styles.send, off && { opacity: 0.4 }]}>
        <Text style={styles.sendText}>{sendLabel}</Text>
      </Pressable>
    </View>
  );
}

export function ConversationRow({ c, onPress }: { c: Conversation; onPress: () => void }) {
  const last = c.lastMessage;
  const preview = last ? (last.deleted ? "Message deleted" : `${c.kind === "channel" || (c.members?.length ?? 0) > 2 ? `${last.user.name}: ` : ""}${last.text || "Thinking…"}`) : c.topic || "No messages yet";
  const bold = c.unread > 0;
  const title = c.kind === "channel" ? `#${c.title}` : c.title;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}${c.private && c.kind === "channel" ? ", private" : ""}${bold ? `, ${c.unread} unread` : ""}. ${preview}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}
    >
      {c.kind === "dm" ? <Avatar name={c.title} size={40} /> : null}
      <View style={{ flex: 1, marginLeft: c.kind === "dm" ? 12 : 0 }}>
        <View style={styles.rowTop}>
          <Text style={[styles.rowTitle, bold && styles.bold]} numberOfLines={1}>
            {title}
            {c.private && c.kind === "channel" ? <Text style={styles.lock}>  Private</Text> : null}
          </Text>
          <Text style={styles.time}>{when(c.updatedAt)}</Text>
        </View>
        <View style={styles.rowTop}>
          <Text style={[styles.preview, bold && { color: colors.ink }]} numberOfLines={1}>
            {preview}
          </Text>
          {bold ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{c.unread > 99 ? "99+" : c.unread}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  avatar: { backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" },
  avatarText: { color: colors.white, fontWeight: "700" },
  post: { flexDirection: "row", paddingHorizontal: 16, paddingTop: 10, paddingBottom: 2 },
  postCompact: { paddingTop: 0 },
  gutter: { width: 48 },
  meta: { flexDirection: "row", alignItems: "baseline", marginBottom: 2 },
  author: { fontSize: 16, fontWeight: "700", color: colors.ink },
  agentTag: { marginLeft: 6, fontSize: 12, fontWeight: "700", color: colors.navy, backgroundColor: "#E1E7F1", paddingHorizontal: 5, borderRadius: 4, overflow: "hidden" },
  time: { marginLeft: 8, fontSize: 13, color: colors.muted },
  body: { fontSize: 16, lineHeight: 22, color: colors.ink },
  mention: { color: colors.blue, fontWeight: "600" },
  deleted: { fontSize: 16, color: colors.muted, fontStyle: "italic" },
  edited: { fontSize: 12, color: colors.muted, marginTop: 1 },
  replies: { flexDirection: "row", alignItems: "baseline", marginTop: 4, minHeight: 28 },
  repliesText: { color: colors.blue, fontWeight: "600", fontSize: 15 },
  composer: { flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 20, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, backgroundColor: colors.white },
  input: { flex: 1, minHeight: 44, maxHeight: 140, borderRadius: 22, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 11, fontSize: 17, color: colors.ink, backgroundColor: colors.surface },
  send: { marginLeft: 8, height: 44, paddingHorizontal: 16, borderRadius: 22, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" },
  sendText: { color: colors.white, fontSize: 16, fontWeight: "600" },
  cancel: { height: 44, justifyContent: "center", paddingRight: 8 },
  cancelText: { color: colors.blue, fontSize: 16 },
  row: { minHeight: 68, paddingHorizontal: 20, paddingVertical: 10, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowTitle: { flex: 1, fontSize: 17, color: colors.ink, marginRight: 8 },
  bold: { fontWeight: "700" },
  lock: { fontSize: 13, color: colors.muted, fontWeight: "400" },
  preview: { flex: 1, marginTop: 2, fontSize: 15, color: colors.muted, marginRight: 8 },
  badge: { minWidth: 22, height: 22, borderRadius: 11, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  badgeText: { color: colors.white, fontSize: 13, fontWeight: "700" },
});
