import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { ActivityIndicator, Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type PressableProps } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Conversation, Person, Post, Upload } from "../lib/server";
import { activeMention, insertMention, mentionMatches, mentionText } from "../lib/mentions";
import type { MessageReceipt } from "../lib/message-status";
import { validateAttachmentSelection } from "../lib/media";
import { Attachments, DraftAttachments, pickAttachments, type DraftAttachment } from "./Attachments";
import { AppIcon } from "./AppIcon";
import { MessageText } from "./MessageText";
import { avatarTones, colors, radius, space, typography } from "../lib/theme";

export function when(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function Avatar({ name, agent, size = 34 }: { name: string; agent?: boolean; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  const tone = avatarTones[Array.from(name).reduce((hash, letter) => (hash * 31 + letter.codePointAt(0)!) >>> 0, 0) % avatarTones.length]!;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={[styles.avatar, { width: size, height: size, borderRadius: radius.sm, backgroundColor: agent ? colors.navy : tone.background }]}
    >
      <Text style={[styles.avatarText, { fontSize: size * 0.4, color: agent ? colors.white : tone.foreground }]}>{agent ? "AI" : initials || "?"}</Text>
    </View>
  );
}

export function MessageDate({ at }: { at: number }) {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const label = date.toDateString() === today.toDateString() ? "Today"
    : date.toDateString() === yesterday.toDateString() ? "Yesterday"
    : date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}) });
  return <View accessibilityRole="header" style={styles.dateSeparator}>
    <View style={styles.dateLine} />
    <Text style={styles.dateLabel}>{label}</Text>
    <View style={styles.dateLine} />
  </View>;
}

// Splits text so @mentions stand out.
function Rich({ text, style }: { text: string; style: object }) {
  const parts = text.split(/(@[\p{L}\p{M}\p{N}_’'.-]+)/gu);
  return (
    <Text selectable={Platform.OS === "web"} style={style}>
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
  receipt?: MessageReceipt;
  compact?: boolean; // same author as the post above, within five minutes
  onOpenThread?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onReact?: (emoji: string, active: boolean) => Promise<void>;
};

const REACTIONS = [
  ["👍", "Like"], ["❤️", "Love"], ["😂", "Laugh"], ["😮", "Surprised"],
  ["😢", "Sad"], ["🙏", "Thanks"], ["🎉", "Celebrate"], ["✅", "Done"],
  ["👀", "Looking"], ["🔥", "Fire"], ["👏", "Applause"], ["💯", "Hundred"],
];

export function PostRow({ post, me, receipt, compact, onOpenThread, onEdit, onDelete, onReact }: PostProps) {
  const [menu, setMenu] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [copying, setCopying] = useState(false);
  const [busy, setBusy] = useState(false);
  const reacting = useRef(false);
  const insets = useSafeAreaInsets();
  const available = !post.deleted && !post.pending && !post.activity;
  const reactions = post.reactions ?? [];
  const choose = async (emoji: string) => {
    if (!onReact || !available || reacting.current) return;
    reacting.current = true;
    setBusy(true);
    setMenu(false);
    try { await onReact(emoji, !reactions.some(r => r.emoji === emoji && r.userIds.includes(me))); }
    finally { reacting.current = false; setBusy(false); }
  };
  const copy = async () => {
    if (!available || !post.text || copying) return;
    setCopying(true);
    try {
      const copied = await Clipboard.setStringAsync(post.text);
      setCopyStatus(copied ? "Copied" : "Couldn't copy. Select the text below to copy it.");
    } catch {
      setCopyStatus("Couldn't copy. Select the text below to copy it.");
    } finally {
      setCopying(false);
    }
  };
  if (post.activity) return (
    <View accessible accessibilityLabel={`${post.text}, ${when(post.createdAt)}`} style={styles.activity}>
      <Text style={styles.activityText}>{post.text} · {when(post.createdAt)}</Text>
    </View>
  );
  const mine = post.user.id === me;
  const options = [
    ...(onOpenThread ? [{ text: "Reply in thread", onPress: onOpenThread }] : []),
    ...(mine && onEdit ? [{ text: "Edit", onPress: onEdit }] : []),
    ...(mine && onDelete ? [{ text: "Delete", onPress: onDelete }] : []),
  ];
  const actions = () => {
    if (!available || (!post.text && !onReact && !options.length)) return;
    Keyboard.dismiss();
    setCopyStatus("");
    setSelecting(false);
    setMenu(true);
    if (Platform.OS !== "web") void Haptics.selectionAsync().catch(() => {});
  };
  const label = `${post.user.name}, ${when(post.createdAt)}. ${post.deleted ? "Message deleted" : post.text}${post.replyCount ? `. ${post.replyCount} ${post.replyCount === 1 ? "reply" : "replies"}` : ""}`;
  return (
    <>
    <Pressable onLongPress={actions} delayLongPress={400} accessible={false} style={[styles.post, compact && styles.postCompact, menu && { backgroundColor: colors.surface }]}>
      <View style={styles.gutter}>{compact ? null : <Avatar name={post.user.name} agent={post.user.agent} />}</View>
      <View style={styles.postContent}>
        <View accessible accessibilityLabel={label} accessibilityHint={available ? "Touch and hold to copy, select text, react or open message actions" : undefined} accessibilityActions={available ? [{ name: "activate", label: "Copy, react or open message actions" }] : undefined} onAccessibilityAction={actions}>
        {compact ? null : (
          <View style={styles.meta}>
            <Text style={styles.author}>{post.user.name}</Text>
            {post.user.agent ? <Text style={styles.agentTag}>Agent</Text> : null}
            <Text style={styles.time}>{when(post.createdAt)}</Text>
          </View>
        )}
        {post.deleted ? (
          <Text style={styles.deleted}>Message deleted</Text>
        ) : post.pending && !post.text && !post.attachments?.length ? (
          <Text style={styles.deleted}>Thinking…</Text>
        ) : post.text ? (
          post.user.agent ? <MessageText text={post.text} /> : <Rich text={post.text + (post.editedAt ? " " : "")} style={styles.body} />
        ) : null}
        {post.editedAt && !post.deleted ? <Text style={styles.edited}>Edited</Text> : null}
        </View>
        {!post.deleted && post.attachments?.length ? <Attachments files={post.attachments} /> : null}
        {available && reactions.length > 0 ? <View style={styles.reactions}>
          {reactions.map(r => {
            const selected = r.userIds.includes(me);
            return <Pressable key={r.emoji} accessibilityRole="button" accessibilityLabel={`${r.emoji}, ${r.userIds.length} reactions${selected ? ", including you. Remove reaction" : ". Add reaction"}`} accessibilityState={{ selected, disabled: busy || !onReact }} disabled={busy || !onReact} onPress={() => choose(r.emoji)} style={styles.reaction}>
              <View style={[styles.reactionPill, selected && styles.selectedReaction]}><Text style={styles.reactionText}>{r.emoji} {r.userIds.length}</Text></View>
            </Pressable>;
          })}
        </View> : null}
        {available && Platform.OS === "web" ? <Pressable accessibilityRole="button" accessibilityLabel={`Actions for ${post.user.name}'s message`} onPress={actions} style={styles.more}><Text style={styles.moreText}>•••</Text></Pressable> : null}
        {onOpenThread && post.replyCount > 0 ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`${post.replyCount} ${post.replyCount === 1 ? "reply" : "replies"}, open thread`} onPress={onOpenThread} hitSlop={8} style={styles.replies}>
            <Text style={styles.repliesText}>
              {post.replyCount} {post.replyCount === 1 ? "reply" : "replies"}
            </Text>
            {post.lastReplyAt ? <Text style={styles.time}> · {when(post.lastReplyAt)}</Text> : null}
          </Pressable>
        ) : null}
        {receipt ? <View testID={`message-receipt-${post.id}`} accessible accessibilityRole="image" accessibilityLabel={receipt === "seen" ? "Seen" : "Sent"} style={styles.receipt}>
          <AppIcon name={receipt === "seen" ? "eye" : "check"} size={14} color={receipt === "seen" ? colors.blueDark : colors.muted} />
        </View> : null}
      </View>
    </Pressable>
    {menu && available ? <Modal transparent animationType="fade" visible onRequestClose={() => setMenu(false)}>
      <View style={[styles.menuOverlay, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="Dismiss message actions" onPress={() => setMenu(false)} />
        <View accessibilityViewIsModal style={styles.menuCard}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={styles.menuAuthor}>{post.user.name}</Text>
            {post.text ? <>
              <Pressable testID="message-copy" accessibilityRole="button" accessibilityLabel="Copy message" accessibilityState={{ disabled: copying }} disabled={copying} onPress={copy} style={styles.menuAction}>
                <Text style={styles.menuActionText}>{copying ? "Copying…" : "Copy"}</Text>
              </Pressable>
              {copyStatus ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.copyStatus}>{copyStatus}</Text> : null}
              <Pressable testID="message-select-text" accessibilityRole="button" onPress={() => setSelecting(!selecting)} style={styles.menuAction}>
                <Text style={styles.menuActionText}>{selecting ? "Back to message actions" : "Select text"}</Text>
              </Pressable>
              {selecting ? <Text style={styles.copyStatus}>Touch and hold a word, then drag the selection handles to copy part of this message.</Text> : null}
              <Text key={selecting ? "full-text" : "preview"} testID="message-selectable-text" selectable={selecting} numberOfLines={selecting ? undefined : 4} style={styles.menuPreview}>{post.text}</Text>
            </> : null}
            {onReact && !selecting ? <>
              <Text style={styles.menuTitle}>React</Text>
              <View style={styles.emojiGrid}>{REACTIONS.map(([emoji, name]) => {
                const selected = reactions.some(r => r.emoji === emoji && r.userIds.includes(me));
                return <Pressable key={emoji} accessibilityRole="button" accessibilityLabel={`${selected ? "Remove" : "Add"} ${name} reaction`} accessibilityState={{ selected, disabled: busy }} disabled={busy} onPress={() => choose(emoji!)} style={[styles.emojiButton, selected && styles.selectedReaction]}><Text style={styles.emoji}>{emoji}</Text></Pressable>;
              })}</View>
            </> : null}
            {!selecting && options.map(option => <Pressable key={option.text} accessibilityRole="button" onPress={() => { setMenu(false); option.onPress(); }} style={styles.menuAction}><Text style={[styles.menuActionText, option.text === "Delete" && { color: colors.red }]}>{option.text}</Text></Pressable>)}
            <Pressable accessibilityRole="button" onPress={() => setMenu(false)} style={styles.menuAction}><Text style={styles.menuActionText}>Cancel</Text></Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal> : null}
    </>
  );
}

export function Composer({
  placeholder,
  onSend,
  initial = "",
  sendLabel = "Send",
  onCancel,
  onTyping,
  members = [],
  me = "",
  autoFocus = false,
  allowAttachments = true,
  allowFileAttachments = true,
  clearOnSend = false,
}: {
  placeholder: string;
  onSend: (text: string, attachments?: Upload[]) => Promise<boolean>;
  initial?: string;
  sendLabel?: string;
  onCancel?: () => void;
  members?: Person[];
  me?: string;
  autoFocus?: boolean;
  allowAttachments?: boolean;
  allowFileAttachments?: boolean;
  // Long agent replies should leave the input free for the next draft.
  clearOnSend?: boolean;
  onTyping?: (text: string) => void;
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
  const [files, setFiles] = useState<DraftAttachment[]>([]);
  const [picking, setPicking] = useState(false);
  const [attachmentMenu, setAttachmentMenu] = useState(false);
  const [fileError, setFileError] = useState("");
  const sending = useRef(false);
  const pick = async (photos: boolean) => {
    if (picking || busy) return;
    setPicking(true);
    setFileError("");
    try {
      const added = await pickAttachments(photos, files);
      const next = [...files, ...added];
      validateAttachmentSelection(next);
      setFiles(next);
      setAttachmentMenu(false);
    } catch (e) { setFileError(e instanceof Error ? e.message : "Couldn't select files"); }
    finally { setPicking(false); }
  };
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [selection, setSelection] = useState({ start: initial.length, end: initial.length });
  const [insertedSelection, setInsertedSelection] = useState<{ start: number; end: number }>();
  const [focused, setFocused] = useState(false);
  const match = focused && !busy ? activeMention(text, selection) : null;
  const suggestions = match ? mentionMatches(members, me, match.query) : [];
  const choose = (person: Person) => {
    if (!match) return;
    const next = insertMention(text, match, person.name);
    setText(next.text);
    onTyping?.(next.text);
    const caret = { start: next.cursor, end: next.cursor };
    setSelection(caret);
    setInsertedSelection(caret);
    input.current?.focus();
  };
  const send = async () => {
    const body = text.trim();
    if ((!body && !files.length) || sending.current || picking) return;
    sending.current = true;
    setBusy(true);
    setFileError("");
    if (clearOnSend) setText("");
    try {
      const ok = await onSend(body, files.map(({ name, data }) => ({ name, data })));
      if (ok) { if (!clearOnSend) setText(""); setFiles([]); setInsertedSelection(undefined); }
      else if (clearOnSend) setText(current => current || body);
    } catch {
      if (clearOnSend) setText(current => current || body);
      setFileError("Couldn't send. Your draft is saved here; try again");
    }
    finally { sending.current = false; setBusy(false); }
  };
  const off = (!text.trim() && !files.length) || busy || picking;
  return (
    <View style={[styles.composerWrap, { paddingBottom: keyboard ? space.xs : Math.max(insets.bottom, space.xs) }]}>
      {fileError ? <Text accessibilityRole="alert" style={styles.composerError}>{fileError}</Text> : null}
      {match ? (
        <ScrollView keyboardShouldPersistTaps="always" style={styles.suggestions} accessibilityLabel="Mention suggestions">
          {suggestions.length ? suggestions.map(person => (
            <Pressable key={person.id} testID={`mention-${person.id}`} accessibilityRole="button" accessibilityLabel={`Mention ${person.name}`} onPress={() => choose(person)} style={({ pressed }) => [styles.suggestion, pressed && { backgroundColor: colors.surface }]}>
              <Avatar name={person.name} size={30} />
              <View style={{ flex: 1, marginLeft: space.sm }}><Text style={styles.suggestionName}>{person.name}</Text><Text style={styles.suggestionHandle}>{mentionText(person.name)}</Text></View>
            </Pressable>
          )) : <Text style={styles.noSuggestions}>No matching members in this conversation</Text>}
        </ScrollView>
      ) : null}
      <View style={[styles.composer, focused && styles.composerFocused]}>
        {onCancel ? <Text style={styles.editingLabel}>Editing message</Text> : null}
        <TextInput
          editable={!busy || clearOnSend}
          ref={input}
          autoFocus={autoFocus}
          testID="composer-input"
          accessibilityLabel={placeholder}
          value={text}
          onChangeText={(t) => {
            setText(t);
            setInsertedSelection(undefined);
            onTyping?.(t);
          }}
          selection={insertedSelection}
          onSelectionChange={({ nativeEvent }) => setSelection(nativeEvent.selection)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          placeholderTextColor={colors.muted}
          multiline
          style={styles.input}
          onSubmitEditing={Platform.OS === "web" ? send : undefined}
          blurOnSubmit={false}
        />
        {files.length ? <DraftAttachments files={files} disabled={busy || picking} onRemove={i => setFiles(old => old.filter((_, index) => index !== i))} /> : null}
        {!onCancel && allowAttachments && attachmentMenu ? <View style={styles.attachmentMenu}>
          <Pressable accessibilityRole="button" accessibilityLabel="Attach photos or videos" accessibilityState={{ disabled: busy || picking }} disabled={busy || picking} onPress={() => pick(true)} style={styles.attachmentChoice}>
            <AppIcon name="plus" size={18} color={colors.ink} /><Text style={styles.attachmentText}>Photos & videos</Text>
          </Pressable>
          {allowFileAttachments ? <Pressable accessibilityRole="button" accessibilityLabel="Attach files" accessibilityState={{ disabled: busy || picking }} disabled={busy || picking} onPress={() => pick(false)} style={styles.attachmentChoice}>
            <AppIcon name="paperclip" size={18} color={colors.ink} /><Text style={styles.attachmentText}>Files</Text>
          </Pressable> : null}
        </View> : null}
        <View style={styles.composerToolbar}>
          {onCancel ? <Pressable accessibilityRole="button" onPress={onCancel} style={styles.cancel}><Text style={styles.cancelText}>Cancel</Text></Pressable>
            : allowAttachments ? <Pressable accessibilityRole="button" accessibilityLabel={attachmentMenu ? "Close attachment options" : "Add attachments"} accessibilityState={{ disabled: busy || picking, expanded: attachmentMenu }} disabled={busy || picking} onPress={() => setAttachmentMenu(open => !open)} style={[styles.attachmentButton, attachmentMenu && styles.attachmentButtonSelected]}>
              <AppIcon name={attachmentMenu ? "close" : "plus"} size={21} color={colors.muted} />
            </Pressable> : null}
          <Text style={styles.composerHint}>{picking ? "Adding attachment…" : !onCancel && members.length ? "@ to mention someone" : ""}</Text>
          <Pressable testID="composer-send" accessibilityRole="button" accessibilityLabel={busy ? "Sending message" : sendLabel === "Send" ? "Send message" : sendLabel} accessibilityState={{ disabled: off, busy }} onPress={send} disabled={off} style={({ pressed }) => [styles.send, off && styles.sendDisabled, pressed && !off && { backgroundColor: colors.blueDark }]}>
            {busy ? <ActivityIndicator size="small" color={colors.muted} /> : sendLabel === "Send" ? <AppIcon name="send" size={19} color={off ? colors.muted : colors.white} /> : <Text style={[styles.sendText, off && { color: colors.muted }]}>{sendLabel}</Text>}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export function ConversationRow({ c, onPress, onLongPress, accessibilityActions, onAccessibilityAction, trailing, compact = false }: { c: Conversation; onPress: () => void; trailing?: ReactNode; compact?: boolean } & Pick<PressableProps, "onLongPress" | "accessibilityActions" | "onAccessibilityAction">) {
  const last = c.lastMessage;
  const preview = last ? (last.deleted ? "Message deleted" : `${!last.activity && (c.kind === "channel" || (c.members?.length ?? 0) > 2) ? `${last.user.name}: ` : ""}${last.text || (last.attachments?.length ? `${last.attachments.length} attachment${last.attachments.length === 1 ? "" : "s"}` : "Thinking…")}`) : c.topic || "No messages yet";
  const bold = c.unread > 0 && !c.archived;
  const title = c.kind === "channel" ? `#${c.title}` : c.title;
  return (
    <View style={[styles.rowContainer, compact && styles.compactRowContainer]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}${c.private && c.kind === "channel" ? ", private" : ""}${bold ? `, ${c.unread} unread` : ""}${compact ? "" : `. ${preview}`}`}
        onPress={onPress}
        onLongPress={onLongPress}
        accessibilityHint={onLongPress ? "Swipe left or long press for channel actions" : undefined}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={onAccessibilityAction}
        style={({ pressed }) => [styles.row, compact && styles.compactRow, trailing ? styles.rowWithTrailing : null, pressed && { backgroundColor: colors.surface }]}
      >
        {c.kind === "dm" ? <Avatar name={c.title} size={compact ? 26 : 40} /> : <View style={[styles.channelGlyph, compact && styles.compactChannelGlyph]}><AppIcon name={c.private ? "lock" : "hash"} size={compact ? 19 : 22} color={bold ? colors.ink : colors.muted} /></View>}
        <View style={styles.rowCopy}>
          <View style={styles.rowTop}>
            <Text style={[styles.rowTitle, bold && styles.bold]} numberOfLines={1}>{c.title}</Text>
            {!compact ? <Text style={styles.time}>{when(c.updatedAt)}</Text> : null}
            {compact && bold ? <View style={styles.badge}><Text style={styles.badgeText}>{c.unread > 99 ? "99+" : c.unread}</Text></View> : null}
          </View>
          {!compact ? <View style={styles.rowTop}>
            <Text style={[styles.preview, bold && { color: colors.ink }]} numberOfLines={1}>{preview}</Text>
            {bold ? <View style={styles.badge}><Text style={styles.badgeText}>{c.unread > 99 ? "99+" : c.unread}</Text></View> : null}
          </View> : null}
        </View>
      </Pressable>
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  activity: { paddingHorizontal: space.side, paddingVertical: 3, alignItems: "center" },
  activityText: { ...typography.meta, color: colors.muted, textAlign: "center" },
  dateSeparator: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.side, paddingVertical: space.sm, marginVertical: space.xxs },
  dateLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  dateLabel: { ...typography.captionStrong, color: colors.ink, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: space.xxs },
  reactions: { flexDirection: "row", flexWrap: "wrap", gap: space.xxs, marginTop: 0 },
  reaction: { minHeight: 44, minWidth: 44, justifyContent: "center" },
  reactionPill: { minHeight: 28, minWidth: 42, paddingHorizontal: space.xs, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  selectedReaction: { backgroundColor: colors.blueSoft, borderColor: colors.blue },
  reactionText: { ...typography.label, color: colors.ink },
  more: { position: "absolute", right: -space.xs, top: -space.xxs, minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  moreText: { ...typography.label, color: colors.muted },
  menuOverlay: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: space.side, backgroundColor: "rgba(0,0,0,0.35)" },
  menuCard: { width: "100%", maxWidth: 420, maxHeight: "100%", backgroundColor: colors.white, borderRadius: radius.lg, padding: space.side },
  copyStatus: { ...typography.caption, color: colors.muted, marginVertical: space.xs },
  menuAuthor: { ...typography.bodyStrong, color: colors.ink, marginBottom: space.xs },
  menuPreview: { ...typography.body, color: colors.muted, marginTop: space.xs, marginBottom: space.md },
  menuTitle: { ...typography.label, color: colors.muted, marginTop: space.xs, marginBottom: space.xs },
  emojiGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.xxs, marginBottom: space.sm },
  emojiButton: { width: 48, height: 48, borderRadius: radius.md, borderWidth: 1, borderColor: "transparent", justifyContent: "center", alignItems: "center" },
  emoji: { fontSize: 28 },
  menuAction: { minHeight: 48, paddingVertical: space.sm, justifyContent: "center", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  menuActionText: { ...typography.body, color: colors.blue },
  avatar: { backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center" },
  avatarText: { color: colors.blueDark, fontWeight: "600" },
  post: { flexDirection: "row", paddingHorizontal: space.side, paddingTop: space.sm, paddingBottom: space.xxs },
  postCompact: { paddingTop: space.xxs },
  postContent: { flex: 1, minWidth: 0, minHeight: Platform.OS === "web" ? 44 : undefined, paddingRight: Platform.OS === "web" ? space.xl : 0 },
  gutter: { width: 44 },
  meta: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: space.xs, marginBottom: 1 },
  author: { ...typography.bodyStrong, color: colors.ink, flexShrink: 1 },
  agentTag: { ...typography.captionStrong, color: colors.blueDark, backgroundColor: colors.blueSoft, paddingHorizontal: space.xxs, borderRadius: radius.sm, overflow: "hidden" },
  time: { ...typography.meta, color: colors.muted, flexShrink: 0 },
  body: { ...typography.body, color: colors.ink },
  mention: { color: colors.blue, fontWeight: "600" },
  deleted: { ...typography.body, color: colors.muted, fontStyle: "italic" },
  edited: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  receipt: { alignSelf: "flex-end", marginTop: 2 },
  replies: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginTop: space.xxs, minHeight: 44 },
  repliesText: { ...typography.captionStrong, color: colors.blue },
  composerWrap: { backgroundColor: colors.white, paddingHorizontal: space.sm, paddingTop: space.xs },
  composerError: { ...typography.caption, color: colors.red, paddingHorizontal: space.xs, paddingBottom: space.xs },
  attachmentMenu: { flexDirection: "row", gap: space.xs, marginHorizontal: space.xs, paddingVertical: space.xxs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  attachmentChoice: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 44, paddingHorizontal: space.sm, borderRadius: radius.sm, backgroundColor: colors.surface },
  attachmentButton: { minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "center", borderRadius: radius.sm },
  attachmentButtonSelected: { backgroundColor: colors.surface },
  attachmentText: { ...typography.captionStrong, color: colors.ink },
  suggestions: { maxHeight: 190, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  suggestion: { flexDirection: "row", alignItems: "center", minHeight: 56, paddingHorizontal: space.side, paddingVertical: space.xs },
  suggestionName: { ...typography.bodyStrong, color: colors.ink },
  suggestionHandle: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  noSuggestions: { ...typography.caption, paddingHorizontal: space.side, paddingVertical: space.sm, color: colors.muted },
  composer: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, backgroundColor: colors.white, overflow: "hidden" },
  composerFocused: { borderColor: colors.blue },
  composerToolbar: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.xxs, paddingBottom: space.xxs, minHeight: 48 },
  composerHint: { ...typography.meta, color: colors.muted, flex: 1, paddingHorizontal: space.xs },
  editingLabel: { ...typography.captionStrong, color: colors.muted, paddingTop: space.xs, paddingHorizontal: space.sm },
  input: { ...typography.body, minHeight: 44, maxHeight: 144, paddingHorizontal: space.sm, paddingTop: space.sm, paddingBottom: space.xs, color: colors.ink, backgroundColor: colors.white },
  send: { minHeight: 44, minWidth: 44, paddingHorizontal: space.sm, borderRadius: radius.sm, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" },
  sendDisabled: { backgroundColor: colors.subtle },
  sendText: { ...typography.label, color: colors.white },
  cancel: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.xs },
  cancelText: { ...typography.label, color: colors.blue },
  rowContainer: { flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  compactRowContainer: { borderBottomWidth: 0 },
  row: { flex: 1, minWidth: 0, minHeight: 72, paddingHorizontal: space.side, paddingVertical: space.sm, flexDirection: "row", alignItems: "center" },
  compactRow: { minHeight: 44, paddingVertical: space.xxs },
  rowCopy: { flex: 1, minWidth: 0, marginLeft: space.sm },
  channelGlyph: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: colors.surface },
  compactChannelGlyph: { width: 26, height: 26, backgroundColor: "transparent" },
  rowWithTrailing: { paddingRight: space.xs },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.xs },
  rowTitle: { ...typography.body, flex: 1, color: colors.ink },
  bold: { fontWeight: "700" },
  preview: { ...typography.caption, flex: 1, marginTop: space.xxs, color: colors.muted },
  badge: { minWidth: 22, minHeight: 22, borderRadius: radius.pill, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  badgeText: { ...typography.captionStrong, color: colors.white },
});
