import { Radio } from "../../components/Radio";
import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, AppState, FlatList, Modal, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { randomUUID } from "expo-crypto";
import { ConversationKeyboardView } from "../../components/ConversationKeyboardView";
import { Avatar, Composer, when } from "../../components/Messaging";
import { ProjectSheet } from "../../components/ProjectSheet";
import { Attachments, documentReader, PendingAttachments } from "../../components/Attachments";
import { uploadDocument, UploadError } from "../../lib/document-upload";
import { MediaGalleryProvider } from "../../components/MediaGallery";
import { mediaFromMessages } from "../../lib/media";
import { Button, IconButton } from "../../components/Button";
import { MessageText } from "../../components/MessageText";
import { withoutContextSummaries } from "../../lib/context-summary";
import { TweetEmbed } from "../../components/TweetEmbed";
import { tweetIds } from "../../lib/tweet-embed";
import { AgentApprovalCard } from "../../components/AgentApprovalCard";
import { activeAgentTurn, agentTurnLabel, inOrder, joinsReply, liveAgentLine, queuedBelow, splitTurns, withRead, workByMessage, workedFor, type AgentTurn } from "../../lib/agent-turns";
import { AgentProgress, AgentWorked } from "../../components/AgentSteps";
import { bufferAgentReply } from "../../lib/agent-events";
import { messageDeviceLabel } from "../../lib/message-device";
import { estimateCost, formatCost, formatTokens } from "../../lib/token-format";
import { helpText, parseSlash } from "../../lib/slash-commands";
import { PiiDeclined, withPiiConfirm } from "../../lib/pii-warning";
import { usePiiConfirm } from "../../components/PiiConfirm";
import { api, sendMessage, ServerError, uploadPost, type Chat, type Project, type Message, type Upload } from "../../lib/server";
import { useSession } from "../../lib/session";
import { anyTalk, useFeatures } from "../../lib/features";
import { useLive } from "../../lib/live";
import { useProjects } from "../../lib/projects-store";
import { VIBE_CHOICE, choiceKey, lastChatKey, choiceName, needsNewChat, newChatOptions } from "../../lib/new-chat-choice";
import { setItem } from "../../lib/storage";
import { forwardTitle, parseForward, type ForwardCard } from "../../lib/forward";
import { AppIcon, type AppIconName } from "../../components/AppIcon";
import { SkeletonRows } from "../../components/Skeleton";
import { ForwardSheet, type ForwardTarget } from "../../components/ForwardSheet";
import * as Clipboard from "expo-clipboard";
import { headerTitleType, radius, space, typography, useTheme, createThemedStyles, linkUnderline } from "../../lib/theme";
import { useWideLayout } from "../../lib/layout";
import { Toggle } from "../../components/Toggle";

type Row = Message & { waitingForAgent?: boolean; queuedTurn?: AgentTurn; agentWorking?: boolean; pending?: boolean; failed?: boolean; localId?: string; uploads?: Upload[]; forwardPreview?: ForwardCard | null };

export default function ChatScreen() {
  const { id, readOnly } = useLocalSearchParams<{ id: string; readOnly?: string }>();
  const { account } = useSession();
  const key = `${account?.serverUrl ?? ""}:${account?.token ?? ""}:${id}`;
  // A link (e.g. "Working on it in ..." from @agent) doesn't say whose chat it is: ask the server.
  const [theirs, setTheirs] = useState<boolean | null>(readOnly === "1" ? true : null);
  useEffect(() => {
    if (readOnly === "1" || !account || !id) return;
    let live = true;
    api.chat(account, String(id)).then(c => { if (live) setTheirs(!!c.readOnly); }).catch(() => { if (live) setTheirs(false); });
    return () => { live = false; };
  }, [account, id, readOnly]);
  // Someone else's shared chat opens read-only: no composer, turns or controls.
  if (theirs === true) return <SharedChatView key={key} />;
  if (theirs === null) return null;
  // A different conversation or account starts with fresh draft and send state.
  return <ChatConversation key={key} />;
}

function SharedChatView() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { id, title, author } = useLocalSearchParams<{ id: string; title?: string; author?: string }>();
  const { account } = useSession();
  const features = useFeatures();
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [chat, setChat] = useState<Chat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTitle, setShowTitle] = useState(false);
  const [forwarding, setForwarding] = useState<ForwardTarget | null>(null);
  const load = useCallback(async () => {
    if (!account || !id) return;
    try {
      const [history, info] = await Promise.all([api.messages(account, id), api.chat(account, id)]);
      setMessages(history); setChat(info); setError(null);
    } catch (e) {
      setMessages(current => current ?? []);
      setError(e instanceof ServerError ? e.message : "Check your connection and try again.");
    }
  }, [account, id]);
  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);
  const authorName = chat?.author?.name || author || "Someone";
  const media = useMemo(() => mediaFromMessages(messages ?? [], authorName, "Agent"), [messages, authorName]);
  if (!account) return null;
  const data = withoutContextSummaries(messages ?? []).reverse();
  return (
    <MediaGalleryProvider key={id} scope={{ kind: "chat", id }} items={media}>
    <View style={styles.root}>
      <Stack.Screen options={{ title: chat?.title || title || "Conversation", headerTitle: titleButton(showTitle, setShowTitle), ...filesHeader(String(id), chat?.title || title || "Conversation", colors.blue) }} />
      {showTitle ? <FullTitle title={chat?.title || title || "Conversation"} onClose={() => setShowTitle(false)} /> : null}
      <View style={styles.sharedBanner}>
        <Text style={styles.turnLabel}>{authorName}'s conversation</Text>
        <Text style={styles.turnDetail}>{chat?.shared === true ? `Shared with ${account.serverName}. Read only.`
          : chat?.projectShared ? "Shared with their project. Read only."
            : "Private · Admin access"}</Text>
      </View>
      {messages === null ? <SkeletonRows label="Loading messages" count={8} style={{ flex: 1 }} /> : (
        <FlatList inverted data={data} keyExtractor={(m) => m.id} contentContainerStyle={[styles.list, styles.readOnlyList]}
          ListFooterComponent={messages.length === 0 ? <View style={styles.empty}>
            <Text accessibilityRole="header" style={styles.emptyTitle}>{error ? "Couldn't load this chat" : "No messages yet"}</Text>
            {error ? <><Text accessibilityRole="alert" style={styles.emptyBody}>{error}</Text>
              <Button label="Try again" kind="secondary" onPress={() => { setMessages(null); void load(); }} style={styles.retry} /></> : null}
          </View> : undefined}
          renderItem={({ item }) => {
            const theirs = item.role === "user";
            const timestamp = typeof item.at === "number" ? item.at : item.at ? new Date(item.at).getTime() : NaN;
            return <MessageActions item={item} author={theirs ? authorName : "Agent"} canForward={chat?.shared !== false && anyTalk(features)} onForward={setForwarding} chatId={String(id)} style={styles.message} label={theirs ? `${authorName}'s message` : "Agent response"}>
              <Avatar name={theirs ? authorName : "Agent"} agent={!theirs} userId={theirs ? chat?.author?.id : undefined} size={34} tapToMessage={theirs} />
              <View style={styles.messageCopy}>
                <View style={styles.messageMeta}>
                  <Text style={styles.author}>{theirs ? authorName : "Agent"}</Text>
                  {Number.isFinite(timestamp) ? <Text style={styles.time}>{when(timestamp)}</Text> : null}
                </View>
                {theirs ? <ForwardedText item={item} /> : item.text ? <ReplyText text={item.text} /> : null}
                {item.attachments?.length ? <Attachments files={item.attachments} /> : null}
              </View>
            </MessageActions>;
          }} />
      )}
      {forwarding ? <ForwardSheet target={forwarding} onClose={() => setForwarding(null)} /> : null}
    </View>
    </MediaGalleryProvider>
  );
}

// Long titles get cut off in the header: tap the title to read all of it.
//
// Not on an iPhone or iPad. There the header is the system's, and a title we draw ourselves is not kept clear of
// the buttons beside it: a long title ran under the options button, so the two were drawn on top of each other.
// The system's own title is cut to the room there is, between the buttons, and the whole title is the first line
// of the chat's options instead.
function titleButton(open: boolean, setOpen: (next: boolean) => void, links = 0) {
  if (Platform.OS === "ios") return undefined;
  const render = ({ children }: { children: string }) => <HeaderTitle title={children} open={open} links={links} onPress={() => setOpen(!open)} />;
  render.displayName = "ChatHeaderTitle";
  return render;
}

function HeaderTitle({ title, open, links, onPress }: { title: string; open: boolean; links: number; onPress: () => void }) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const wide = useWideLayout();
  const size = headerTitleType(wide);
  // Leave room for Back and the header links on a phone.
  const maxWidth = wide ? undefined : Math.max(120, width - 150 - links * 44);
  return <Pressable testID="chat-title" accessibilityRole="button" accessibilityLabel={title}
    accessibilityHint={open ? "Hides the full title" : "Shows the full title"} accessibilityState={{ expanded: open }} aria-expanded={open}
    onPress={onPress} style={{ maxWidth, flexShrink: 1, minHeight: 44, justifyContent: "center" }}>
    <Text numberOfLines={1} style={{ ...size, color: colors.ink }}>{title}</Text>
  </Pressable>;
}

function FullTitle({ title, onClose }: { title: string; onClose: () => void }) {
  const styles = useStyles();
  return <View testID="full-title" style={styles.fullTitle}>
    <Text selectable accessibilityRole="header" style={styles.fullTitleText}>{title}</Text>
    <IconButton icon="close" label="Hide full title" edge="end" onPress={onClose} style={styles.barIcon} />
  </View>;
}

// Files: every photo, video and file in this agent chat.
// Preview and Share sit here too, so the conversation keeps the whole screen.
type HeaderLink = { label: string; icon?: AppIconName; testID: string; accessibilityLabel?: string; onPress: () => void };
// An icon in the app's set and the system's own symbol for it, for a header button on iOS. Without one the
// button was its label as text, so "•••" was three small dots of type rather than a button.
const HEADER_SYMBOL = { more: "ellipsis" } as const satisfies Partial<Record<AppIconName, string>>;
function filesHeader(id: string, title: string, tint: string, extra: HeaderLink[] = [], withFiles = true) {
  const open = () => router.push({ pathname: "/files", params: { kind: "chat", id, title } });
  const links: HeaderLink[] = [...extra, ...(withFiles ? [{ label: "Files", testID: "open-files", onPress: open }] : [])];
  return Platform.OS === "ios"
    ? { unstable_headerRightItems: () => links.map(link => ({ type: "button" as const, label: link.accessibilityLabel ?? link.label, accessibilityLabel: link.accessibilityLabel,
        ...(link.icon && link.icon in HEADER_SYMBOL ? { icon: { type: "sfSymbol" as const, name: HEADER_SYMBOL[link.icon as keyof typeof HEADER_SYMBOL] } } : {}), tintColor: tint, labelStyle: { color: tint, fontSize: typography.label.fontSize, fontWeight: "600" as const }, hidesSharedBackground: true, onPress: link.onPress })) }
    : { headerRight: () => <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingRight: Platform.OS === "web" ? space.xs : 0 }}>
        {links.map(link => <Pressable key={link.testID} testID={link.testID} accessibilityRole="button" accessibilityLabel={link.accessibilityLabel ?? link.label} onPress={link.onPress} style={{ minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center" }}>
          {link.icon ? <AppIcon name={link.icon} size={20} color={tint} /> : <Text style={{ ...typography.label, color: tint }}>{link.label}</Text>}
        </Pressable>)}
      </View> };
}

// Prototyping: the latest prototype opens in the in-app browser.
export function openPreview(url: string) {
  // A fresh query string each time skips cached copies of the last publish.
  const fresh = `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`;
  if (Platform.OS === "web") { window.open(fresh, "_blank", "noopener"); return; }
  void WebBrowser.openBrowserAsync(fresh, { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET, dismissButtonStyle: "done" }).catch(() => {});
}

// Wide windows (browser, Mac) show the preview beside the chat; phones open it full screen.
// Native builds shipped before react-native-webview existed lack the module, so fall back to the full-screen sheet.
let NativeWebView: any = null;
if (Platform.OS !== "web") { try { NativeWebView = require("react-native-webview").WebView; } catch { NativeWebView = null; } }
export const canSplitPreview = Platform.OS === "web" || !!NativeWebView;

function PreviewPane({ url, version, stacked, onClose }: { url: string; version: number; stacked: boolean; onClose: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const src = `${url}${url.includes("?") ? "&" : "?"}v=${version}`;
  return <View testID="preview-pane" style={[styles.previewPane, stacked && styles.previewPaneStacked]}>
    <View style={styles.previewBar}>
      <Text accessibilityRole="header" style={[styles.turnLabel, styles.turnCopy]}>Preview</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={Platform.OS === "web" ? "Open preview in a new tab" : "Open preview full screen"} onPress={() => openPreview(url)} style={styles.previewBarLink}>
        <Text style={styles.headerLinkText}>{Platform.OS === "web" ? "Open" : "Full screen"}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Close preview" onPress={onClose} style={styles.previewBarLink}>
        <AppIcon name="close" size={16} color={colors.muted} />
      </Pressable>
    </View>
    {Platform.OS !== "web" ? <NativeWebView key={src} source={{ uri: src }} style={{ flex: 1, backgroundColor: "#FFFFFF" }} startInLoadingState setSupportMultipleWindows={false} />
    : createElement("iframe", { key: src, src, title: "Preview", style: { flex: 1, width: "100%", height: "100%", border: 0, backgroundColor: "#FFFFFF" }, sandbox: "allow-scripts allow-same-origin allow-forms allow-popups" })}
  </View>;
}

// A "PREVIEW: <url>" line in a reply becomes a button (https, or http for a local server).
function ReplyText({ text, failed }: { text: string; failed?: boolean }) {
  const styles = useStyles();
  const match = text.match(/(?:^|\n)PREVIEW:\s*(https?:\/\/\S+)\s*$/);
  if (!match) return <MessageText text={text} failed={failed} />;
  const body = text.slice(0, match.index).trimEnd();
  return <View>
    {body ? <MessageText text={body} failed={failed} /> : null}
    <Button label="Open preview" compact onPress={() => openPreview(match[1]!)} style={styles.previewInline} />
  </View>;
}

// Header "•••": chat options. Your own chat is private until you choose to share it with the server; Files lives here too.
function OptionsSheet({ id, title, shared, projectId, projectShared, onProject, onProjectShared, onChange, onClose }: { id: string; title: string; shared: boolean | null; projectId: string | null; projectShared: boolean; onProject: (projectId: string | null) => void; onProjectShared: (shared: boolean) => void; onChange: (shared: boolean) => void; onClose: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [choosing, setChoosing] = useState(false);
  useEffect(() => { if (account) api.projects(account).then(r => setProjects(r.projects)).catch(() => setProjects([])); }, [account]);
  if (!account) return null;
  const move = async (next: string | null) => {
    setSaving(true); setError(null);
    try { await api.moveChat(account, id, next); onProject(next); if (next !== projectId) onProjectShared(false); setChoosing(false); }
    catch (e) { setError(e instanceof ServerError ? e.message : "Couldn't move the chat"); }
    finally { setSaving(false); }
  };
  const current = projects?.find(f => f.id === projectId);
  const teamProject = !!current && current.people.some(p => p.id && p.id !== account.user.id);
  const shareWithProject = async (next: boolean) => {
    onProjectShared(next); setSaving(true); setError(null);
    try { onProjectShared((await api.shareChatWithProject(account, id, next)).projectShared === true); }
    catch (e) { onProjectShared(!next); setError(e instanceof ServerError ? e.message : "Couldn't change sharing"); }
    finally { setSaving(false); }
  };
  const change = async (next: boolean) => {
    onChange(next); setSaving(true); setError(null);
    try { onChange((await api.setChatShared(account, id, next)).shared !== false); }
    catch (e) { onChange(!next); setError(e instanceof ServerError ? e.message : "Couldn't change sharing"); }
    finally { setSaving(false); }
  };
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <Pressable accessibilityLabel="Close" style={styles.menuOverlay} onPress={onClose}>
      <Pressable testID="chat-options" accessibilityViewIsModal style={styles.menuCard} onPress={() => {}}>
        {/* The whole title: a header has room for the start of it only. */}
        <Text testID="chat-options-title" selectable accessibilityRole="header" style={styles.optionsTitle}>{title}</Text>
        {shared !== null ? <View style={styles.shareRow}>
          <View style={styles.turnCopy}>
            <Text style={styles.turnLabel}>Share with {account.serverName}</Text>
            <Text style={styles.turnDetail}>{shared ? `Everyone on ${account.serverName} can read. Only you can reply.` : "Visible to you and admins."}</Text>
          </View>
          <Toggle label={`Share this chat with ${account.serverName}`} value={shared} disabled={saving}
            onValueChange={next => { void change(next); }} />
        </View> : null}
        {error ? <Text accessibilityRole="alert" style={styles.shareError}>{error}</Text> : null}
        {projects && (projects.length > 0 || projectId) ? <>
          <Pressable testID="chat-project" accessibilityRole="button" accessibilityState={{ expanded: choosing }} aria-expanded={choosing} disabled={saving} onPress={() => setChoosing(!choosing)} style={[styles.menuAction, styles.projectLine]}>
            <Text style={styles.menuActionText}>Project</Text>
            <Text style={styles.turnDetail}>{current?.name ?? "None"}</Text>
          </Pressable>
          {teamProject && !choosing ? <View style={styles.shareRow}>
            <View style={styles.turnCopy}>
              <Text style={styles.turnLabel}>Share with {current!.name}</Text>
              <Text style={styles.turnDetail}>{projectShared ? "Project members can read. Only you can reply." : "Visible to you and admins."}</Text>
            </View>
            <Toggle label={`Share this chat with the ${current!.name} project`} value={projectShared} disabled={saving}
              onValueChange={next => { void shareWithProject(next); }} />
          </View> : null}
          {choosing ? <View accessibilityRole="radiogroup" accessibilityLabel="Project">
            {[{ id: null as string | null, name: "No project" }, ...projects].map(f => <Radio key={f.id ?? "none"} accessibilityState={{ checked: f.id === projectId, disabled: saving }} aria-checked={f.id === projectId} disabled={saving} onPress={() => void move(f.id)} style={styles.projectChoice}>
              <Text style={[styles.menuActionText, f.id === projectId && { fontWeight: "700" }]}>{f.name}</Text>
              {f.id === projectId ? <AppIcon name="check" size={16} color={colors.blue} /> : null}
            </Radio>)}
          </View> : null}
        </> : null}
        <Pressable testID="open-files" accessibilityRole="button" onPress={() => { onClose(); router.push({ pathname: "/files", params: { kind: "chat", id, title } }); }} style={styles.menuAction}><Text style={styles.menuActionText}>Files</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.menuAction}><Text style={styles.menuActionText}>Done</Text></Pressable>
      </Pressable>
    </Pressable>
  </Modal>;
}

function ChatConversation() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { id, title, compose, forward, forwardAuthor, forwardWhere, forwardText, forwardFiles } = useLocalSearchParams<{ id: string; title?: string; compose?: string; forward?: string; forwardAuthor?: string; forwardWhere?: string; forwardText?: string; forwardFiles?: string }>();
  const { account, setAccount } = useSession();
  const { refreshAgent } = useLive();
  // A message brought here with "Ask the agent", until it's sent or removed.
  const [pendingForward, setPendingForward] = useState<string | null>(forward || null);
  const forwardFileCount = Number(forwardFiles) || 0;
  const [messages, setMessages] = useState<Row[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const { ask: askPii, dialog: piiDialog } = usePiiConfirm();
  const [chatUsage, setChatUsage] = useState<Chat["usage"] | null>(null);
  const refreshUsage = useCallback(() => { if (account && id) api.chat(account, String(id)).then(c => setChatUsage(c.usage ?? null)).catch(() => {}); }, [account, id]);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const uploaded = useRef(new Map<string, string>());
  const [turn, setTurn] = useState<AgentTurn | null>(null);
  // Messages sent while the agent works wait here, oldest first: on their way into the reply in progress
  // (steerRequested), or held until it finishes.
  const [waiting, setWaiting] = useState<AgentTurn[]>([]);
  // Finished replies by the message they wrote, for "Worked for 12 seconds" above each one.
  const [worked, setWorked] = useState<Map<string, AgentTurn>>(() => new Map());
  // The reply seen being worked on here. Its summary eases in when it lands; older ones are simply there.
  const [watched, setWatched] = useState<string | null>(null);
  if (turn && turn.status !== "queued" && activeAgentTurn(turn) && watched !== turn.id) setWatched(turn.id);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // The answer to a command like /help: shown plainly, not as an error. Tap it to dismiss.
  const [commandNote, setCommandNote] = useState<string | null>(null);
  const [heading, setHeading] = useState(title && title !== "New chat" ? title : "New chat");
  // The full agent takes any file, so a ZIP of a prototype can be hosted.
  const [showTitle, setShowTitle] = useState(false);
  const [forwarding, setForwarding] = useState<ForwardTarget | null>(null);
  const features = useFeatures();
  const [shared, setShared] = useState<boolean | null>(null);
  const [sharing, setSharing] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectShared, setProjectShared] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // What this chat is about, changeable until the first message is sent. Prototyping is set when a
  // chat is made, so switching to or from it starts a fresh chat in place of this empty one.
  const [vibe, setVibe] = useState(false);
  const projects = useProjects();
  const [choosing, setChoosing] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [aboutError, setAboutError] = useState<string | null>(null);
  const { width: winWidth } = useWindowDimensions();
  // Portrait phones stack the preview above the chat; folds, tablets, landscape and wide windows put it beside.
  const stacked = winWidth < 600;
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(0);
  // Links, pushes and the sidebar may open a chat without its title: read it from the server.
  useEffect(() => {
    if (!account || !id) return;
    let live = true;
    api.chat(account, id).then(c => {
      if (!live) return;
      if (c.title && c.title !== "New chat") setHeading(h => h === "New chat" ? c.title : h);
      setChatUsage(c.usage ?? null);
      setShared(c.shared !== false);
      setProjectId(c.projectId ?? null);
      setProjectShared(c.projectShared === true);
      setPreviewUrl(c.mode === "vibe" && c.previewUrl ? c.previewUrl : null);
      setVibe(c.mode === "vibe");
    }).catch(() => {});
    return () => { live = false; };
  }, [account, id]);
  const list = useRef<FlatList<Row>>(null);
  const abort = useRef<AbortController | null>(null);
  const currentLoad = useRef<object | null>(null);
  const mounted = useRef(true);
  const lastTurnUpdate = useRef(0);
  // Messages the agent has read mid-reply that this list already shows as part of the conversation.
  const readSteers = useRef(new Set<string>());
  // Messages this phone has just asked to add to the reply; the server may not have heard yet.
  const joining = useRef(new Set<string>());
  const refreshNow = useRef<(turnsOnly?: boolean) => Promise<void>>(async () => {});
  // The reply the last look at the turns found running, to notice when it ends.
  const replying = useRef<string | null>(null);
  // Everything on screen has been seen: clear this conversation's unread count
  // whenever the visible replies change while the app is in front.
  const lastReadReply = useRef<string | null>(null);
  const newestReply = messages?.findLast(m => m.role === "assistant" && !m.pending && !m.localId)?.id ?? null;
  useEffect(() => {
    if (!account || !id || !newestReply || newestReply === lastReadReply.current || AppState.currentState !== "active") return;
    lastReadReply.current = newestReply;
    api.readChat(account, id).then(() => refreshAgent(), () => { lastReadReply.current = null; });
  }, [account, id, newestReply, refreshAgent]);
  const delivery = useRef<{ text: string; uploads: Upload[]; id: string; forward?: string | null } | null>(null);

  const load = useCallback(() => {
    if (!account || !id) return;
    const request = {};
    currentLoad.current = request;
    return Promise.all([api.messages(account, id), api.agentTurns(account, id).catch(e => {
      if (e instanceof ServerError && e.status === 404) return [];
      throw e;
    })]).then(([history, turns]) => {
      if (request === currentLoad.current) {
        setMessages(history);
        const split = splitTurns(turns);
        setTurn(split.current); setWaiting(split.waiting); setWorked(workByMessage(turns));
        readSteers.current = new Set(turns.filter(t => t.status === "steered").map(t => t.id));
        replying.current = turns.find(t => ['running', 'waiting_for_approval', 'stopping'].includes(t.status))?.id ?? null;
        lastTurnUpdate.current = Math.max(0, ...turns.map(t => t.updatedAt));
        setLoadError(null);
      }
    }).catch(e => {
      if (request !== currentLoad.current) return;
      setMessages([]);
      setLoadError(e instanceof ServerError ? e.message : "Check your connection and try again.");
    }).finally(() => {
      if (request === currentLoad.current) {
        setBusy(false);
        setStatus(null);
      }
    });
  }, [account, id]);

  useEffect(() => {
    mounted.current = true;
    void load();
    let active = true;
    let refreshing = false;
    let again = false;
    let foregroundRefresh = false;
    // `turnsOnly` looks at the turns without reloading the conversation (right after sending, stopping or
    // answering, when the history may still be catching up).
    const refresh = async (foreground = false, turnsOnly = false) => {
      foregroundRefresh ||= foreground;
      if (!account || !id || AppState.currentState !== 'active') return;
      if (refreshing) { again = true; return; }
      refreshing = true;
      try {
        const turns = await api.agentTurns(account, id);
        if (!active) return;
        const { current: latest, waiting: listed } = splitTurns(turns);
        const queued = listed.map(t => joining.current.has(t.id) ? { ...t, steerRequested: true } : t);
        const newest = Math.max(0, ...turns.map(t => t.updatedAt));
        // Messages the agent has read since the last look. They stop waiting and become part of the
        // conversation, so their rows are only let go once the conversation has them.
        const read = turns.filter(t => t.status === 'steered' && !readSteers.current.has(t.id));
        // The reply that was being worked on has ended. Its working line stays until the conversation has the
        // reply, so one takes the other's place in a single step instead of leaving a gap between them.
        const running = turns.find(t => ['running', 'waiting_for_approval', 'stopping'].includes(t.status))?.id ?? null;
        const ended = !!replying.current && replying.current !== running;
        replying.current = running;
        const reload = !turnsOnly && (foregroundRefresh || newest !== lastTurnUpdate.current) && !abort.current;
        const showTurns = () => { setTurn(current => current && (!latest || current.updatedAt > latest.updatedAt) ? current : latest); setWorked(workByMessage(turns)); };
        const together = read.length > 0 || (ended && reload);
        if (!together) { showTurns(); setWaiting(queued); }
        if (reload || read.length) {
          let history: Row[] | null = null;
          try { history = await api.messages(account, id); } catch { /* The visible history remains available; the next look catches up. */ }
          if (!active) return;
          if (together) showTurns();
          if (!history) { if (!read.length) setWaiting(queued); return; }
          if (reload && !abort.current) {
            setMessages(history); setLoadError(null); setSendError(null);
            lastTurnUpdate.current = newest;
            foregroundRefresh = false;
          } else {
            // This phone is following its own reply (or only looked at the turns): add what the agent has read, nothing else.
            const fetched = history;
            setMessages(shown => withRead(shown ?? [], fetched));
          }
          if (together) setWaiting(queued);
          for (const t of read) readSteers.current.add(t.id);
        }
      } catch { /* The visible history remains available; foreground retries catch up. */ }
      finally {
        refreshing = false;
        if (again && active) { again = false; void refresh(); }
      }
    };
    refreshNow.current = turnsOnly => refresh(false, turnsOnly);
    const timer = setInterval(() => { void refresh(); }, 2500);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        // The Mac owns the turn. A suspended phone stream is only a viewer.
        abort.current?.abort();
        abort.current = null;
        lastTurnUpdate.current = -1;
        setBusy(false);
        void refresh(true);
      }
    });
    return () => {
      active = false;
      mounted.current = false;
      currentLoad.current = null;
      abort.current?.abort();
      clearInterval(timer);
      subscription.remove();
    };
  }, [load, account, id]);

  const media = useMemo(() => mediaFromMessages(messages ?? [], account?.user.name ?? "You", "Agent"), [messages, account?.user.name]);
  // Backing out of a chat that never got a message deletes it (set below), so no empty "New chat" is left behind.
  const discardable = useRef(false);
  // An untouched new chat (nothing sent, nothing queued) is deleted when you back out of it.
  const untouched = messages !== null && messages.length === 0 && !loadError && !turn && waiting.length === 0 && compose === "1";
  useEffect(() => { discardable.current = untouched; }, [untouched]);
  // Delete on leaving only. The account is read from a ref: depending on `account` itself re-ran this cleanup whenever
  // the account object was replaced (a rename, a deep-work change from another device), deleting a chat you were still in.
  const accountRef = useRef(account);
  useEffect(() => { accountRef.current = account; }, [account]);
  useEffect(() => () => { const a = accountRef.current; if (discardable.current && a) void api.deleteChat(a, String(id)).catch(() => {}); }, [id]);
  const loaded = messages !== null && !loadError;
  useEffect(() => { if (id && loaded && account) setItem(lastChatKey(account.user.id), String(id)).catch(() => {}); }, [id, loaded, account]);
  if (!account) return null;

  // A look at the turns alone. The conversation itself reloads on the regular refresh.
  const refreshTurns = () => refreshNow.current(true);

  // Documents go up in chunks before the message that names them. Finished
  // uploads are remembered, so retrying the same draft doesn't resend them.
  const uploadDocuments = async (attachments: Upload[], signal?: AbortSignal) => {
    const out: Upload[] = [];
    for (const file of attachments) {
      if (!file.document) { out.push(file); continue; }
      const key = `${file.document.uri}:${file.document.size}`;
      let upload = uploaded.current.get(key);
      if (!upload) {
        setUploadProgress("Uploading…");
        upload = await uploadDocument({ chatId: String(id), name: file.name, size: file.document.size, read: documentReader(file.document), post: uploadPost(account, setAccount), signal,
          onProgress: fraction => setUploadProgress(`Uploading ${Math.floor(fraction * 100)}%`) });
        uploaded.current.set(key, upload);
      }
      out.push({ ...file, upload });
    }
    setUploadProgress(null);
    return out;
  };

  // Asks the server to fold a waiting message into the reply in progress. When it can't (the reply just ended,
  // this agent takes nothing mid-task), nothing is wrong: the message keeps its place and is sent after.
  const joinReply = async (target: AgentTurn, shown: boolean) => {
    const mark = (on: boolean) => setWaiting(w => w.map(t => t.id === target.id ? { ...t, steerRequested: on } : t));
    if (shown) joining.current.add(target.id);
    try {
      await api.steerAgent(account, String(id), target.id);
      if (mounted.current && !shown) mark(true);
    } catch {
      if (mounted.current && shown) mark(false);
    } finally { joining.current.delete(target.id); }
    // The agent takes it within a moment. Look again then, so it settles into the conversation promptly.
    void refreshTurns();
    setTimeout(() => { if (mounted.current) void refreshTurns(); }, 900);
  };

  // Sent while the agent is working. Text joins the reply in progress: the agent reads it at its next step.
  // Files, "/queue …" and a held Send wait instead (`later`) and are sent once that reply is done. Either way
  // the server takes it as a waiting message first. Its reply isn't followed here; the regular refresh shows it.
  const queue = async (body: string, attachments: Upload[], later: boolean) => {
    // Same draft retried after an uncertain send reuses its key: no duplicate.
    const previous = delivery.current;
    if (!previous || previous.text !== body || previous.uploads.length !== attachments.length || previous.forward !== pendingForward) {
      delivery.current = { text: body, uploads: attachments, id: randomUUID(), forward: pendingForward };
    }
    const forwarding = pendingForward ?? undefined;
    const requestId = delivery.current!.id;
    const controller = new AbortController();
    const join = !later && joinsReply(turn, body, attachments.length + (forwarding ? forwardFileCount : 0));
    // Shown as joining from the start when the server has said this reply takes messages. An older server
    // doesn't say, and a forward may carry files, so those wait for the answer.
    const sure = join && turn?.canSteer === true && !forwarding;
    const taken: { turn?: AgentTurn } = {};
    try {
      const ready = await uploadDocuments(attachments);
      await withPiiConfirm(askPii, confirmPii => sendMessage(account, String(id), body, e => {
        if (e.type === 'turn' && e.turn.status === 'queued' && !taken.turn) {
          taken.turn = e.turn;
          if (sure) joining.current.add(e.turn.id);
          setWaiting(w => w.some(t => t.id === e.turn.id) ? w : [...w, { ...e.turn, steerRequested: sure }]);
          controller.abort();
        }
      }, controller.signal, setAccount, ready, requestId, forwarding, confirmPii));
    } catch (e) {
      setUploadProgress(null);
      if (e instanceof PiiDeclined) return false;
      if (!taken.turn) {
        setSendError(e instanceof ServerError || e instanceof UploadError ? e.message : "Couldn't send your message. Your draft is saved; try again.");
        return false;
      }
    }
    setSendError(null);
    delivery.current = null;
    if (taken.turn && forwarding) setPendingForward(null);
    if (taken.turn && join) void joinReply(taken.turn, sure);
    else void refreshTurns();
    return !!taken.turn;
  };

  // Commands typed in an agent chat (/archive, /stop, /new …). Returns true when handled, null for ordinary text.
  const runCommand = async (text: string): Promise<boolean | null> => {
    const cmd = parseSlash(text, false, true, features);
    if (!cmd) return null;
    setActionError(null); setCommandNote(null);
    try {
      switch (cmd.name) {
        case "archive": await api.archiveChat(account, String(id)); router.replace("/agent"); return true;
        case "stop":
          if (!turn?.canStop) { setCommandNote("The agent isn't replying right now"); return true; }
          await stop(); return true;
        case "new": router.push("/new-message"); return true;
        case "browse": router.push("/browse"); return true;
        case "people": router.push("/members"); return true;
        case "help": setCommandNote(helpText(false, true, features)); return true;
      }
    } catch (e) { setActionError(e instanceof Error ? e.message : `Couldn't run /${cmd.name}`); return false; }
    return null;
  };

  // The composer frees itself once the Mac accepts the message (or it fails
  // before that); the reply keeps streaming here without holding the box.
  // `how` is "queue" for a held Send or "/queue …": the message waits for the reply in progress to finish.
  const send = (text: string, attachments: Upload[] = [], how?: "queue") => new Promise<boolean>(resolve => {
    let settled = false;
    const settle = (value: boolean) => { if (!settled) { settled = true; resolve(value); } };
    // A typed command (/archive, /stop …) runs instead of being sent; anything else goes to the agent as before.
    // What follows "/queue" is always a message, even when it starts with a slash.
    const command = how !== "queue" && !attachments.length && text.trim().startsWith("/") ? runCommand(text.trim()) : Promise.resolve(null);
    void command.then(handled => handled !== null ? settle(handled) : deliver(text, attachments, () => settle(true), how === "queue").then(settle, () => settle(false)), () => settle(false));
  });

  const deliver = async (text: string, attachments: Upload[], onAccepted: () => void, later = false) => {
    const body = text.trim();
    if ((!body && !attachments.length && !pendingForward) || messages === null || loadError) return false;
    if (busy || activeAgentTurn(turn)) return await queue(body, attachments, later);
    setBusy(true);
    setStatus(null);
    setSendError(null);
    setActionError(null);
    // Retain the key after an uncertain delivery; an unchanged draft can be
    // retried without starting another Mac-owned turn.
    const previous = delivery.current;
    if (!previous || previous.text !== body || previous.uploads.length !== attachments.length || previous.forward !== pendingForward
      || previous.uploads.some((upload, i) => upload.name !== attachments[i]?.name || upload.data !== attachments[i]?.data)) {
      delivery.current = { text: body, uploads: attachments, id: randomUUID(), forward: pendingForward };
    }
    const forwarding = pendingForward ?? undefined;
    const forwardPreview: ForwardCard | null = forwarding ? { author: forwardAuthor || "Someone", where: forwardWhere || "", when: "", quote: forwardText || "" } : null;
    const requestId = delivery.current!.id;
    const stamp = Date.now();
    const mineKey = `u${stamp}`;
    const replyKey = `a${stamp}`;
    const mine: Row = { id: mineKey, localId: mineKey, role: "user", text: body, at: stamp, pending: true, uploads: attachments, forwardPreview };
    const reply: Row = { id: replyKey, localId: replyKey, role: "assistant", text: "", pending: true, at: stamp };
    setMessages((m) => [...(m ?? []), mine, reply]);
    const controller = new AbortController();
    abort.current = controller;
    const isCurrent = () => abort.current === controller && !controller.signal.aborted;
    const update = (fn: (r: Row) => Row) => {
      if (isCurrent()) setMessages((m) => (m ?? []).map((r) => (r.localId === replyKey ? fn(r) : r)));
    };
    let failed = false;
    let accepted = false;
    let canonicalMineId: string | undefined;
    let canonicalReplyId: string | undefined;
    let responseSeen = false;
    const accept = () => {
      if (accepted) return;
      accepted = true;
      onAccepted();
      if (heading === "New chat") setHeading(body ? body.replace(/\s+/g, " ").slice(0, 60) : forwarding ? forwardTitle(forwardText || "") : (attachments[0]?.name || "New chat").replace(/\s+/g, " ").slice(0, 60));
      if (forwarding) setPendingForward(null);
      setMessages((m) => (m ?? []).map((r) => r.localId === mineKey ? { ...r, pending: false } : r));
    };
    try {
      const ready = await uploadDocuments(attachments, controller.signal);
      await withPiiConfirm(askPii, confirmPii => sendMessage(
        account,
        String(id),
        body,
        bufferAgentReply((e) => {
          if (!isCurrent()) return;
          if (e.type === 'turn') {
            setTurn(e.turn);
            if (e.turn.accepted) accept();
          } else if (e.type === 'approval') {
            setTurn(current => current ? { ...current, approval: e.approval, status: 'waiting_for_approval' } : current);
          } else if (e.type === "sent") {
            accept();
            canonicalMineId = e.message.id;
            setMessages((m) => (m ?? []).map((r) => r.localId === mineKey ? { ...e.message, localId: mineKey } : r));
          } else if (e.type === "message") {
            accept();
            canonicalReplyId = e.id ?? canonicalReplyId;
            responseSeen ||= !!e.text || !!e.attachments?.length;
            update((r) => ({ ...r, id: e.id ?? r.id, at: e.at ?? r.at, text: e.text, attachments: e.attachments ?? r.attachments }));
          }
          else if (e.type === "status") setStatus(e.text);
          else if (e.type === "error") {
            failed = true;
            setSendError(e.message);
            update((r) => ({ ...r, pending: false, failed: true }));
          }
          else if (e.type === "done") { update((r) => ({ ...r, pending: false })); setTimeout(refreshUsage, 1500); }
        }),
        controller.signal,
        setAccount,
        ready,
        requestId,
        forwarding,
        confirmPii,
      ));
      if (!failed && isCurrent() && !accepted) {
        failed = true;
        setSendError("Couldn't confirm this message was sent. Your draft is saved; try again.");
      }
      if (!failed && isCurrent()) {
        // Replace temporary upload previews with authenticated media records.
        // A lagging history response must not erase the reply just received.
        try {
          const history = await api.messages(account, String(id));
          const userIndex = canonicalMineId ? history.findIndex(message => message.id === canonicalMineId) : messages.length;
          const hasUser = canonicalMineId ? userIndex >= 0 : history.length > messages.length;
          const hasReply = !responseSeen || (canonicalReplyId ? history.some(message => message.id === canonicalReplyId)
            : history.slice(userIndex + 1).some(message => message.role === "assistant"));
          if (isCurrent() && hasUser && hasReply) setMessages(history);
        } catch { /* The completed reply remains visible if history refresh fails. */ }
      }
    } catch (e) {
      failed = true;
      setUploadProgress(null);
      if (isCurrent() && !(e instanceof PiiDeclined)) setSendError(e instanceof ServerError || e instanceof UploadError ? e.message : accepted ? "Your message was sent. Reconnecting to the reply saved on your Mac…" : "Couldn't confirm delivery. Your draft is saved; check the conversation before trying again.");
      update((r) => ({ ...r, pending: false, failed: !(e instanceof PiiDeclined) }));
    } finally {
      if (isCurrent()) {
        setMessages((m) => (m ?? []).filter((r) => {
          if (failed && !accepted && (r.localId === mineKey || r.localId === replyKey)) return false;
          return r.localId !== replyKey || !!r.text || !!r.attachments?.length;
        }).map((r) => r.localId === mineKey || r.localId === replyKey ? { ...r, pending: false } : r));
        setBusy(false);
        setStatus(null);
        abort.current = null;
        lastTurnUpdate.current = -1;
        void refreshTurns();
      }
    }
    // An accepted message stays sent even if Hermes cannot finish its reply.
    if (accepted) delivery.current = null;
    return accepted || !failed;
  };

  const unqueue = async (target: AgentTurn) => {
    setWaiting(w => w.filter(t => t.id !== target.id));
    try { await api.stopAgent(account, String(id), target.id); } catch { /* refresh restores it */ }
    void refreshTurns();
  };

  const answer = async (choice: 'once' | 'deny') => {
    if (!turn?.approval || actionBusy) return;
    setActionBusy(true); setActionError(null);
    try {
      await api.answerApproval(account, String(id), turn.id, turn.approval.id, choice);
      await refreshTurns();
    } catch (e) { if (mounted.current) setActionError(e instanceof Error ? e.message : 'Could not send your decision. Try again.'); }
    finally { if (mounted.current) setActionBusy(false); }
  };
  const stop = async () => {
    if (!turn?.canStop || actionBusy) return;
    setActionBusy(true); setActionError(null);
    try {
      await api.stopAgent(account, String(id), turn.id);
      await refreshTurns();
    } catch (e) { if (mounted.current) setActionError(e instanceof Error ? e.message : 'Could not stop the agent. Try again.'); }
    finally { if (mounted.current) setActionBusy(false); }
  };

  // A brand-new chat whose first message hasn't reached the agent yet (it's
  // busy elsewhere) has no history. Show that message as sent, not a blank
  // "What can I help with?", while it waits its turn.
  const unstarted = messages?.length === 0 && !loadError
    ? (turn && activeAgentTurn(turn) && !turn.accepted ? turn : waiting[0] ?? null) : null;
  const firstRow: Row | null = unstarted ? { id: `waiting_${unstarted.id}`, role: "user", text: unstarted.text || "Attachment", at: unstarted.createdAt, waitingForAgent: true } : null;
  // The reply in progress lives in the conversation itself. This phone's own
  // stream already has a pending reply row; otherwise (reopened, other device)
  // show one from the turn.
  const streaming = !!messages?.some(m => m.role === "assistant" && m.pending);
  const workingRow: Row | null = turn && !streaming && unstarted?.id !== turn.id && ['running', 'waiting_for_approval', 'stopping'].includes(turn.status)
    ? { id: `working_${turn.id}`, role: "assistant", text: "", at: undefined as unknown as Message["at"], pending: true, agentWorking: true } : null;
  // Messages sent meanwhile: the ones on their way into this reply sit just above it, as good as said; the
  // ones held for after it sit below.
  const sentMeanwhile = queuedBelow(waiting, [unstarted, turn]);
  const waitingRow = (t: AgentTurn): Row => ({ id: `queued_${t.id}`, role: "user", text: t.text || "Attachment", at: t.createdAt, queuedTurn: t });
  // A finished reply's steps, fetched when its summary is opened.
  const loadSteps = (turnId: string) => api.agentTurn(account, String(id), turnId).then(found => found?.steps ?? []);
  const showPreview = () => {
    if (!previewUrl) return;
    if (!canSplitPreview) { openPreview(previewUrl); return; }
    if (!previewOpen) setPreviewVersion(v => v + 1);
    setPreviewOpen(!previewOpen);
  };
  const headerLinks: HeaderLink[] = [
    ...(previewUrl ? [{ label: "Preview", testID: "open-preview", accessibilityLabel: previewOpen ? "Hide preview" : "Open preview", onPress: showPreview }] : []),
    { label: "•••", icon: "more", testID: "open-options", accessibilityLabel: "Chat options", onPress: () => setSharing(true) },
  ];
  const data = inOrder<Row>([...withoutContextSummaries(messages ?? []), ...(firstRow ? [firstRow] : [])], sentMeanwhile.filter(t => t.steerRequested).map(waitingRow), workingRow,
    sentMeanwhile.filter(t => !t.steerRequested).map(waitingRow), row => row.role === "assistant" && !!row.pending).reverse();
  // With nothing typed, the Send button stops the reply. It is the only Stop on the screen besides /stop.
  const stoppable = !!turn?.canStop && activeAgentTurn(turn) && turn.status !== "stopping" && !actionBusy;
  const about = vibe ? VIBE_CHOICE : projectId;
  const aboutName = choiceName(projects, about);
  // Nothing sent yet: the choice sits right above the message box, and goes once the first message is on its way.
  const fresh = messages !== null && messages.length === 0 && !loadError && !firstRow && !turn && waiting.length === 0;
  const showAbout = fresh && !!projects && !projects.vibeCoder;
  const pickAbout = async (next: string | null) => {
    setChoosing(false);
    if (next === about || switching) return;
    setSwitching(true);
    setAboutError(null);
    // The next chat from the Agent tab starts about this choice.
    const remember = () => setItem(choiceKey(account.user.id), next ?? "").catch(() => {});
    try {
      if (needsNewChat(about, next)) {
        const chat = await api.newChat(account, newChatOptions(next));
        void api.deleteChat(account, String(id)).catch(() => {});
        void remember();
        router.replace({ pathname: "/chat/[id]", params: { id: chat.id, title: chat.title, compose: "1" } });
        return;
      }
      await api.moveChat(account, String(id), next);
      setProjectId(next);
      setProjectShared(false);
      void remember();
    } catch (e) {
      setAboutError(e instanceof ServerError ? e.message : "Couldn't change that. Try again.");
    } finally {
      setSwitching(false);
    }
  };

  return (
    <MediaGalleryProvider key={id} scope={{ kind: "chat", id }} items={media}>
    {piiDialog}
    <View style={styles.root}>
      <Stack.Screen options={{ title: heading, headerTitle: titleButton(showTitle, setShowTitle, headerLinks.length), ...filesHeader(String(id), heading, colors.blue, headerLinks, false) }} />
      {showTitle ? <FullTitle title={heading} onClose={() => setShowTitle(false)} /> : null}
      {sharing ? <OptionsSheet id={String(id)} title={heading} shared={shared} projectId={projectId} projectShared={projectShared} onProject={setProjectId} onProjectShared={setProjectShared} onChange={setShared} onClose={() => setSharing(false)} /> : null}
      {choosing && projects ? <ProjectSheet visible projects={projects.list} vibe={projects.vibe !== false} selected={about} title="This chat is about" onPick={project => { void pickAbout(project); }} onClose={() => setChoosing(false)} /> : null}
      <View style={[styles.split, stacked && previewOpen && styles.splitStacked]}>
      <View style={[styles.chatColumn, stacked && previewOpen && styles.chatColumnStacked]}>
      <ConversationKeyboardView>
        {messages === null ? (
          <SkeletonRows label="Loading messages" count={8} style={{ flex: 1 }} />
        ) : (
          <FlatList
            ref={list}
            inverted
            data={data}
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.list}
            ListFooterComponent={
              messages.length === 0 && !firstRow && loadError ? (
                <View style={styles.empty}>
                  <Text accessibilityRole="header" style={styles.emptyTitle}>Couldn't load this chat</Text>
                  <Text accessibilityRole="alert" style={styles.emptyBody}>{loadError}</Text>
                  <Button label="Try again" kind="secondary" onPress={() => { setMessages(null); setLoadError(null); void load(); }} style={styles.retry} />
                </View>
              ) : undefined
            }
            renderItem={({ item }) => {
              const mine = item.role === "user";
              const working = !mine && item.pending;
              const queued = item.queuedTurn;
              // The reply this phone just followed to its end has its turn at hand before the next look at the list.
              const work = !mine && !working ? worked.get(item.id) ?? (turn?.messageId === item.id && workedFor(turn) ? turn : undefined) : undefined;
              const timestamp = typeof item.at === "number" ? item.at : item.at ? new Date(item.at).getTime() : NaN;
              const deviceLabel = messageDeviceLabel(account.user.role, item);
              return <MessageActions item={item} author={mine ? account.user.name : "Agent"} canForward={!queued && !item.pending && !item.failed && anyTalk(features)} onForward={setForwarding} chatId={String(id)}
                label={mine ? `Your message${queued ? (queued.steerRequested ? ", being added to the current reply" : ", waiting for the current reply") : item.pending ? ", not yet received" : deviceLabel ? `, sent from ${deviceLabel}` : ""}` : "Agent response"} style={[styles.message, item.failed && styles.failed, item.pending && mine && styles.unconfirmed, queued && styles.queuedMessage]}>
                <Avatar name={mine ? account.user.name : "Agent"} agent={!mine} userId={mine ? account.user.id : undefined} size={34} />
                <View style={styles.messageCopy}>
                  <View style={styles.messageMeta}>
                    <Text style={styles.author}>{mine ? account.user.name : "Agent"}</Text>
                    {Number.isFinite(timestamp) || deviceLabel ? <Text style={styles.time}>{Number.isFinite(timestamp) ? when(timestamp) : null}{deviceLabel ? <Text testID={`message-device-${item.id}`} accessibilityLabel={`Sent from ${deviceLabel}`}>{Number.isFinite(timestamp) ? " · " : ""}{deviceLabel}</Text> : null}</Text> : null}
                  </View>
                  {work ? <AgentWorked turn={work} load={loadSteps} settle={work.id === watched} /> : null}
                  {mine && !working ? <ForwardedText item={item} /> : !working && item.text ? <ReplyText text={item.text} failed={item.failed} /> : null}
                  {!working && !item.failed ? tweetIds(item.text || "").map(id => <TweetEmbed key={id} id={id} />) : null}
                  {!working && item.attachments?.length ? <Attachments files={item.attachments} /> : null}
                  {item.uploads?.length ? <PendingAttachments files={item.uploads} progress={item.pending ? uploadProgress : null} /> : null}
                  {working ? <AgentProgress line={liveAgentLine(turn && activeAgentTurn(turn) ? turn : null, item.agentWorking ? null : status)} turn={turn && activeAgentTurn(turn) ? turn : null} /> : null}
                  {queued ? <View style={styles.waitingRow}>
                    <Text accessibilityLiveRegion="polite" aria-live="polite" style={styles.queuedDetail}>{queued.steerRequested ? "Adding this to the current reply…" : "Sends after the current reply"}</Text>
                    {!queued.steerRequested ? <IconButton icon="close" label="Remove waiting message" size={14} onPress={() => { void unqueue(queued); }} style={styles.barIcon} /> : null}
                  </View> : null}
                  {item.interrupted ? <Text style={styles.typing}>Cut off before it finished</Text> : null}
                  {item.waitingForAgent ? <Text accessibilityLiveRegion="polite" style={styles.typing}>Sends when the agent is free</Text> : null}
                </View>
              </MessageActions>;
            }}
          />
        )}
        {forwarding ? <ForwardSheet target={forwarding} onClose={() => setForwarding(null)} /> : null}
        {chatUsage?.total ? <Text accessibilityLabel={`This conversation has used ${formatTokens(chatUsage.total)} tokens, about ${formatCost(estimateCost(chatUsage.input, chatUsage.output))} estimated`} style={styles.usageLine}>{formatTokens(chatUsage.total)} tokens · about {formatCost(estimateCost(chatUsage.input, chatUsage.output))}</Text> : null}
        {sendError ? <Text accessibilityRole="alert" style={styles.sendError}>{sendError}</Text> : null}
        {turn?.approval && turn.status === 'waiting_for_approval' && account.user.role === 'owner'
          ? <AgentApprovalCard approval={turn.approval} busy={actionBusy} error={actionError} onAnswer={choice => { void answer(choice); }} /> : null}
        {turn && ['cancelled', 'interrupted', 'failed'].includes(turn.status) ? <View style={styles.turnStatus}><Text accessibilityLiveRegion="polite" style={styles.turnLabel}>{agentTurnLabel(turn)}</Text></View> : null}
        {actionError && !turn?.approval ? <Text accessibilityRole="alert" style={styles.sendError}>{actionError}</Text> : null}
        {commandNote ? <Text accessibilityLiveRegion="polite" selectable style={styles.commandNote} onPress={() => setCommandNote(null)}>{commandNote}</Text> : null}
        {pendingForward && messages !== null && !loadError ? <View testID="forward-draft" style={styles.forwardDraft}>
          <View style={styles.forwardDraftCopy}>
            <ForwardBlock card={{ author: forwardAuthor || "Someone", where: forwardWhere || "", when: "", quote: forwardText || "" }} files={forwardFileCount} lines={3} />
          </View>
          <IconButton icon="close" label="Don't forward this message" onPress={() => setPendingForward(null)} />
        </View> : null}
        {showAbout ? <View style={styles.aboutRow}>
          <Pressable testID="chat-about" accessibilityRole="button" accessibilityLabel={`About: ${aboutName}`} accessibilityHint="Change what this chat is about: a project, prototyping or just the agent"
            accessibilityState={{ busy: switching, expanded: choosing }} aria-expanded={choosing} disabled={switching} onPress={() => setChoosing(true)}
            style={({ pressed }) => [styles.aboutTarget, pressed && { opacity: 0.7 }]}>
            <View style={styles.about}>
              <Text style={styles.aboutLabel}>About</Text>
              <Text style={styles.aboutValue}>{aboutName}</Text>
              {switching ? <ActivityIndicator size="small" color={colors.blueDark} /> : <AppIcon name="chevronDown" size={16} color={colors.blueDark} />}
            </View>
          </Pressable>
          {aboutError ? <Text accessibilityRole="alert" style={styles.aboutError}>{aboutError}</Text> : null}
        </View> : null}
        {messages !== null && !loadError ? <Composer projectId={projectId} draftKey={`chat:${id}`} autoFocus={compose === "1"} commands={{ channel: false, agent: true }} placeholder={pendingForward ? "Message (optional)" : "Message the agent"} onSend={send} allowFileAttachments={false} allowDocuments canSendEmpty={!!pendingForward}
          holdToQueue={busy || activeAgentTurn(turn)} onStop={stoppable ? () => { void stop(); } : undefined} /> : null}
      </ConversationKeyboardView>
      </View>
      {previewOpen && previewUrl && canSplitPreview ? <PreviewPane url={previewUrl} version={previewVersion} stacked={stacked} onClose={() => setPreviewOpen(false)} /> : null}
      </View>
    </View>
    </MediaGalleryProvider>
  );
}

// Touch and hold a message (or ••• on the web) to copy it or forward it to a channel or DM.
function MessageActions({ item, author, chatId, canForward, onForward, label, style, children }: { item: Row; author: string; chatId: string; canForward: boolean; onForward: (t: ForwardTarget) => void; label: string; style: object; children: ReactNode }) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const text = (item.role === "user" ? parseForward(item.text)?.rest ?? item.text : item.text) || "";
  const forwardable = canForward && /^msg_/.test(item.id) && (!!item.text || !!item.attachments?.length);
  const available = forwardable || !!text;
  const show = () => { if (available) { setCopied(null); setOpen(true); } };
  const forward = () => { setOpen(false); onForward({ chatId, messageId: item.id, author, text: text.replace(/\n?PREVIEW:\s*https?:\/\/\S+\s*$/, ""), files: item.attachments?.length ?? 0 }); };
  const copy = async () => {
    try { setCopied(await Clipboard.setStringAsync(text) ? "Copied" : "Couldn't copy"); } catch { setCopied("Couldn't copy"); }
  };
  return <>
    <Pressable onLongPress={show} delayLongPress={400} accessible={false} style={style}>
      <View accessible accessibilityLabel={label} accessibilityHint={available ? "Touch and hold to copy or forward" : undefined}
        accessibilityActions={available ? [{ name: "activate", label: "Copy or forward" }] : undefined} onAccessibilityAction={show} style={styles.actionsRow}>
        {children}
      </View>
      {available && Platform.OS === "web" ? <Pressable testID={`message-actions-${item.id}`} accessibilityRole="button" accessibilityLabel={`Actions for ${author}'s message`} onPress={show} style={styles.more}><Text style={styles.moreText}>•••</Text></Pressable> : null}
    </Pressable>
    {open ? <Modal transparent animationType="fade" visible onRequestClose={() => setOpen(false)}>
      <View style={styles.menuOverlay}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="Dismiss message actions" onPress={() => setOpen(false)} />
        <View accessibilityViewIsModal style={styles.menuCard}>
          <Text style={styles.menuAuthor}>{author}</Text>
          {forwardable ? <Pressable testID="message-forward" accessibilityRole="button" onPress={forward} style={styles.menuAction}><Text style={styles.menuActionText}>Forward</Text></Pressable> : null}
          {text ? <Pressable testID="message-copy" accessibilityRole="button" onPress={() => { void copy(); }} style={styles.menuAction}><Text style={styles.menuActionText}>Copy</Text></Pressable> : null}
          {copied ? <Text accessibilityRole="alert" style={styles.menuStatus}>{copied}</Text> : null}
        </View>
      </View>
    </Modal> : null}
  </>;
}

// Your message, with a forwarded channel/DM message shown as a card.
function ForwardedText({ item }: { item: Row }) {
  const styles = useStyles();
  const parsed = item.forwardPreview ? { forward: item.forwardPreview, rest: item.text } : parseForward(item.text);
  if (!parsed) return item.text ? <Text selectable style={[styles.text, item.failed && styles.failedText]}>{item.text}</Text> : null;
  return <>
    <ForwardBlock card={parsed.forward} />
    {parsed.rest ? <Text selectable style={[styles.text, item.failed && styles.failedText]}>{parsed.rest}</Text> : null}
  </>;
}

function ForwardBlock({ card, files = 0, lines }: { card: ForwardCard; files?: number; lines?: number }) {
  const styles = useStyles();
  const where = [card.where, card.when].filter(Boolean).join(" · ");
  return <View accessible accessibilityLabel={`Forwarded message from ${card.author}${where ? `, ${where}` : ""}. ${card.quote || "No text"}`} style={styles.forward}>
    <Text style={styles.forwardLabel}>Forwarded from {card.author}{where ? <Text style={styles.forwardWhere}> · {where}</Text> : null}</Text>
    {card.quote ? <Text selectable={!lines} numberOfLines={lines} style={styles.forwardQuote}>{card.quote}</Text> : null}
    {files ? <Text style={styles.forwardWhere}>{files === 1 ? "1 attachment" : `${files} attachments`}</Text> : null}
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  actionsRow: { flex: 1, flexDirection: "row", gap: 10 },
  more: { position: "absolute", right: space.xs, top: 0, minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  moreText: { ...typography.label, color: colors.muted },
  menuOverlay: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: space.side, backgroundColor: colors.scrim },
  menuCard: { width: "100%", maxWidth: 420, backgroundColor: colors.background, borderRadius: radius.lg, padding: space.side },
  menuAuthor: { ...typography.bodyStrong, color: colors.ink, marginBottom: space.xs },
  menuAction: { minHeight: 48, paddingVertical: space.sm, justifyContent: "center", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  menuActionText: { ...typography.body, color: colors.blue },
  menuStatus: { ...typography.caption, color: colors.muted, marginTop: space.xs },
  forward: { borderLeftWidth: 3, borderLeftColor: colors.blue, paddingLeft: space.sm, paddingVertical: 2, marginTop: 2, marginBottom: space.xxs, gap: 2 },
  forwardLabel: { ...typography.captionStrong, color: colors.ink },
  forwardWhere: { ...typography.meta, fontWeight: "400", color: colors.muted },
  forwardQuote: { ...typography.body, color: colors.ink },
  forwardDraft: { flexDirection: "row", alignItems: "flex-start", gap: space.xs, paddingLeft: space.side, paddingRight: space.xs, paddingTop: space.sm, paddingBottom: space.xxs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, backgroundColor: colors.background },
  forwardDraftCopy: { flex: 1, minWidth: 0 },
  turnStatus: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingLeft: space.side, paddingRight: space.xs, paddingVertical: space.xs, backgroundColor: colors.surface },
  queue: { backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  queued: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingLeft: space.side, paddingRight: space.xs, paddingVertical: space.xs },
  queuedText: { ...typography.body, color: colors.ink },
  // A 44-point icon button in a bar of text: it overhangs the bar's padding so the bar keeps its height.
  barIcon: { marginVertical: -space.xs },
  // Under a waiting message: what will happen to it, and a small close to take it back.
  waitingRow: { flexDirection: 'row', alignItems: 'center', gap: space.xxs, minHeight: 28 },
  queuedMessage: { opacity: 0.85 },
  queuedDetail: { ...typography.meta, color: colors.muted, flexShrink: 1 },
  turnCopy: { flex: 1 }, turnLabel: { ...typography.captionStrong, color: colors.ink }, turnDetail: { ...typography.meta, color: colors.muted },
  list: { paddingVertical: space.sm },
  readOnlyList: { paddingTop: space.xl },
  fullTitle: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.side, paddingVertical: space.sm, backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  optionsTitle: { ...typography.bodyStrong, color: colors.ink, paddingBottom: space.sm },
  fullTitleText: { ...typography.bodyStrong, flex: 1, color: colors.ink },
  sharedBanner: { paddingHorizontal: space.side, paddingVertical: space.xs, backgroundColor: colors.blueSoft },
  previewInline: { alignSelf: "flex-start", marginTop: space.xs },
  projectLine: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  projectChoice: { minHeight: 44, paddingLeft: space.md, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  shareRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingBottom: space.sm },
  split: { flex: 1, flexDirection: "row" },
  splitStacked: { flexDirection: "column-reverse" },
  chatColumnStacked: { flex: 1.1 },
  previewPaneStacked: { minWidth: 0, borderLeftWidth: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  chatColumn: { flex: 1, minWidth: 0 },
  previewPane: { flex: 1, minWidth: 320, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line, backgroundColor: colors.surface },
  previewBar: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.side, paddingRight: space.xs, minHeight: 44, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  previewBarLink: { minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center" },
  headerLinkText: { ...typography.label, color: colors.blue, ...linkUnderline },
  shareError: { ...typography.meta, color: colors.red, marginTop: space.xxs },
  message: { flexDirection: "row", paddingHorizontal: space.side, paddingVertical: space.sm, gap: 10 },
  messageCopy: { flex: 1, minWidth: 0 },
  messageMeta: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: space.xs, marginBottom: 1 },
  author: { ...typography.bodyStrong, color: colors.ink },
  time: { ...typography.meta, color: colors.muted },
  failed: { backgroundColor: colors.redSoft },
  // Sent but not yet received by the server; full opacity once it's accepted.
  unconfirmed: { opacity: 0.9 },
  text: { ...typography.body, color: colors.ink },
  failedText: { color: colors.red },
  usageLine: { ...typography.caption, color: colors.muted, textAlign: "center", paddingVertical: 2 },
  commandNote: { ...typography.caption, color: colors.ink, backgroundColor: colors.surface, paddingHorizontal: space.side, paddingVertical: space.xs },
  sendError: { ...typography.caption, color: colors.red, backgroundColor: colors.redSoft, paddingHorizontal: space.side, paddingVertical: space.xs },
  typing: { ...typography.body, color: colors.muted, fontStyle: "italic" },
  empty: { alignItems: "center", marginTop: space.xxl, paddingHorizontal: space.side, paddingBottom: space.lg },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center" },
  emptyBody: { ...typography.body, marginTop: space.xs, color: colors.muted, textAlign: "center", maxWidth: 360 },
  retry: { marginTop: space.lg },
  // "About: <choice>" above the message box of a chat with nothing sent yet.
  // The pill is 32 points; the control around it is 44, which is also the row's height.
  aboutRow: { paddingHorizontal: space.side },
  aboutTarget: { alignSelf: "flex-start", maxWidth: "100%", minHeight: 44, justifyContent: "center" },
  about: { maxWidth: "100%", minHeight: 32, flexDirection: "row", alignItems: "center", gap: space.xs, paddingLeft: space.sm, paddingRight: space.xs, borderRadius: radius.pill, backgroundColor: colors.blueSoft },
  aboutLabel: { ...typography.caption, color: colors.muted },
  aboutValue: { ...typography.captionStrong, color: colors.blueDark, flexShrink: 1 },
  aboutError: { ...typography.caption, color: colors.red, paddingBottom: space.xs },
}));
