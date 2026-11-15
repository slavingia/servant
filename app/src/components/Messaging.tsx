import { memo, useLayoutEffect, useEffect, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { MeetingCard } from "./MeetingCard";
import { useProjectGlossary } from "../lib/use-project-glossary";
import { findUnknownAbbreviations } from "../lib/abbreviations";
import { lexiconApi } from "../lib/lexicon-api";
import { ActivityIndicator, Alert, Image, Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type PressableProps } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { accountId, api, ServerError, type Conversation, type Person, type Post, type Upload } from "../lib/server";
import { useDictation } from "../lib/dictation";
import { insertDictation } from "../lib/dictation-text";
import { activeMention, agentMentionNames, AGENT_HANDLES, insertMention, mentionMatches, mentionText } from "../lib/mentions";
import { parseSlash, queuedMessage, slashMatches } from "../lib/slash-commands";
import { newSendTouch, pressed, touchDown, touchHeld, touchUp } from "../lib/send-press";
import type { MessageReceipt } from "../lib/message-status";
import { messageDeviceLabel } from "../lib/message-device";
import { useSession } from "../lib/session";
import { useFeatures } from "../lib/features";
import { usePhotos } from "../lib/photos";
import { useWideLayout } from "../lib/layout";
import { shortTime } from "../lib/time-label";
import { localFormat } from "../lib/local-format";
import { validateAttachmentSelection } from "../lib/media";
import { getDraft, loadDrafts, setDraft } from "../lib/drafts";
import { shouldEditLastMessage } from "../lib/edit-last-message";
import { Attachments, DraftAttachments, attachmentsFromFiles, pickAttachments, pickDocuments, type DraftAttachment } from "./Attachments";
import { AppIcon } from "./AppIcon";
import { SaveMessageAction } from "./SaveMessageAction";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";
import { MessageText } from "./MessageText";
import { TweetEmbed } from "./TweetEmbed";
import { LinkPreview } from "./LinkPreview";
import { replyContext } from "../lib/also-in-channel";
import { tweetIds } from "../lib/tweet-embed";
import { conversationPreview } from "../lib/conversation-preview";
import { parseForward } from "../lib/forward";
import { radius, space, typography, useTheme, createThemedStyles, linkUnderline } from "../lib/theme";

export const when = (ms: number) => shortTime(ms);

// userId shows that person's photo. Add tapToMessage to make the avatar open your
// DM with them, or, on the agent's avatar, a new private chat with the agent. It
// stays a plain picture for you and in pickers.
const AVATAR_TARGET = 44;
const SMALL_AVATAR = 26;
export function Avatar({ name, agent, size = 34, userId, tapToMessage, onBrand }: { name: string; agent?: boolean; size?: number; userId?: string; tapToMessage?: boolean; onBrand?: boolean }) {
  const { account } = useSession();
  const [opening, setOpening] = useState(false);
  const tappable = !!tapToMessage && !!account && (agent || (!!userId && userId !== account.user.id));
  if (!tappable) return <AvatarFace name={name} agent={agent} size={size} userId={userId} onBrand={onBrand} />;
  const open = async () => {
    if (opening || !account) return;
    setOpening(true);
    try {
      if (agent) {
        const chat = await api.newChat(account, {});
        router.push({ pathname: "/chat/[id]", params: { id: chat.id, title: chat.title, compose: "1" } });
      } else if (userId) {
        const conversation = await api.openDm(account, [userId]);
        router.push({ pathname: "/c/[id]", params: { id: conversation.id, title: name } });
      }
    } catch (e) {
      const message = e instanceof ServerError ? e.message : agent ? "Couldn't start a chat with the agent. Try again" : "Couldn't open the conversation. Try again";
      if (Platform.OS === "web") globalThis.alert?.(message); else Alert.alert(message);
    } finally { setOpening(false); }
  };
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={agent ? "Chat with the agent" : `Message ${name}`}
    accessibilityState={{ busy: opening, disabled: opening }}
    disabled={opening}
    onPress={() => void open()}
    // A 44-point target around a smaller picture. The spare hangs to the right and below, in the gap beside the
    // name and under the avatar, so the row keeps its size and nothing else is covered.
    style={({ pressed }) => ({ opacity: pressed || opening ? 0.6 : 1, width: Math.max(size, AVATAR_TARGET), height: Math.max(size, AVATAR_TARGET), marginRight: Math.min(0, size - AVATAR_TARGET), marginBottom: Math.min(0, size - AVATAR_TARGET) })}
  >
    <AvatarFace name={name} agent={agent} size={size} userId={userId} onBrand={onBrand} />
  </Pressable>;
}

// On the navy band (onBrand) the agent's tile flips to white with navy letters,
// like the workspace mark, instead of disappearing into the background.
function AvatarFace({ name, agent, size, userId, onBrand }: { name: string; agent?: boolean; size: number; userId?: string; onBrand?: boolean }) {
  const styles = useStyles();
  const { colors, avatarTones } = useTheme();
  const photo = usePhotos()?.uri(agent ? undefined : userId);
  if (photo) return <Image accessibilityElementsHidden importantForAccessibility="no" source={{ uri: photo }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.subtle }} />;
  // Two initials at 0.4 of a small circle are under 10 points (7 in the sidebar's 18-point avatar); one is legible.
  const small = size < SMALL_AVATAR;
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, small ? 1 : 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  const tone = avatarTones[Array.from(name).reduce((hash, letter) => (hash * 31 + letter.codePointAt(0)!) >>> 0, 0) % avatarTones.length]!;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={[styles.avatar, { width: size, height: size, borderRadius: agent ? radius.sm : size / 2, backgroundColor: agent ? (onBrand ? colors.onBrand : colors.navy) : tone.background }]}
    >
      {agent ? <AppIcon name="sparkles" size={size * 0.5} color={onBrand ? colors.navy : colors.onBrand} /> : <Text style={[styles.avatarText, { fontSize: Math.round(size * (small ? 0.55 : 0.4)), color: tone.foreground }]}>{initials || "?"}</Text>}
    </View>
  );
}

// A one-to-one DM shows the other person's photo; group DMs keep initials.
export function dmPeer(c: Conversation, me: string | undefined) {
  const others = (c.members ?? []).filter(p => !p.agent && p.id !== me);
  return others.length === 1 ? others[0]!.id : undefined;
}

// Group conversations: two overlapping person avatars on one tile, so a group never reads as one person.
export function GroupAvatar({ people, size = 40 }: { people: { id: string; name: string }[]; size?: number }) {
  const { colors } = useTheme();
  const inner = Math.round(size * 0.6);
  const a = people[0] ?? { id: "", name: "?" };
  const b = people[1] ?? a;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no" style={{ width: size, height: size, borderRadius: radius.sm, backgroundColor: colors.surface, overflow: "hidden" }}>
      <View style={{ position: "absolute", left: 0, top: 0, borderRadius: inner / 2, borderWidth: 1.5, borderColor: colors.surface }}><Avatar name={b.name} userId={b.id || undefined} size={inner} /></View>
      <View style={{ position: "absolute", right: 0, bottom: 0, borderRadius: inner / 2, borderWidth: 1.5, borderColor: colors.surface }}><Avatar name={a.name} userId={a.id || undefined} size={inner} /></View>
    </View>
  );
}

/** Above the first message that arrived since you last read this conversation (lib/unread-line.ts). */
export function UnreadLine() {
  const styles = useStyles();
  return <View accessibilityRole="header" accessibilityLabel="New messages" style={styles.unreadSeparator}>
    <View style={styles.unreadRule} />
    <Text style={styles.unreadLabel}>New</Text>
  </View>;
}

export function MessageDate({ at }: { at: number }) {
  const styles = useStyles();
  const date = new Date(at);
  const today = new Date();
  const ago = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000);
  const label = ago === 0 ? "Today"
    : ago === 1 ? "Yesterday"
    : ago > 1 && ago < 7 ? localFormat("weekday", date)
    : localFormat(date.getFullYear() !== today.getFullYear() ? "weekdayMonthDayYear" : "weekdayMonthDay", date);
  return <View accessibilityRole="header" style={styles.dateSeparator}>
    <View style={styles.dateLine} />
    <Text style={styles.dateLabel}>{label}</Text>
    <View style={styles.dateLine} />
  </View>;
}

// In a browser, pressing the mouse on a suggestion took focus from the message box. The list then closed a
// quarter second later, so a click held any longer landed on nothing: no mention, and typing went nowhere.
// Keeping the press from moving focus leaves the box focused and the list open until the click lands.
const KEEP_COMPOSER_FOCUS = (Platform.OS === "web" ? { onMouseDown: (event: { preventDefault(): void }) => event.preventDefault() } : {}) as object;

// How many undefined abbreviations one message may raise (the server takes at most this many: lexicon-guess.mjs).
const MAX_LEARNED_TERMS = 8;

// Splits text so @mentions stand out.
// A message forwarded from an agent chat shows as a quote card, then the note.
function ForwardedPost({ text }: { text: string }) {
  const styles = useStyles();
  const parsed = parseForward(text);
  // A person's own words are formatted as they typed them: *bold*, _italics_, `code`, quotes and lists.
  if (!parsed) return <MessageText chat text={text} />;
  const where = [parsed.forward.where, parsed.forward.when].filter(Boolean).join(" · ");
  return <>
    <View accessible accessibilityLabel={`Forwarded message from ${parsed.forward.author}, ${where}. ${parsed.forward.quote || "No text"}`} style={styles.forwardCard}>
      <Text style={styles.forwardLabel}>Forwarded from {parsed.forward.author}<Text style={styles.forwardWhere}> · {where}</Text></Text>
      {parsed.forward.quote ? <Text selectable={Platform.OS === "web"} style={styles.body}>{parsed.forward.quote}</Text> : null}
    </View>
    {parsed.rest ? <MessageText chat text={parsed.rest} /> : null}
  </>;
}

const MENTION_TOKEN = /(@[\p{L}\p{M}\p{N}_’'.-]+)/gu;
const mentionParts = (text: string, names: Set<string>) =>
  text.split(MENTION_TOKEN).map(t => ({ text: t, mention: t.startsWith("@") && names.has(t.toLowerCase().replace(/[.,;:!?)'’]+$/, "")) }));
const hasMention = (text: string, names: Set<string>) => text.includes("@") && mentionParts(text, names).some(p => p.mention);

type PostProps = {
  post: Post;
  me: string;
  receipt?: MessageReceipt;
  compact?: boolean; // same author and visible device category within five minutes
  // Each handler is given the post, so a list can hand every row the same function and a row
  // whose post did not change is not drawn again.
  onOpenThread?: (post: Post) => void;
  onEdit?: (post: Post) => void;
  onDelete?: (post: Post) => void;
  onReact?: (post: Post, emoji: string, active: boolean) => Promise<void>;
  onAskAgent?: (post: Post) => void;
  /** Sends a suggested reply. Given only for the newest message, so old chips go away. */
  onSuggest?: (text: string) => void;
};

const REACTIONS = [
  ["👍", "Like"], ["❤️", "Love"], ["😂", "Laugh"], ["😮", "Surprised"],
  ["😢", "Sad"], ["🙏", "Thanks"], ["🎉", "Celebrate"], ["✅", "Done"],
  ["👀", "Looking"], ["🔥", "Fire"], ["👏", "Applause"], ["💯", "Hundred"],
];

export const PostRow = memo(function PostRow({ post, me, receipt, compact, onOpenThread: openThread, onEdit: edit, onDelete: remove, onReact: react, onAskAgent: askAgent, onSuggest }: PostProps) {
  const onOpenThread = openThread && (() => openThread(post));
  const onEdit = edit && (() => edit(post));
  const onDelete = remove && (() => remove(post));
  const onReact = react && ((emoji: string, active: boolean) => react(post, emoji, active));
  const onAskAgent = askAgent && (() => askAgent(post));
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const deviceLabel = messageDeviceLabel(account?.user.role, post);
  const [menu, setMenu] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [copying, setCopying] = useState(false);
  const [busy, setBusy] = useState(false);
  const reacting = useRef(false);
  const insets = useSafeAreaInsets();
  const context = useContextMenu();
  // A message still on its way has nothing to react to, reply to or edit yet.
  const available = !post.deleted && !post.pending && !post.sending && !post.activity;
  const working = post.pending && post.user.agent;
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
  // Who reacted: names are fetched only when the menu opens on a message that has reactions.
  const [reactorNames, setReactorNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!menu || !reactions.length || !account) return;
    let live = true;
    api.people(account).then(
      d => { if (live) setReactorNames(Object.fromEntries([...d.people, d.agent].map(p => [p.id, p.name]))); },
      () => {},
    );
    return () => { live = false; };
  }, [menu, reactions.length, account]);
  if (post.activity) return (
    <View accessible accessibilityLabel={`${post.text}, ${when(post.createdAt)}`} style={styles.activity}>
      <Text style={styles.activityText}>{post.text} · {when(post.createdAt)}</Text>
    </View>
  );
  const mine = post.user.id === me;
  const options = [
    ...(onAskAgent ? [{ text: "Ask the agent", onPress: onAskAgent }] : []),
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
  // Right-click on a computer: the common actions at the pointer, and the full sheet one click away.
  const contextItems = (): ContextMenuItem[] => {
    if (!available) return [];
    const quick = onReact ? REACTIONS.slice(0, 6) : [];
    return [
      ...(quick.length ? [{ key: "react", row: <View accessibilityRole="toolbar" accessibilityLabel="React" style={styles.contextReactions}>{quick.map(([emoji, name]) => {
        const selected = reactions.some(r => r.emoji === emoji && r.userIds.includes(me));
        return <Pressable key={emoji} accessibilityRole="button" accessibilityLabel={`${selected ? "Remove" : "Add"} ${name} reaction`} aria-pressed={selected} disabled={busy} onPress={() => { context.close(); void choose(emoji!); }} style={state => [styles.contextEmoji, ((state as { hovered?: boolean }).hovered || selected) && styles.selectedReaction]}><Text style={styles.emoji}>{emoji}</Text></Pressable>;
      })}</View> }, { separator: true as const }] : []),
      ...(onOpenThread ? [{ label: "Reply in thread", onPress: onOpenThread }] : []),
      ...(post.text ? [{ label: "Copy text", onPress: () => { void Clipboard.setStringAsync(post.text!); } }] : []),
      ...(account ? [{ label: "Save for later", onPress: () => { void api.saveMessage(account, post.id).catch(() => {}); } }] : []),
      ...(onAskAgent ? [{ label: "Ask the agent", onPress: onAskAgent }] : []),
      ...(mine && (onEdit || onDelete) ? [{ separator: true as const }] : []),
      ...(mine && onEdit ? [{ label: "Edit", onPress: onEdit }] : []),
      ...(mine && onDelete ? [{ label: "Delete", onPress: onDelete, destructive: true }] : []),
      { separator: true as const },
      { label: "More actions", onPress: actions },
    ];
  };
  const label = `${post.user.name}, ${when(post.createdAt)}${deviceLabel ? (post.sourceDevice?.kind === "agent" ? ", posted by an agent" : `, sent from ${deviceLabel}`) : ""}. ${post.deleted ? "Message deleted" : working ? "Working on it…" : post.text}${post.replyCount ? `. ${post.replyCount} ${post.replyCount === 1 ? "reply" : "replies"}` : ""}`;
  return (
    <>
    <Pressable onLongPress={actions} delayLongPress={400} accessible={false} {...context.bind(contextItems)} style={[styles.post, compact && styles.postCompact, (menu || context.open) && { backgroundColor: colors.surface }]}>
      <View style={styles.gutter}>{compact ? null : <Avatar name={post.user.name} agent={post.user.agent} userId={post.user.id} tapToMessage />}</View>
      <View style={styles.postContent}>
        <View accessible accessibilityLabel={label} accessibilityHint={available ? "Touch and hold to copy, select text, react or open message actions" : undefined} accessibilityActions={available ? [{ name: "activate", label: "Copy, react or open message actions" }] : undefined} onAccessibilityAction={actions}>
        {!compact || deviceLabel ? (
          <View style={styles.meta}>
            {!compact ? <Text style={styles.author}>{post.user.name}</Text> : null}
            {!compact && post.user.agent ? <Text style={styles.agentTag}>Agent</Text> : null}
            {post.sourceDevice?.kind === "agent" ? <Text testID={`message-device-${post.id}`} accessibilityLabel="Posted by an agent, not typed by this person" style={styles.agentTag}>{deviceLabel}</Text> : null}
            <Text style={styles.time}>{when(post.createdAt)}{deviceLabel && post.sourceDevice?.kind !== "agent" ? <Text testID={`message-device-${post.id}`} accessibilityLabel={`Sent from ${deviceLabel}`}> · {deviceLabel}</Text> : null}</Text>
          </View>
        ) : null}
        {post.alsoInChannel && !post.deleted ? <Text numberOfLines={onOpenThread ? 1 : undefined} style={styles.alsoSent}>{onOpenThread ? replyContext(post) : "Also sent to the conversation"}</Text> : null}
        {post.deleted ? (
          <Text style={styles.deleted}>Message deleted</Text>
        ) : working || (post.pending && !post.text && !post.attachments?.length) ? (
          <Text style={styles.deleted}>Working…</Text>
        ) : post.text ? (
          post.user.agent ? <MessageText text={post.text} /> : <ForwardedPost text={post.text} />
        ) : null}
        {!post.deleted ? tweetIds(post.text).map(id => <TweetEmbed key={id} id={id} />) : null}
        {post.preview && !post.deleted ? <LinkPreview preview={post.preview} /> : null}
        {post.editedAt && !post.deleted ? <Text style={styles.edited}>Edited</Text> : null}
        {post.meeting && post.user.agent && !post.deleted ? <MeetingCard meeting={post.meeting} /> : null}
        </View>
        {onSuggest && post.user.agent && !post.deleted && post.suggestions?.length ? (
          <View style={styles.suggestionRow} accessibilityLabel="Quick replies">
            {post.suggestions.map(text => (
              <Pressable key={text} accessibilityRole="button" accessibilityLabel={`Reply: ${text}`} onPress={() => onSuggest(text)} style={({ pressed }) => [styles.chip, pressed && { opacity: 0.6 }]}>
                <Text style={styles.chipText}>{text}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {!post.deleted && !working && post.attachments?.length ? <Attachments files={post.attachments} /> : null}
        {available && reactions.length > 0 ? <View style={styles.reactions}>
          {reactions.map(r => {
            const selected = r.userIds.includes(me);
            return <Pressable key={r.emoji} accessibilityRole="button" accessibilityLabel={`${r.emoji}, ${r.userIds.length} reactions${selected ? ", including you. Remove reaction" : ". Add reaction"}`} accessibilityHint="Touch and hold to see who reacted" accessibilityState={{ selected, disabled: busy || !onReact }} aria-pressed={selected} disabled={busy || !onReact} onPress={() => choose(r.emoji)} onLongPress={() => setMenu(true)} style={styles.reaction}>
              <View style={[styles.reactionPill, selected && styles.selectedReaction]}><Text style={styles.reactionText}>{r.emoji} {r.userIds.length}</Text></View>
            </Pressable>;
          })}
        </View> : null}
        {available && Platform.OS === "web" ? <Pressable accessibilityRole="button" accessibilityLabel={`Actions for ${post.user.name}'s message`} onPress={actions} style={styles.more}><Text style={styles.moreText}>•••</Text></Pressable> : null}
        {onOpenThread && post.alsoInChannel && !post.deleted ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`${replyContext(post)}. View thread`} onPress={onOpenThread} style={styles.replies}>
            <Text style={styles.repliesText}>View thread</Text>
          </Pressable>
        ) : null}
        {onOpenThread && post.replyCount > 0 ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`${post.replyCount} ${post.replyCount === 1 ? "reply" : "replies"}, open thread`} onPress={onOpenThread} style={styles.replies}>
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
    {context.menu}
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
              <Text key={selecting ? "full-text" : "preview"} testID="message-selectable-text" selectable={selecting} numberOfLines={selecting ? undefined : 4} style={styles.menuPreview}>{post.text}</Text>
            </> : null}
            {account && !selecting ? <SaveMessageAction key={`${accountId(account)}:${account.token}:${account.serverKey}:${post.id}`} account={account} messageId={post.id}
              onOpenSaved={() => { setMenu(false); router.push("/saved"); }} /> : null}
            {reactions.length > 0 && !selecting ? <>
              <Text style={styles.menuTitle}>Who reacted</Text>
              {reactions.map(r => (
                <Text key={r.emoji} accessibilityLabel={`${r.emoji}: ${r.userIds.map(id => (id === me ? "You" : reactorNames[id] ?? "Someone")).join(", ")}`} style={styles.reactionWho}>
                  {r.emoji}  {r.userIds.map(id => (id === me ? "You" : reactorNames[id] ?? "Someone")).join(", ")}
                </Text>
              ))}
            </> : null}
            {onReact && !selecting ? <>
              <Text style={styles.menuTitle}>React</Text>
              <View style={styles.emojiGrid}>{REACTIONS.map(([emoji, name]) => {
                const selected = reactions.some(r => r.emoji === emoji && r.userIds.includes(me));
                return <Pressable key={emoji} accessibilityRole="button" accessibilityLabel={`${selected ? "Remove" : "Add"} ${name} reaction`} accessibilityState={{ selected, disabled: busy }} aria-pressed={selected} disabled={busy} onPress={() => choose(emoji!)} style={[styles.emojiButton, selected && styles.selectedReaction]}><Text style={styles.emoji}>{emoji}</Text></Pressable>;
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
});

// Keyboard-and-pointer browsers and the Mac app send on Return, like Slack.
// Touch browsers keep Return for new lines and use the send button.
function useEnterSends() {
  const [fine] = useState(() => Platform.OS === "web" && typeof window !== "undefined" && !!window.matchMedia?.("(pointer: fine)").matches);
  return fine;
}

export function Composer({
  placeholder,
  onSend,
  initial = "",
  sendLabel = "Send",
  onCancel,
  onEditLast,
  onDeleteEmpty,
  onTyping,
  members = [],
  me = "",
  autoFocus = false,
  allowAttachments = true,
  allowFileAttachments = true,
  allowDocuments = false,
  clearOnSend = false,
  mentionAgent = false,
  canSendEmpty = false,
  commands,
  holdToQueue = false,
  onStop,
  draftKey: conversationDraftKey,
  projectId,
}: {
  placeholder: string;
  /** `how` is "queue" when the message should wait for the reply in progress to finish (a held Send, or "/queue …"). */
  onSend: (text: string, attachments?: Upload[], how?: "queue") => Promise<boolean>;
  initial?: string;
  sendLabel?: string;
  onCancel?: () => void;
  /** Edit the latest own message when Up Arrow is pressed in an empty composer. */
  onEditLast?: () => void;
  /** Editing: saving an empty box asks to delete the message instead, like Slack. */
  onDeleteEmpty?: () => void;
  members?: Person[];
  me?: string;
  autoFocus?: boolean;
  allowAttachments?: boolean;
  allowFileAttachments?: boolean;
  /** Documents and design files up to 100 MB, uploaded in chunks. */
  allowDocuments?: boolean;
  // Long agent replies should leave the input free for the next draft.
  clearOnSend?: boolean;
  onTyping?: (text: string) => void;
  // Offer the agent (@agent) in the mention list.
  mentionAgent?: boolean;
  // Something else is attached (a forwarded message), so an empty box can send.
  canSendEmpty?: boolean;
  /** Slack-style "/" commands: the list shows while typing "/…" at the start. channel = channel-only ones too. */
  commands?: { channel: boolean; agent?: boolean };
  /** The agent is replying: a tap on Send adds the message to that reply, touch and hold sends it after. */
  holdToQueue?: boolean;
  /** With nothing typed, Send becomes Stop while the agent can be stopped. */
  onStop?: () => void;
  /** Keeps the unsent text for this conversation when you leave and come back. */
  draftKey?: string;
  /** Project definitions override the shared server lexicon in this chat. */
  projectId?: string | null;
}) {
  const styles = useStyles();
  const wide = useWideLayout();
  const { colors } = useTheme();
  const { account } = useSession();
  const draftKey = account && conversationDraftKey ? `account:${accountId(account)}:${account.user.id}:${conversationDraftKey}` : undefined;
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
  const [text, setText] = useState(() => initial || (draftKey ? getDraft(draftKey) : ""));
  const { account: glossaryAccount } = useSession();
  const glossary = useProjectGlossary(glossaryAccount, projectId);
  // A pending glossary lookup must not send after leaving this chat or account.
  const sendScope = useRef(0);
  useLayoutEffect(() => () => { sendScope.current++; }, [draftKey, projectId, glossaryAccount?.serverUrl, glossaryAccount?.serverKey, glossaryAccount?.user.id, glossaryAccount?.token]);
  useEffect(() => {
    if (!draftKey) return;
    let live = true;
    // After a restart the saved copy arrives a moment later; never overwrite typing.
    void loadDrafts().then(() => { const saved = getDraft(draftKey); if (live && saved) setText(current => current || saved); });
    return () => { live = false; };
  }, [draftKey]);
  useEffect(() => { if (draftKey) setDraft(draftKey, text); }, [draftKey, text]);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<DraftAttachment[]>([]);
  const [picking, setPicking] = useState(false);
  const [attachmentMenu, setAttachmentMenu] = useState(false);
  const [fileError, setFileError] = useState("");
  const sending = useRef(false);
  // The Send button's touch in progress, and when the last message left (lib/send-press.ts has the rules).
  const touch = useRef(newSendTouch());
  // New messages leave the box the moment they're sent (restored if sending
  // fails); edits stay put until saved.
  const clearNow = clearOnSend || !onCancel;
  const pick = async (photos: boolean, documents = false) => {
    if (picking || busy) return;
    setPicking(true);
    setFileError("");
    try {
      const added = documents ? await pickDocuments(files) : await pickAttachments(photos, files);
      const next = [...files, ...added];
      validateAttachmentSelection(next);
      setFiles(next);
      setAttachmentMenu(false);
    } catch (e) { setFileError(e instanceof Error ? e.message : "Couldn't select files"); }
    finally { setPicking(false); }
  };
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const filesRef = useRef<DraftAttachment[]>([]);
  const pendingPastes = useRef(0);
  useEffect(() => { filesRef.current = files; }, [files]);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = input.current as unknown as HTMLElement | null;
    if (!node?.addEventListener) return;
    const onPaste = (event: ClipboardEvent) => {
      const pasted = Array.from(event.clipboardData?.files ?? []) as unknown as Blob[];
      if (!pasted.length) return;
      event.preventDefault();
      setFileError("");
      pendingPastes.current++;
      attachmentsFromFiles(pasted, filesRef.current)
        .then((added) => setFiles((current) => { const next = [...current, ...added]; try { validateAttachmentSelection(next); } catch (e) { setFileError(e instanceof Error ? e.message : "Couldn't attach"); return current; } return next; }))
        .catch((e) => setFileError(e instanceof Error ? e.message : "Couldn't attach"))
        .finally(() => { pendingPastes.current--; });
    };
    node.addEventListener("paste", onPaste);
    return () => node.removeEventListener("paste", onPaste);
  }, []);
  const [selection, setSelection] = useState(() => ({ start: text.length, end: text.length }));
  // An edit opens with the caret after the last character, like Slack.
  const [insertedSelection, setInsertedSelection] = useState<{ start: number; end: number } | undefined>(() => initial ? { start: initial.length, end: initial.length } : undefined);
  useEffect(() => {
    if (Platform.OS !== "web" || !initial || !autoFocus) return;
    const frame = requestAnimationFrame(() => {
      const node = input.current as unknown as HTMLTextAreaElement | null;
      if (!node?.setSelectionRange) return;
      node.focus();
      const end = node.value.length;
      node.setSelectionRange(end, end);
      node.scrollTop = node.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
    // Only when the box opens with a message in it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [copiedSelected, setCopiedSelected] = useState(false);
  // The phone's own Copy toolbar did not appear for some people, so highlighted text also gets a Copy button.
  const copySelected = async () => {
    const part = text.slice(selection.start, selection.end);
    if (!part) return;
    try { await Clipboard.setStringAsync(part); setCopiedSelected(true); setTimeout(() => setCopiedSelected(false), 1500); } catch { /* the system toolbar is still there */ }
  };
  const [focused, setFocused] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(blurTimer.current), []);
  const enterSends = useEnterSends();
  const features = useFeatures();
  const match = focused && !busy ? activeMention(text, selection) : null;
  const suggestions = match ? mentionMatches(members, me, match.query, mentionAgent) : [];
  // @names of people here (and @agent) show in blue as you type: a colored copy of the text sits
  // exactly under a see-through input (inputs can't color part of their text on the web).
  const mentionNames = new Set([...members.map(p => mentionText(p.name).toLowerCase()), ...(mentionAgent ? agentMentionNames() : [])]);
  const slash = commands && !busy && !onCancel ? slashMatches(text, commands.channel, commands.agent === true, features) : null;
  const latest = useRef({ text, selection });
  useLayoutEffect(() => { latest.current = { text, selection }; });
  // A caret placed by picking a mention or a command is handed to the box once, then let go, so the box is the
  // person's again before they type the next letter (a caret that stays controlled fights the keyboard on phones).
  useEffect(() => {
    if (!insertedSelection) return;
    const timer = setTimeout(() => setInsertedSelection(undefined), 80);
    return () => clearTimeout(timer);
  }, [insertedSelection]);
  const choose = (person: Person) => {
    if (!match) return;
    const next = insertMention(text, match, person.name);
    setText(next.text);
    onTyping?.(next.text);
    const caret = { start: next.cursor, end: next.cursor };
    latest.current = { text: next.text, selection: caret };
    setSelection(caret);
    setInsertedSelection(caret);
    input.current?.focus();
  };
  const chooseCommand = (name: string) => {
    const next = `/${name} `;
    setText(next); onTyping?.(next);
    const caret = { start: next.length, end: next.length };
    latest.current = { text: next, selection: caret };
    setSelection(caret); setInsertedSelection(caret);
    input.current?.focus();
  };
  const dictation = useDictation((spoken) => {
    const { text: current, selection: at } = latest.current;
    const next = insertDictation(current, Math.min(at.end, current.length), spoken);
    setText(next.text);
    onTyping?.(next.text);
    const caret = { start: next.cursor, end: next.cursor };
    latest.current = { text: next.text, selection: caret };
    setSelection(caret);
    setInsertedSelection(caret);
  });
  const send = async (how?: "queue") => {
    if (sending.current || picking) return;
    sending.current = true;
    setBusy(true);
    setFileError("");
    let body = "";
    // What goes back in the box if sending fails: the message as typed, "/queue" and all.
    let typedQueue = false;
    const restore = () => typedQueue ? `/queue ${body}` : body;
    const scope = sendScope.current;
    const uploads = files.map(({ name, data, document }) => document ? { name, data, document } : { name, data });
    try {
      // stop() emits its final transcript asynchronously. The commit callback
      // updates latest synchronously, before finish resolves on the end event.
      // Only dictation can veto a send. A typed draft must never depend on the
      // dictation session being active/foreground (it silently dropped taps).
      if (dictation.listening) {
        if (!await dictation.finish(1200)) { setFileError("Dictation didn't finish. Tap Send again"); return; }
      } else void dictation.finish(0);
      if (scope !== sendScope.current) return;
      body = latest.current.text.trim();
      if (!body && !files.length && !canSendEmpty) { if (onCancel && onDeleteEmpty) onDeleteEmpty(); return; }
      // "/queue fix the title" is a message for after the current reply, not a command to run.
      const later = commands?.agent && !onCancel ? queuedMessage(body) : null;
      if (later !== null) {
        if (!later && !files.length && !canSendEmpty) { setFileError("Type your message after /queue"); return; }
        body = later; how = "queue"; typedQueue = true;
      }
      const command = commands && !onCancel && !uploads.length && later === null && parseSlash(body, commands.channel, commands.agent === true, features);
      if (body && glossaryAccount && !command && !onCancel) {
        // Sending never stops to ask what an abbreviation means, and never waits for the list of them either: the
        // box clears and the message goes the moment Send is pressed. Beside it, an abbreviation nobody has
        // defined is handed to the server, which adds Agent's guess and gives the sender a to-do to check it.
        // The message goes exactly as written. Known abbreviations are marked when it is shown, not expanded.
        const account = glossaryAccount, remember = glossary.rememberEntry, getEntries = glossary.getEntries;
        void (async () => {
          let unknown = findUnknownAbbreviations(body, await getEntries());
          // Another member may have defined it since this composer opened.
          if (unknown.length) unknown = findUnknownAbbreviations(body, await getEntries(true));
          if (!unknown.length) return;
          void lexiconApi.learn(account, unknown.slice(0, MAX_LEARNED_TERMS), body).then(result => result.entries.forEach(remember)).catch(() => {});
        })().catch(() => { /* The list could not be read: the message is sent all the same. */ });
      }
      if (clearNow) setText("");
      touch.current.sentAt = Date.now();
      const ok = await onSend(body, uploads, how);
      if (scope !== sendScope.current) return;
      if (ok) { if (!clearNow) setText(""); setFiles([]); setInsertedSelection(undefined); }
      else if (clearNow) setText(current => current || restore());
    } catch {
      if (scope !== sendScope.current) return;
      if (clearNow) setText(current => current || restore());
      setFileError("Couldn't send. Your draft is saved here; try again");
    }
    finally { sending.current = false; setBusy(false); }
  };
  const highlight = mentionNames.size > 0 && hasMention(text, mentionNames);
  const deletesWhenEmpty = !!onCancel && !!onDeleteEmpty;
  const empty = !text.trim() && !files.length && !dictation.listening && !canSendEmpty && !deletesWhenEmpty;
  const off = empty || busy || picking;
  // With nothing to send while the agent works, the button stops it.
  const canStop = !!onStop && empty && !busy && !picking;
  // Something is ready to go while a reply is running: say that holding the button sends it after instead.
  const holdHint = holdToQueue && !off && !dictation.listening;
  // After swipe typing, iOS can cancel the first touch on Send before it
  // lifts, and the rendered text can trail the native box by a frame. So
  // Send goes on touch down, judged by the latest native text rather than
  // the rendered state. Taps from VoiceOver or a keyboard still use onPress.
  const ready = () => !!latest.current.text.trim() || !!files.length || dictation.listening || canSendEmpty || deletesWhenEmpty;
  // While the agent replies (holdToQueue), a tap on Send adds the message to that reply and a hold sends it
  // after, so a touch waits to see which it is. With nothing typed, the same button stops the reply.
  const sendOnPressIn = () => { if (touchDown(touch.current, { ready: !busy && !picking && ready(), holdToQueue, now: Date.now() })) void send(); };
  const sendOnLongPress = () => {
    const act = touchHeld(touch.current, { canStop, now: Date.now() });
    if (act === "stop") { onStop?.(); return; }
    if (act !== "queue") return;
    if (Platform.OS !== "web") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    void send("queue");
  };
  const sendOnPressOut = () => { if (touchUp(touch.current)) void send(); };
  const sendOnPress = () => {
    const act = pressed(touch.current, { ready: ready(), canStop, now: Date.now() });
    if (act === "send") void send();
    else if (act === "stop") onStop?.();
  };
  return (
    <View style={[styles.composerWrap, wide && styles.composerWrapWide, { paddingBottom: wide ? space.md : keyboard ? space.xs : Math.max(insets.bottom, space.xs) }]}>
      {fileError || dictation.error ? <Text accessibilityRole="alert" style={styles.composerError}>{fileError || dictation.error}</Text> : null}
      {slash?.length ? (
        <ScrollView keyboardShouldPersistTaps="always" style={styles.suggestions} accessibilityLabel="Commands" {...KEEP_COMPOSER_FOCUS}>
          {slash.map(c => (
            <Pressable key={c.name} testID={`command-${c.name}`} accessibilityRole="button" accessibilityLabel={`/${c.name}: ${c.description}`} onPress={() => chooseCommand(c.name)}
              style={({ pressed }) => [styles.suggestion, pressed && { backgroundColor: colors.surface }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.suggestionName}>/{c.name}{c.hint ? <Text style={styles.suggestionHandle}> {c.hint}</Text> : null}</Text>
                <Text style={styles.suggestionHandle}>{c.description}</Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {match ? (
        <ScrollView keyboardShouldPersistTaps="always" style={styles.suggestions} accessibilityLabel="Mention suggestions" {...KEEP_COMPOSER_FOCUS}>
          {suggestions.length ? suggestions.map(person => person.agent ? (
            // The agent has its own row: tinted, labelled "Agent", and it says every name that reaches it.
            <Pressable key={person.id} testID="mention-agent" accessibilityRole="button" accessibilityLabel={`Ask the agent. Mention it as ${AGENT_HANDLES.map(handle => `@${handle}`).join(", ")}`} onPress={() => choose(person)} style={({ pressed }) => [styles.suggestion, styles.agentSuggestion, pressed && { opacity: 0.8 }]}>
              <View style={styles.agentAvatar}><AppIcon name="sparkles" size={17} color={colors.onPrimary} /></View>
              <View style={{ flex: 1, marginLeft: space.sm }}>
                <Text style={styles.suggestionName}>Agent</Text>
              </View>
              <Text style={styles.agentSuggestionTag}>@{AGENT_HANDLES[0]}</Text>
            </Pressable>
          ) : (
            <Pressable key={person.id} testID={`mention-${person.id}`} accessibilityRole="button" accessibilityLabel={`Mention ${person.name}`} onPress={() => choose(person)} style={({ pressed }) => [styles.suggestion, pressed && { backgroundColor: colors.surface }]}>
              <Avatar name={person.name} userId={person.id} size={30} />
              <View style={{ flex: 1, marginLeft: space.sm }}><Text style={styles.suggestionName}>{person.name}</Text><Text style={styles.suggestionHandle}>{mentionText(person.name)}</Text></View>
            </Pressable>
          )) : <Text style={styles.noSuggestions}>No matches</Text>}
        </ScrollView>
      ) : null}
      <View style={[styles.composer, wide && styles.composerWide, focused && (wide ? styles.composerWideFocused : styles.composerFocused)]}>
        {onCancel ? <Text style={styles.editingLabel}>Editing message</Text> : null}
        <View>
        {highlight ? <Text aria-hidden importantForAccessibility="no-hide-descendants" style={[styles.input, styles.inputMirror]}>
          {mentionParts(text, mentionNames).map((part, i) => part.mention ? <Text key={i} style={styles.mention}>{part.text}</Text> : part.text)}{"\u200b"}
        </Text> : null}
        <TextInput
          editable={!busy || clearNow}
          ref={input}
          autoFocus={autoFocus}
          testID="composer-input"
          accessibilityLabel={placeholder}
          value={text}
          onChangeText={(t) => {
            // Browsers don't reliably fire `select` while typing, so read the
            // caret from the textarea; mention suggestions depend on it.
            const node = input.current as unknown as { selectionStart?: unknown; selectionEnd?: unknown } | null;
            if (Platform.OS === "web" && typeof node?.selectionStart === "number" && typeof node.selectionEnd === "number") {
              const caret = { start: node.selectionStart, end: node.selectionEnd };
              latest.current = { ...latest.current, selection: caret };
              setSelection(caret);
            }
            latest.current = { ...latest.current, text: t };
            setText(t);
            setInsertedSelection(undefined);
            onTyping?.(t);
          }}
          selection={insertedSelection}
          onSelectionChange={({ nativeEvent }) => {
            latest.current = { ...latest.current, selection: nativeEvent.selection };
            setSelection(nativeEvent.selection);
          }}
          onFocus={() => { clearTimeout(blurTimer.current); setFocused(true); }}
          // Tapping a name in the mention list blurs the box first; keep the list long enough
          // for that tap to land (otherwise it closes under the finger).
          onBlur={() => { blurTimer.current = setTimeout(() => setFocused(false), 250); }}
          placeholder={placeholder}
          placeholderTextColor={colors.muted}
          multiline
          style={[styles.input, highlight && styles.inputOverlay]}
          cursorColor={colors.ink}
          selectionColor={Platform.OS === "web" ? undefined : colors.blue}
          onKeyPress={Platform.OS === "web" ? (event) => {
            const key = event.nativeEvent as unknown as KeyboardEvent;
            // Escape leaves an edit unsaved, like Slack.
            if (onCancel && key.key === "Escape" && !key.isComposing && !busy && !sending.current) {
              event.preventDefault();
              onCancel();
              return;
            }
            if (onEditLast && shouldEditLastMessage(key, {
              text: latest.current.text, attachmentCount: files.length, busy: busy || sending.current,
              picking: picking || pendingPastes.current > 0, listening: dictation.listening, editing: !!onCancel,
            })) {
              event.preventDefault();
              onEditLast();
              return;
            }
            // Return sends (or picks the top mention); Shift+Return adds a line.
            if (!enterSends || key.key !== "Enter" || key.shiftKey || key.isComposing) return;
            event.preventDefault();
            if (suggestions[0]) choose(suggestions[0]);
            else void send();
          } : undefined}
          blurOnSubmit={false}
        />
        </View>
        {files.length ? <DraftAttachments files={files} disabled={busy || picking} onRemove={i => setFiles(old => old.filter((_, index) => index !== i))} /> : null}
        {!onCancel && allowAttachments && attachmentMenu ? <View style={styles.attachmentMenu}>
          <Pressable accessibilityRole="button" accessibilityLabel="Attach photos or videos" accessibilityState={{ disabled: busy || picking }} disabled={busy || picking} onPress={() => pick(true)} style={styles.attachmentChoice}>
            <AppIcon name="plus" size={18} color={colors.ink} /><Text style={styles.attachmentText}>Photos & videos</Text>
          </Pressable>
          {allowFileAttachments ? <Pressable accessibilityRole="button" accessibilityLabel="Attach files" accessibilityState={{ disabled: busy || picking }} disabled={busy || picking} onPress={() => pick(false)} style={styles.attachmentChoice}>
            <AppIcon name="paperclip" size={18} color={colors.ink} /><Text style={styles.attachmentText}>Files</Text>
          </Pressable> : null}
          {allowDocuments ? <Pressable accessibilityRole="button" accessibilityLabel="Attach documents or design files, up to 100 MB each" accessibilityState={{ disabled: busy || picking }} disabled={busy || picking} onPress={() => pick(false, true)} style={styles.attachmentChoice}>
            <AppIcon name="paperclip" size={18} color={colors.ink} /><Text style={styles.attachmentText}>Documents</Text>
          </Pressable> : null}
        </View> : null}
        <View style={styles.composerToolbar}>
          {onCancel ? <Pressable accessibilityRole="button" onPress={onCancel} style={styles.cancel}><Text style={styles.cancelText}>Cancel</Text></Pressable>
            : allowAttachments ? <Pressable accessibilityRole="button" accessibilityLabel={attachmentMenu ? "Close attachment options" : "Add attachments"} accessibilityState={{ disabled: busy || picking, expanded: attachmentMenu }} aria-expanded={attachmentMenu} disabled={busy || picking} onPress={() => setAttachmentMenu(open => !open)} style={[styles.attachmentButton, attachmentMenu && styles.attachmentButtonSelected]}>
              <AppIcon name={attachmentMenu ? "close" : "plus"} size={21} color={colors.muted} />
            </Pressable> : null}
          {selection.end > selection.start && !dictation.listening ? <Pressable testID="composer-copy" accessibilityRole="button" accessibilityLabel="Copy the highlighted text" onPress={copySelected} style={styles.copySelected}>
            <AppIcon name="copy" size={17} color={colors.blue} /><Text style={styles.copySelectedText}>{copiedSelected ? "Copied" : "Copy"}</Text>
          </Pressable> : null}
          <Text style={[styles.composerHint, holdHint && styles.composerHintEnd]} numberOfLines={1} accessibilityLiveRegion="polite">{dictation.listening ? (dictation.partial || "Listening…") : picking ? "Adding attachment…" : holdHint ? "Hold to queue" : onCancel && enterSends ? "Esc to cancel, Enter to save" : ""}</Text>
          {!onCancel && dictation.available ? <Pressable testID="composer-dictate" accessibilityRole="button" accessibilityLabel={dictation.listening ? "Stop dictation" : "Dictate a message"} accessibilityState={{ disabled: busy, selected: dictation.listening }} aria-pressed={dictation.listening} disabled={busy} onPress={dictation.toggle} style={[styles.dictate, dictation.listening && styles.dictateOn]}>
            <AppIcon name={dictation.listening ? "stop" : "mic"} size={21} color={dictation.listening ? colors.onPrimary : colors.muted} />
          </Pressable> : null}
          <Pressable testID={canStop ? "composer-stop" : "composer-send"} accessibilityRole="button" accessibilityLabel={busy ? "Sending message" : canStop ? "Stop the agent" : sendLabel === "Send" ? "Send message" : sendLabel}
            accessibilityHint={canStop ? "Stops the reply in progress. What it wrote so far stays" : holdHint ? "Adds it to the reply in progress. Touch and hold to send it after that reply instead" : undefined}
            accessibilityState={{ disabled: off && !canStop, busy }} onPressIn={sendOnPressIn} onPressOut={sendOnPressOut} onPress={sendOnPress} onLongPress={holdToQueue ? sendOnLongPress : undefined} delayLongPress={400}
            accessibilityActions={holdHint ? [{ name: "longpress", label: "Send after the current reply" }] : undefined} onAccessibilityAction={event => { if (event.nativeEvent.actionName === "longpress" && ready()) void send("queue"); }}
            disabled={busy || picking} style={({ pressed }) => [styles.send, off && !canStop && styles.sendDisabled, pressed && (!off || canStop) && { backgroundColor: colors.primaryPressed }]}>
            {busy ? <ActivityIndicator size="small" color={colors.muted} /> : canStop ? <View style={styles.stopMark} />
              : sendLabel === "Send" ? <AppIcon name="send" size={19} color={off ? colors.muted : colors.onPrimary} /> : <Text style={[styles.sendText, off && { color: colors.muted }]}>{sendLabel}</Text>}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export function ConversationRow({ c, onPress, onLongPress, longPressHint, accessibilityActions, onAccessibilityAction, trailing, compact = false, lifted = false }: { c: Conversation; onPress: () => void; trailing?: ReactNode; compact?: boolean; longPressHint?: string; lifted?: boolean } & Pick<PressableProps, "onLongPress" | "accessibilityActions" | "onAccessibilityAction">) {
  const styles = useStyles();
  const { colors } = useTheme();
  const me = useSession().account?.user.id;
  const preview = conversationPreview(c, me);
  const groupPeople = (c.members ?? []).filter(p => !p.agent && p.id !== me);
  const bold = c.unread > 0 && !c.archived;
  const title = c.kind === "channel" ? `#${c.title}` : c.title;
  return (
    <View style={[styles.rowContainer, compact && styles.compactRowContainer]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}${c.private && c.kind === "channel" ? ", private" : ""}${bold ? `, ${c.unread} unread` : ""}${compact ? "" : `. ${preview}`}`}
        onPress={onPress}
        onLongPress={onLongPress}
        accessibilityHint={longPressHint ?? (onLongPress ? "Swipe left or long press to archive or delete" : undefined)}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={onAccessibilityAction}
        style={({ pressed }) => [styles.row, compact && styles.compactRow, trailing ? styles.rowWithTrailing : null, pressed && !lifted && { backgroundColor: colors.surface }]}
      >
        {c.kind === "dm" ? (groupPeople.length > 1 ? <GroupAvatar people={groupPeople} size={compact ? 26 : 40} /> : <Avatar name={c.title} agent={c.agentDm} userId={dmPeer(c, me)} size={compact ? 26 : 40} />) : <View style={[styles.channelGlyph, compact && styles.compactChannelGlyph]}><AppIcon name={c.private ? "lock" : "hash"} size={compact ? 19 : 22} color={bold ? colors.ink : colors.muted} /></View>}
        <View style={styles.rowCopy}>
          <View style={styles.rowTop}>
            <Text style={[styles.rowTitle, bold && styles.bold]}>{c.title}</Text>
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

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  activity: { paddingHorizontal: space.side, paddingVertical: 3, alignItems: "center" },
  activityText: { ...typography.meta, color: colors.muted, textAlign: "center" },
  dateSeparator: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.side, paddingVertical: space.sm, marginVertical: space.xxs },
  dateLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  dateLabel: { ...typography.captionStrong, color: colors.ink, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: space.xxs },
  // The same row as the day's, in the unread badges' color: a rule across, ending in a filled "New".
  unreadSeparator: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.side, paddingVertical: space.xs },
  unreadRule: { flex: 1, height: 1, backgroundColor: colors.primary },
  unreadLabel: { ...typography.captionStrong, color: colors.onPrimary, backgroundColor: colors.primary, borderRadius: radius.pill, paddingHorizontal: space.xs, overflow: "hidden" },
  reactions: { flexDirection: "row", flexWrap: "wrap", gap: space.xxs, marginTop: 0 },
  reaction: { minHeight: 44, minWidth: 44, justifyContent: "center" },
  reactionPill: { minHeight: 28, minWidth: 42, paddingHorizontal: space.xs, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  selectedReaction: { backgroundColor: colors.blueSoft, borderColor: colors.blue },
  reactionText: { ...typography.label, color: colors.ink },
  more: { position: "absolute", right: -space.xs, top: -space.xxs, minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  moreText: { ...typography.label, color: colors.muted },
  menuOverlay: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: space.side, backgroundColor: colors.scrim },
  menuCard: { width: "100%", maxWidth: 420, maxHeight: "100%", backgroundColor: colors.background, borderRadius: radius.lg, padding: space.side },
  forwardCard: { borderLeftWidth: 3, borderLeftColor: colors.blue, paddingLeft: space.sm, paddingVertical: 2, marginTop: 2, marginBottom: space.xxs, gap: 2 },
  forwardLabel: { ...typography.captionStrong, color: colors.ink },
  forwardWhere: { ...typography.meta, fontWeight: "400", color: colors.muted },
  copyStatus: { ...typography.caption, color: colors.muted, marginVertical: space.xs },
  menuAuthor: { ...typography.bodyStrong, color: colors.ink, marginBottom: space.xs },
  menuPreview: { ...typography.body, color: colors.muted, marginTop: space.xs, marginBottom: space.md },
  reactionWho: { ...typography.body, color: colors.ink, paddingVertical: space.xxs },
  menuTitle: { ...typography.label, color: colors.muted, marginTop: space.xs, marginBottom: space.xs },
  emojiGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.xxs, marginBottom: space.sm },
  emojiButton: { width: 48, height: 48, borderRadius: radius.md, borderWidth: 1, borderColor: "transparent", justifyContent: "center", alignItems: "center" },
  emoji: { fontSize: 28 },
  contextReactions: { flexDirection: "row", justifyContent: "space-between" },
  contextEmoji: { flex: 1, height: 44, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
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
  link: { color: colors.blue, textDecorationLine: "underline" },
  deleted: { ...typography.body, color: colors.muted, fontStyle: "italic" },
  edited: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  receipt: { alignSelf: "flex-end", marginTop: 2 },
  // A reply also sent to the conversation: what it answers, above its words. "View thread" under it opens the rest.
  alsoSent: { ...typography.caption, color: colors.muted },
  replies: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginTop: space.xxs, minHeight: 44 },
  repliesText: { ...typography.captionStrong, color: colors.blue, ...linkUnderline },
  composerWrap: { backgroundColor: colors.background, paddingHorizontal: space.sm, paddingTop: space.xs },
  composerError: { ...typography.caption, color: colors.red, paddingHorizontal: space.xs, paddingBottom: space.xs },
  attachmentMenu: { flexDirection: "row", gap: space.xs, marginHorizontal: space.xs, paddingVertical: space.xxs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  attachmentChoice: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 44, paddingHorizontal: space.sm, borderRadius: radius.sm, backgroundColor: colors.surface },
  attachmentButton: { minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "center", borderRadius: radius.sm },
  attachmentButtonSelected: { backgroundColor: colors.surface },
  attachmentText: { ...typography.captionStrong, color: colors.ink },
  suggestions: { maxHeight: 190, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  suggestion: { flexDirection: "row", alignItems: "center", minHeight: 56, paddingHorizontal: space.side, paddingVertical: space.xs },
  agentSuggestion: { backgroundColor: colors.blueSoft, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  agentSuggestionTag: { ...typography.captionStrong, color: colors.blueDark, backgroundColor: colors.background, paddingHorizontal: space.xs, paddingVertical: space.xxs, borderRadius: radius.sm, overflow: "hidden" },
  suggestionName: { ...typography.bodyStrong, color: colors.ink },
  dictate: { width: 44, height: 44, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", marginRight: space.xs },
  dictateOn: { backgroundColor: colors.danger },
  suggestionRow: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginTop: space.xs },
  chip: { minHeight: 44, paddingHorizontal: space.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.blue, backgroundColor: colors.blueSoft, justifyContent: "center" },
  chipText: { ...typography.label, color: colors.blueDark },
  agentAvatar: { width: 30, height: 30, borderRadius: radius.pill, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  suggestionHandle: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  noSuggestions: { ...typography.caption, paddingHorizontal: space.side, paddingVertical: space.sm, color: colors.muted },
  composer: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, backgroundColor: colors.background, overflow: "hidden" },
  composerFocused: { borderColor: colors.blue },
  // Desktop: a soft floating card, closer to Slack and ChatGPT than a form field.
  composerWrapWide: { paddingHorizontal: space.side + space.xxs },
  composerWide: { borderColor: colors.line, borderRadius: radius.lg + 4, boxShadow: "0 1px 2px rgba(16,24,40,0.04), 0 4px 16px rgba(16,24,40,0.06)" },
  composerWideFocused: { borderColor: colors.borderStrong },
  composerToolbar: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.xxs, paddingBottom: space.xxs, minHeight: 48 },
  copySelected: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.xxs, paddingHorizontal: space.xs },
  copySelectedText: { ...typography.label, color: colors.blue, ...linkUnderline },
  composerHint: { ...typography.meta, color: colors.muted, flex: 1, paddingHorizontal: space.xs },
  // "Hold to queue" is about the Send button, so it sits against it.
  composerHintEnd: { textAlign: "right" },
  editingLabel: { ...typography.captionStrong, color: colors.muted, paddingTop: space.xs, paddingHorizontal: space.sm },
  input: { ...typography.body, minHeight: 44, maxHeight: 144, paddingHorizontal: space.sm, paddingTop: space.sm, paddingBottom: space.xs, color: colors.ink, backgroundColor: colors.background },
  // The colored copy behind the box, and the box made see-through over it (caret stays visible).
  inputMirror: { position: "absolute", top: 0, left: 0, right: 0, color: colors.ink, backgroundColor: colors.background, overflow: "hidden" },
  // The composer's border already shows focus; the browser's own ring would draw a line inside it.
  // Not "transparent": on Android that is the integer 0, which React Native reads as "no color set",
  // so the real text drew in the default dark color over the blue copy (doubled, bolder text).
  // One step of alpha is invisible and not zero.
  inputOverlay: { color: "#00000001", backgroundColor: "transparent", ...(Platform.OS === "web" ? { caretColor: colors.ink, outlineStyle: "none" } as object : {}) },
  send: { minHeight: 44, minWidth: 44, paddingHorizontal: space.sm, borderRadius: radius.sm, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  sendDisabled: { backgroundColor: colors.subtle },
  // A solid square: stop. Drawn, not the outlined icon, so it can't be read as an empty box.
  stopMark: { width: 12, height: 12, backgroundColor: colors.onPrimary },
  sendText: { ...typography.label, color: colors.onPrimary },
  cancel: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.xs },
  cancelText: { ...typography.label, color: colors.blue, ...linkUnderline },
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
  badge: { minWidth: 22, minHeight: 22, borderRadius: radius.pill, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  badgeText: { ...typography.captionStrong, color: colors.onPrimary },
}));
