import { useEffect, useRef, useState } from "react";
import { AppState, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type TextStyle } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { randomUUID } from "expo-crypto";
import { File } from "expo-file-system";
import { AppIcon, type AppIconName } from "../components/AppIcon";
import { Button } from "../components/Button";
import { ProjectSheet } from "../components/ProjectSheet";
import { documentReader, draftsFromShared, type DraftAttachment } from "../components/Attachments";
import { DraftVideoPreview } from "../components/VideoMedia";
import { uploadDocument } from "../lib/document-upload";
import { landingHref, useFeatures } from "../lib/features";
import { claimShareRoute, clearPendingShare, pendingSharePayloads, resolvePendingShare } from "../lib/incoming-share";
import { useLiveActions } from "../lib/live";
import { formatFileSize } from "../lib/media";
import { choiceKey, lastChatKey } from "../lib/new-chat-choice";
import { useProjects } from "../lib/projects-store";
import { PII_DECLINED, withPiiConfirm } from "../lib/pii-warning";
import { usePiiConfirm } from "../components/PiiConfirm";
import { api, sendMessage, uploadPost, type Upload } from "../lib/server";
import { useSession } from "../lib/session";
import { describeShare, EMPTY_SHARE, nameCharsFor, needsResolution, parseSharedPayloads, sendBlockedReason, shareLimitError, shareProblems, shortenFileName, type SharedContent, type SharedFile } from "../lib/share-payload";
import { sampleShare } from "../lib/share-sample";
import { continueHint, defaultShareProject, progressLabel, sendShare, ShareSendError, type ShareChat, type ShareProgress, type ShareSendDeps, type ShareStage, type ShareTarget } from "../lib/share-send";
import { getItem, setItem } from "../lib/storage";
import { radius, space, typography, useTheme, createThemedStyles, linkUnderline } from "../lib/theme";
import { Toggle } from "../components/Toggle";
import { ServeLoader } from "../components/ServeLoader";

// "Send to agent": where a share from another app lands (expo-sharing, +native-intent.tsx). Shows
// what was shared, lets the person pick a project (or continue their last chat) and add a message,
// then sends it the way the chat composer would: documents in chunks first, then the message with
// everything attached, and opens the chat. The share waits natively until it's sent or dropped,
// so signing in or confirming it's you in between loses nothing. On the web, ?sample= shows a
// made-up share (share-sample.ts).
export default function ShareScreen() {
  const { ask: askPii, dialog: piiDialog } = usePiiConfirm();
  const styles = useStyles();
  const { colors } = useTheme();
  const { account, setAccount } = useSession();
  const { refreshAgent } = useLiveActions();
  const landing = landingHref(useFeatures());
  const { sample } = useLocalSearchParams<{ sample?: string }>();
  const projects = useProjects();
  const [content, setContent] = useState<SharedContent | null>(null);
  const [message, setMessage] = useState("");
  const [remembered, setRemembered] = useState<string | null>(null);
  // null until the person picks; the Agent tab's remembered project applies until then.
  const [picked, setPicked] = useState<{ id: string | null } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [lastChat, setLastChat] = useState<ShareChat | null>(null);
  const [continueLast, setContinueLast] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ShareProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What an earlier try already did, so Send again never makes a second chat or re-reads the files.
  const attempt = useRef<{ requestId: string; chat: ShareChat | null; drafts: DraftAttachment[] | null; uploads: Upload[] | null; stage: ShareStage | null }>({ requestId: randomUUID(), chat: null, drafts: null, uploads: null, stage: null });
  const userId = account?.user.id;

  // What was shared. Files are resolved first (copied where the app can read them, with names and
  // sizes). A share that arrives while this screen is already open replaces what it shows.
  const sending = useRef(false);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const raw = pendingSharePayloads();
      let found: SharedContent;
      if (raw.length) {
        claimShareRoute(raw);
        const resolved = needsResolution(raw) ? await resolvePendingShare() : null;
        found = parseSharedPayloads(raw, resolved);
      } else {
        found = (Platform.OS === "web" ? sampleShare(sample) : null) ?? EMPTY_SHARE;
      }
      if (!live || sending.current) return;
      attempt.current = { requestId: randomUUID(), chat: null, drafts: null, uploads: null, stage: null };
      setContent(found);
      setMessage(found.text);
      setError(null);
    };
    const timer = setTimeout(() => { void load(); }, 0);
    const sub = AppState.addEventListener("change", state => {
      if (state !== "active" || sending.current) return;
      const raw = pendingSharePayloads();
      if (raw.length && claimShareRoute(raw)) void load();
    });
    return () => { live = false; clearTimeout(timer); sub.remove(); };
  }, [sample]);

  // The project the Agent tab would use, and the chat the person was last in.
  useEffect(() => {
    if (!account) return;
    let live = true;
    void getItem(choiceKey(account.user.id)).then(value => { if (live) setRemembered(value || null); }).catch(() => {});
    void getItem(lastChatKey(account.user.id)).then(id => id ? api.chat(account, id) : null).then(chat => {
      if (live && chat && !chat.archived && !chat.readOnly) setLastChat({ id: chat.id, title: chat.title });
    }).catch(() => {});
    return () => { live = false; };
  }, [account]);

  if (!account) return null;
  const projectId = picked ? picked.id : defaultShareProject(projects, remembered);
  const projectName = projectId ? projects?.list.find(project => project.id === projectId)?.name ?? "Project" : "No project";
  const toLastChat = continueLast && !!lastChat;
  const showProject = projects !== null && !projects.vibeCoder && !toLastChat;
  const target: ShareTarget = toLastChat ? { kind: "chat", id: lastChat.id, title: lastChat.title } : { kind: "new", projectId };
  const empty = content !== null && !content.files.length && !content.text && !message.trim();
  // The files that can't go and why (each on its card), and the line beside a Send that waits for them to be removed.
  const problems = shareProblems(content?.files ?? []);
  const blocked = sendBlockedReason(content?.files ?? []);

  // Best effort: the copies the extension (iPhone) or the intent (Android) left for us are no longer needed.
  const tidy = (files: readonly SharedFile[]) => {
    if (Platform.OS === "web") return;
    for (const file of files) {
      if (!file.uri.startsWith("file://")) continue;
      try { const copy = new File(file.uri); if (copy.exists) copy.delete(); } catch { /* already gone */ }
    }
  };
  const leave = () => { if (router.canGoBack()) router.back(); else router.replace(landing); };
  // The share is over without being sent: nothing stays pending natively, and a chat made for a try that never
  // reached the server is empty, so it doesn't stay behind either.
  const dropShare = () => {
    clearPendingShare();
    const made = attempt.current.chat;
    if (made && attempt.current.stage !== "send" && target.kind === "new") void api.deleteChat(account, made.id).catch(() => {});
  };
  const cancel = () => { dropShare(); tidy(content?.files ?? []); leave(); };
  // Remove on a file card: the rest still goes. An earlier try's read files no longer match, so they're read again;
  // the chat it made is still good. With nothing left to send the share is over, the same as "Don't send".
  const removeFile = (file: SharedFile) => {
    if (!content || busy) return;
    const files = content.files.filter(other => other.uri !== file.uri);
    setContent({ ...content, files });
    attempt.current.drafts = null; attempt.current.uploads = null;
    setError(null);
    tidy([file]);
    if (!files.length && !content.text && !message.trim()) dropShare();
  };

  const send = async () => {
    if (!content || busy) return;
    const body = message.trim();
    if (!body && !content.files.length) { setError("Add a message or share a file first"); return; }
    const limit = shareLimitError(content.files);
    if (limit) { setError(limit); return; }
    setBusy(true); setError(null); setProgress(null);
    sending.current = true;
    const deps: ShareSendDeps = {
      newChat: options => api.newChat(account, options),
      uploadDocument: (chatId, file, onProgress) => uploadDocument({ chatId, name: file.name, size: file.document!.size, read: documentReader(file.document!), post: uploadPost(account, setAccount), onProgress }),
      send: (chatId, text, uploads, requestId, onEvent, signal) => withPiiConfirm(askPii, confirmPii => sendMessage(account, chatId, text, onEvent, signal, setAccount, uploads, requestId, undefined, confirmPii)),
    };
    try {
      // Read the files the way the composer's pickers do: photos shrunk under 5 MB, videos under 25 MB, the rest as documents.
      const drafts = attempt.current.drafts ?? await draftsFromShared(content.files);
      attempt.current.drafts = drafts;
      const uploads = attempt.current.uploads ?? drafts.map(({ name, data, document }): Upload => document ? { name, data, document } : { name, data });
      const chat = await sendShare({ text: body, uploads, target, requestId: attempt.current.requestId, reuse: target.kind === "new" ? attempt.current.chat : null, onProgress: setProgress, deps });
      clearPendingShare();
      tidy(content.files);
      if (picked && userId) void setItem(choiceKey(userId), picked.id ?? "").catch(() => {});
      refreshAgent();
      router.replace({ pathname: "/chat/[id]", params: { id: chat.id, title: chat.title } });
    } catch (e) {
      if (e instanceof ShareSendError) { attempt.current.chat = e.chat ?? attempt.current.chat; attempt.current.uploads = e.uploads; attempt.current.stage = e.stage; }
      // Declining the personal-information warning keeps the draft and the chat; nothing to report.
      if (!(e instanceof Error && e.message === PII_DECLINED)) setError(e instanceof Error && e.message ? e.message : "Couldn't send. Check your connection and try again.");
    } finally {
      sending.current = false;
      setBusy(false); setProgress(null);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      {piiDialog}
      <Stack.Screen options={{ title: "Send to agent" }} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" testID="share">
        {content === null ? (
          <View style={styles.centered}>
            <ServeLoader />
            <Text accessibilityLiveRegion="polite" style={styles.hint}>Getting what you shared…</Text>
          </View>
        ) : empty ? (
          <View style={styles.centered}>
            <Text accessibilityRole="header" style={styles.emptyTitle}>Nothing to send</Text>
            <Button label="Back" kind="secondary" onPress={leave} style={styles.emptyAction} />
          </View>
        ) : (
          <>
            <Text accessibilityRole="header" style={styles.title}>{describeShare(content)}</Text>
            <Text style={styles.lead}>{toLastChat ? "Last agent chat" : `Private chat · ${account.serverName}${projectId ? ` · ${projectName}` : ""}`}</Text>
            <SharedItems files={content.files} url={content.url} problems={problems.files} onRemove={removeFile} disabled={busy} />
            {showProject ? (
              <Pressable testID="share-project" accessibilityRole="button" accessibilityLabel={`Project: ${projectName}`} accessibilityHint="Choose which project the chat belongs to"
                accessibilityState={{ expanded: choosing, disabled: busy }} aria-expanded={choosing} disabled={busy} onPress={() => setChoosing(true)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                <View style={styles.rowIcon}><AppIcon name="project" size={17} color={colors.blueDark} /></View>
                <View style={styles.rowCopy}>
                  <Text style={styles.rowLabel}>Project</Text>
                  <Text style={styles.rowValue}>{projectName}</Text>
                </View>
                <AppIcon name="chevronDown" size={16} color={colors.muted} />
              </Pressable>
            ) : null}
            {lastChat ? (
              <View>
                <View style={styles.row}>
                  <View style={styles.rowIcon}><AppIcon name="sparkles" size={17} color={colors.blueDark} /></View>
                  <View style={styles.rowCopy}>
                    <Text style={styles.rowLabel}>Continue my last chat</Text>
                    <Text style={styles.rowValue}>{lastChat.title.replace(/`/g, "")}</Text>
                  </View>
                  <Toggle testID="share-continue" label={`Continue my last chat, ${lastChat.title}`} hint={continueHint(projectId ? projectName : null, lastChat.title)} value={continueLast} disabled={busy} onValueChange={next => { setContinueLast(next); setError(null); }} />
                </View>
                {/* What each position does, in one line, so off is never a mystery. */}
                <Text testID="share-continue-hint" style={styles.rowHint}>{continueHint(projectId ? projectName : null, lastChat.title)}</Text>
              </View>
            ) : null}
            <Text style={styles.label} nativeID="shareMessageLabel">Message</Text>
            <TextInput
              testID="share-message"
              accessibilityLabelledBy="shareMessageLabel"
              accessibilityLabel="Message"
              value={message}
              onChangeText={text => { setMessage(text); setError(null); }}
              placeholder="Add a message…"
              placeholderTextColor={colors.muted}
              multiline
              editable={!busy}
              style={styles.input}
            />
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            {progress ? <Text accessibilityLiveRegion="polite" style={styles.progress}>{progressLabel(progress)}</Text> : null}
            {/* Send waits while a file can't go; the reason sits right beside it, in words and with the sign, never colour alone. */}
            {blocked ? <View style={styles.blockedRow} testID="share-blocked"><AppIcon name="warning" size={16} color={colors.red} /><Text accessibilityLiveRegion="polite" style={styles.blocked}>{blocked}</Text></View> : null}
            <Button label="Send" onPress={() => void send()} busy={busy} disabled={!!blocked || (!content.files.length && !message.trim())} style={blocked ? styles.actionTight : styles.action} />
            <Button label="Don't send" kind="link" onPress={cancel} disabled={busy} style={styles.cancel} />
          </>
        )}
      </ScrollView>
      {choosing && projects ? <ProjectSheet visible projects={projects.list} vibe={false} selected={projectId} title="Send to" onPick={id => { setPicked({ id }); setChoosing(false); setError(null); }} onClose={() => setChoosing(false)} /> : null}
    </KeyboardAvoidingView>
  );
}

const TILE = 104;
const kindWord = (file: SharedFile) => file.kind === "image" ? "Photo" : file.kind === "video" ? "Video" : file.kind === "audio" ? "Audio file" : "File";
const kindIcon = (file: SharedFile): AppIconName => file.kind === "image" ? "image" : file.kind === "video" ? "meetings" : file.kind === "audio" ? "speaker" : "paperclip";

// Thumbnails for photos and videos, cards for everything else, a card for a link. A file that can't go
// (share-payload.ts fileProblem) is always a card: a red edge, the warning sign and the reason in words,
// so colour is never the only tell. Every file has Remove, so one bad file never sinks the rest.
function SharedItems({ files, url, problems, onRemove, disabled }: { files: SharedFile[]; url: string | null; problems: Map<string, string>; onRemove: (file: SharedFile) => void; disabled: boolean }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const tiles = files.filter(file => (file.kind === "image" || file.kind === "video") && !problems.has(file.uri));
  const cards = files.filter(file => !tiles.includes(file));
  const sizeOf = (file: SharedFile) => file.size ? formatFileSize(file.size) : "";
  const meta = (file: SharedFile) => [sizeOf(file), file.name.split(".").pop()?.toLowerCase() || "File"].filter(Boolean).join(" · ");
  const describe = (file: SharedFile) => `${kindWord(file)} ${file.name}${file.size ? `, ${sizeOf(file)}` : ""}`;
  return (
    <View style={styles.items} testID="share-items">
      {tiles.length ? <View style={styles.tiles}>{tiles.map(file => (
        <View key={file.uri} style={styles.tile} testID="share-tile">
          <View accessible accessibilityLabel={describe(file)} style={styles.thumb}>
            {/* The whole picture, letterboxed when it must be: a caption along its edge stays readable. */}
            {file.kind === "image" ? <Image source={{ uri: file.uri }} style={StyleSheet.absoluteFill} resizeMode="contain" /> : <DraftVideoPreview uri={file.uri} name={file.name} />}
          </View>
          <FileName name={file.name} width={TILE} fontSize={typography.meta.fontSize} style={styles.tileName} />
          <RemoveButton name={file.name} compact disabled={disabled} onPress={() => onRemove(file)} />
        </View>
      ))}</View> : null}
      {cards.map(file => {
        const problem = problems.get(file.uri);
        return (
          <View key={file.uri} style={[styles.file, problem ? styles.fileProblem : null]} testID={problem ? "share-file-problem" : "share-file"}>
            <View accessible accessibilityLabel={problem ? `Can't be sent. ${problem}` : describe(file)} style={styles.fileBody}>
              <View style={[styles.fileIcon, problem ? styles.fileIconProblem : null]}><AppIcon name={problem ? "warning" : kindIcon(file)} size={21} color={problem ? colors.red : colors.blueDark} /></View>
              <View style={styles.rowCopy}>
                <FileName name={file.name} fontSize={typography.label.fontSize} style={styles.fileName} />
                <Text style={styles.fileMeta}>{meta(file)}</Text>
                {problem ? <Text style={styles.fileProblemText}>{problem}</Text> : null}
              </View>
            </View>
            <RemoveButton name={file.name} disabled={disabled} onPress={() => onRemove(file)} />
          </View>
        );
      })}
      {url ? (
        <View accessible accessibilityLabel={`Link ${url}`} style={styles.linkCard}>
          <Text style={styles.linkLabel}>Link</Text>
          <Text style={styles.link} numberOfLines={2}>{url}</Text>
        </View>
      ) : null}
    </View>
  );
}

// A file name on one line that gives way in the middle (share-payload.ts shortenFileName), sized to the room it
// has: a tile's fixed width, or the column it's in once that has been measured. Assistive tech gets the full name.
function FileName({ name, width, fontSize, style }: { name: string; width?: number; fontSize: number; style: StyleProp<TextStyle> }) {
  const styles = useStyles();
  const [measured, setMeasured] = useState(width ?? 0);
  return <View style={styles.nameBox} onLayout={width ? undefined : e => setMeasured(e.nativeEvent.layout.width)}>
    <Text numberOfLines={1} accessibilityLabel={name} style={style}>{measured ? shortenFileName(name, nameCharsFor(measured, fontSize)) : name}</Text>
  </View>;
}

// Taking a file out of what is being sent: the shared destructive button, under a picture or beside a file row.
function RemoveButton({ name, onPress, disabled, compact }: { name: string; onPress: () => void; disabled: boolean; compact?: boolean }) {
  const styles = useStyles();
  return <Button label="Remove" accessibilityLabel={`Remove ${name}`} kind="danger" compact disabled={disabled} onPress={onPress} style={compact ? styles.removeUnderTile : undefined} />;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { padding: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 520, alignSelf: "center" },
  centered: { alignItems: "center", gap: space.sm, paddingVertical: space.xxl },
  title: { ...typography.title, color: colors.ink },
  lead: { ...typography.body, color: colors.muted, marginTop: space.xs },
  hint: { ...typography.body, color: colors.muted, textAlign: "center", maxWidth: 360 },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center" },
  emptyAction: { marginTop: space.sm, minWidth: 200 },
  items: { marginTop: space.md, gap: space.xs },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, alignItems: "flex-start" },
  tile: { width: TILE },
  thumb: { width: TILE, height: TILE, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: "hidden" },
  tileName: { ...typography.meta, color: colors.muted, marginTop: space.xxs },
  nameBox: { alignSelf: "stretch" },
  file: { minHeight: 64, paddingVertical: space.sm, paddingLeft: space.sm, paddingRight: space.xxs, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background, flexDirection: "row", alignItems: "center", gap: space.xs },
  fileProblem: { borderColor: colors.red, borderWidth: 1.5 },
  fileBody: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.sm },
  fileIcon: { width: 40, height: 44, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", backgroundColor: colors.blueSoft },
  fileIconProblem: { backgroundColor: colors.redSoft },
  fileName: { ...typography.label, color: colors.ink },
  fileMeta: { ...typography.meta, color: colors.muted, marginTop: space.xxs },
  fileProblemText: { ...typography.caption, color: colors.red, marginTop: space.xxs },
  removeUnderTile: { alignSelf: "stretch", marginTop: space.xxs, paddingHorizontal: space.xs },
  linkCard: { borderLeftWidth: 3, borderLeftColor: colors.blue, paddingLeft: space.sm, paddingVertical: space.xxs, gap: 2 },
  linkLabel: { ...typography.captionStrong, color: colors.ink },
  link: { ...typography.body, color: colors.blue, ...linkUnderline },
  row: { minHeight: 56, marginTop: space.sm, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.md, backgroundColor: colors.surface, flexDirection: "row", alignItems: "center", gap: space.sm },
  pressed: { opacity: 0.8 },
  rowIcon: { width: 34, height: 34, borderRadius: radius.md, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center" },
  rowCopy: { flex: 1, minWidth: 0 },
  rowLabel: { ...typography.caption, color: colors.muted },
  rowValue: { ...typography.bodyStrong, color: colors.ink },
  rowHint: { ...typography.caption, color: colors.muted, marginTop: space.xxs, marginHorizontal: space.sm },
  label: { ...typography.label, marginTop: space.lg, color: colors.ink },
  input: { ...controls.input, ...controls.inputMultiline, minHeight: 96, marginTop: space.xs },
  error: { ...typography.caption, marginTop: space.xs, color: colors.red },
  progress: { ...typography.caption, marginTop: space.xs, color: colors.muted },
  blockedRow: { flexDirection: "row", alignItems: "flex-start", gap: space.xxs, marginTop: space.md },
  blocked: { ...typography.caption, color: colors.red, flex: 1, minWidth: 0 },
  action: { marginTop: space.md },
  actionTight: { marginTop: space.xs },
  cancel: { marginTop: space.xs, alignSelf: "center" },
}));
