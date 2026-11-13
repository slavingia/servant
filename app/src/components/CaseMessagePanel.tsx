import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { ActivityIndicator, AppState, FlatList, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { randomUUID } from "expo-crypto";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppIcon } from "./AppIcon";
import { Button } from "./Button";
import { Avatar } from "./Messaging";
import { shareAttachment } from "./MediaGallery";
import { createInboxDraftId, createInboxLane, inboxCursor, mergeInboxMessages, pollInbox, type InboxAudience, type InboxClient, type InboxFile, type InboxMessage, type InboxNote, type InboxUpload } from "../lib/secure-inbox";
import { pickInboxFiles } from "../lib/secure-inbox-files";
import { formatFileSize } from "../lib/media";
import { createThemedStyles, linkUnderline, radius, space, typography, useTheme } from "../lib/theme";

type Entry = InboxMessage | InboxNote;
type Props = { client: InboxClient; id: string; audience: InboxAudience; visitorName: string; active: boolean; compact: boolean; onFocusChange: (focused: boolean) => void; onChanged: () => void };

/** Two permanently separate instances own their own drafts, files, request IDs and fixed API lanes. */
export function CaseMessagePanel({ client, id, audience, visitorName, active, compact, onFocusChange, onChanged }: Props) {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const team = audience === "team";
  const lane = useMemo(() => createInboxLane(client, id, audience), [client, id, audience]);
  const [messages, setMessages] = useState<Entry[] | null>(null);
  const history = useRef<Entry[]>([]);
  const readThrough = useRef(0);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<InboxUpload[]>([]);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [focused, setFocused] = useState(false);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [draft] = useState(() => createInboxDraftId(randomUUID));
  const mounted = useRef(true);
  const actions = useRef(new AbortController());
  useEffect(() => {
    mounted.current = true;
    actions.current = new AbortController();
    return () => { mounted.current = false; actions.current.abort(); };
  }, []);
  useFocusEffect(useCallback(() => {
    if (!active) return;
    return pollInbox(async signal => {
      if ((AppState.currentState && AppState.currentState !== "active") || (Platform.OS === "web" && document.hidden)) return;
      let more = false;
      do {
        const after = inboxCursor(history.current);
        const page = await lane.page(after, signal);
        if (signal.aborted) return;
        history.current = mergeInboxMessages(history.current, page.items);
        if (page.hasMore && inboxCursor(history.current) <= after) throw new Error("Couldn't load the next messages. Try again.");
        setMessages(history.current);
        more = page.hasMore;
      } while (more);
      const through = inboxCursor(history.current);
      if (through > readThrough.current) {
        await lane.read(through, signal);
        if (signal.aborted) return;
        readThrough.current = through;
      }
      setLoadError("");
    }, cause => setLoadError(cause instanceof Error ? cause.message : "Couldn't load these messages. Try again."));
    // A send or manual retry restarts the focused poll immediately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lane, active, attempt]));

  const send = async () => {
    if (busy || picking || (!text.trim() && !files.length)) return;
    setBusy(true); setError("");
    try {
      await lane.send(text, files, draft.current(), actions.current.signal);
      if (!mounted.current) return;
      setText(""); setFiles([]); draft.reset();
      setAttempt(value => value + 1); onChanged();
    } catch (cause) { if (mounted.current) setError(`${cause instanceof Error ? cause.message : team ? "Couldn't save the team note." : "Couldn't send your reply."} Your draft is kept. Try sending again.`); }
    finally { if (mounted.current) setBusy(false); }
  };
  const attach = async () => {
    if (busy || picking) return;
    setPicking(true); setError("");
    try {
      const chosen = await pickInboxFiles(files);
      if (mounted.current && chosen.length) { setFiles(current => [...current, ...chosen]); draft.reset(); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Couldn't attach the files. Choose them again."); }
    finally { if (mounted.current) setPicking(false); }
  };
  const download = async (file: InboxFile) => {
    if (downloading) return;
    setDownloading(file.id); setError("");
    try {
      const downloaded = await lane.file(file.id, actions.current.signal);
      if (mounted.current) await shareAttachment(downloaded, downloaded.data);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Couldn't download the file. Try again."); }
    finally { if (mounted.current) setDownloading(null); }
  };

  return <View style={[styles.root, !active && styles.hidden]} accessibilityElementsHidden={!active} importantForAccessibility={active ? "auto" : "no-hide-descendants"}>
    {!(compact && focused) ? <View style={[styles.audience, team && styles.teamAudience]}><AppIcon name={team ? "lock" : "chat"} size={17} color={colors.muted} /><View style={styles.audienceCopy}><Text style={styles.audienceTitle}>{team ? "Private to your team" : `Conversation with ${visitorName}`}</Text><Text style={styles.caption}>{team ? "Notes and files here are visible only to your teammates." : "Replies and files here are shared with the visitor."}</Text></View></View> : null}
    {messages === null && !loadError ? <View style={styles.center}><ActivityIndicator color={colors.blue} accessibilityLabel={team ? "Loading team notes" : "Loading conversation"} /></View> : <FlatList testID={team ? "team-message-history" : "public-message-history"} inverted data={[...(messages ?? [])].reverse()} keyExtractor={message => message.id} style={styles.messages} contentContainerStyle={styles.messageContent} keyboardShouldPersistTaps="handled"
      ListEmptyComponent={!loadError ? <Text style={styles.empty}>{team ? "Keep context, decisions, and working files here for the team." : "Share the visitor link or send a reply to start this conversation."}</Text> : undefined}
      renderItem={({ item }) => <MessageRow message={item} team={team} downloading={downloading} onDownload={file => void download(file)} />} />}
    <ScrollView style={styles.composerScroll} contentContainerStyle={[styles.composer, { paddingBottom: Math.max(insets.bottom, space.sm) }]} keyboardShouldPersistTaps="handled">
      {error || loadError ? <Text accessibilityRole="alert" style={styles.error}>{error || loadError}</Text> : null}
      <View style={styles.composerLabel}><Text style={styles.replyTo}>{team ? "Team note · Private to your team" : `Reply to ${visitorName}`}</Text>{compact && focused ? <Button label="Done" accessibilityLabel="Done writing" compact kind="link" onPress={() => input.current?.blur()} /> : null}</View>
      {files.map((file, index) => <View key={`${index}:${file.name}`} style={styles.draftFile}><AppIcon name="paperclip" size={16} color={colors.muted} /><Text style={styles.draftName}>{file.name} · {formatFileSize(file.size)}</Text><Button compact kind="danger" label="Remove" accessibilityLabel={`Remove ${team ? "team " : ""}${file.name}`} disabled={busy} onPress={() => { setFiles(current => current.filter((_, i) => i !== index)); draft.reset(); }} /></View>)}
      <TextInput ref={input} accessibilityLabel={team ? "Team note" : "Reply"} placeholder={team ? "Add context for your team…" : "Write a reply…"} placeholderTextColor={colors.muted} value={text} editable={!busy} onFocus={() => { setFocused(true); onFocusChange(true); }} onBlur={() => { setFocused(false); onFocusChange(false); }} onChangeText={value => { setText(value); draft.reset(); }} multiline maxLength={10000} style={[styles.input, compact && styles.compactInput]} />
      <View style={[styles.composerActions, compact && styles.compactActions]}><Button label={team ? "Attach team files" : "Attach files"} compact kind="link" busy={picking} disabled={busy || files.length >= 4} onPress={() => void attach()} style={compact ? styles.compactAction : undefined} />{!compact ? <Text style={styles.limit}>4 files · 5 MB each</Text> : null}<Button label={team ? "Add team note" : "Send reply"} compact busy={busy} disabled={picking || (!text.trim() && !files.length)} onPress={() => void send()} style={compact ? styles.compactAction : undefined} /></View>
    </ScrollView>
  </View>;
}

// The same left-aligned author stream as channels and direct messages: who, in what role, when, then the words.
function MessageRow({ message, team, downloading, onDownload }: { message: Entry; team: boolean; downloading: string | null; onDownload: (file: InboxFile) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const staff = !team && "sender" in message && message.sender === "staff";
  return <View style={styles.message}>
    <Avatar name={message.senderName} size={34} />
    <View style={styles.messageCopy}>
      <View style={styles.messageHead}>
        <Text style={styles.sender}>{message.senderName}</Text>
        {!team ? <Text style={styles.role}>{staff ? "Team" : "Visitor"}</Text> : null}
        <Text style={styles.timestamp}>{new Date(message.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</Text>
      </View>
      {message.text ? <Text selectable style={styles.messageText}>{message.text}</Text> : null}
      {message.attachments.map(file => <Pressable key={file.id} accessibilityRole="button" accessibilityLabel={`Download ${team ? "team file " : ""}${file.name}`} disabled={!!downloading} onPress={() => onDownload(file)} style={({ pressed }) => [styles.attachment, pressed && { backgroundColor: colors.surface }]}>
        {downloading === file.id ? <ActivityIndicator color={colors.blue} size="small" /> : <AppIcon name="paperclip" size={19} color={colors.muted} />}
        <View style={styles.fileCopy}><Text style={styles.fileName}>{file.name}</Text><Text style={styles.caption}>{formatFileSize(file.size)} · Download</Text></View>
      </Pressable>)}
    </View>
  </View>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, minHeight: 0 }, hidden: { display: "none" }, center: { flex: 1, justifyContent: "center", alignItems: "center" },
  audience: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.side, paddingVertical: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line }, teamAudience: { backgroundColor: colors.surface }, audienceCopy: { flex: 1 }, audienceTitle: { ...typography.captionStrong, color: colors.ink }, caption: { ...typography.caption, color: colors.muted }, empty: { ...typography.body, color: colors.muted, padding: space.lg, textAlign: "center" },
  messages: { flex: 1 }, messageContent: { padding: space.side, gap: space.md },
  message: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  messageCopy: { flex: 1, minWidth: 0, gap: space.xxs },
  messageHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: space.xs },
  sender: { ...typography.bodyStrong, color: colors.ink },
  role: { ...typography.caption, color: colors.muted },
  messageText: { ...typography.body, color: colors.ink },
  timestamp: { ...typography.meta, color: colors.muted },
  attachment: { alignSelf: "flex-start", maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 48, marginTop: space.xxs, paddingVertical: space.xs, paddingHorizontal: space.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background },
  fileCopy: { flexShrink: 1 }, fileName: { ...typography.bodyStrong, color: colors.blue, ...linkUnderline },
  composerScroll: { flexGrow: 0, flexShrink: 1 }, composer: { padding: space.sm, gap: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, backgroundColor: colors.background }, composerLabel: { flexDirection: "row", alignItems: "center", gap: space.xs, justifyContent: "space-between" }, replyTo: { ...typography.captionStrong, color: colors.muted, paddingHorizontal: space.xxs, flexShrink: 1 }, input: { ...controls.input, minHeight: 76, maxHeight: 180, textAlignVertical: "top" }, compactInput: { minHeight: 48, maxHeight: 100 }, composerActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs }, compactActions: { justifyContent: "space-between" }, compactAction: { paddingHorizontal: space.xs }, limit: { ...typography.meta, color: colors.muted, flex: 1, textAlign: "center" },
  draftFile: { flexDirection: "row", alignItems: "center", gap: space.xs, backgroundColor: colors.surface, paddingLeft: space.sm, borderRadius: radius.sm }, draftName: { ...typography.caption, color: colors.ink, flex: 1 }, error: { ...typography.caption, color: colors.red },
}));
