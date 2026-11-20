import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Button } from "../components/Button";
import { PrototypeReviewSheet } from "../components/PrototypeReviewSheet";
import { ServeLoader } from "../components/ServeLoader";
import { api, ServerError, type Project, type PrototypeComment } from "../lib/server";
import { useSession } from "../lib/session";
import { openNewChat } from "../lib/new-chat";
import { useWideLayout } from "../lib/layout";
import { boxPlace, changesLine, cleanPreviewPath, commentAsk, editsAsk, parsePreviewMessage, reviewerAsk, type PreviewChanges, type PreviewMode, type PreviewSpot } from "../lib/app-preview";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

// App preview (docs/app-preview.md): the project's app running in the browser, at phone size. Use it as normal,
// switch to Comment and click anything (or right-click it any time) to ask the agent about that spot, or switch to
// Edit and change words, sizes, spacing and colors right on the screen, then send them to the agent as one ask.
// Every ask opens a new agent chat in this project with the message written out, ready to send.
let NativeWebView: any = null;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the module is missing in older builds, so it cannot be a static import
if (Platform.OS !== "web") { try { NativeWebView = require("react-native-webview").WebView; } catch { NativeWebView = null; } }

const MODES: { key: PreviewMode; label: string; hint: string }[] = [
  { key: "use", label: "Use", hint: "Use the app as normal. Right-click anything to comment on it" },
  { key: "comment", label: "Comment", hint: "Click anything to ask the agent about it" },
  { key: "edit", label: "Edit", hint: "Click words to change them. A bar above them changes size, spacing and color" },
];
const SIZES = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 } } as const;

export default function AppPreviewScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const wide = useWideLayout();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const { id, path: startPath } = useLocalSearchParams<{ id: string; path?: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [preview, setPreview] = useState<{ url: string; builtAt: string | null; commit: string | null } | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // The sheet for sending this preview to someone outside the server (PrototypeReviewSheet).
  const [sharing, setSharing] = useState(false);
  // What outside reviewers said about this preview on the shares this person made, still waiting for them to decide.
  // An app preview has no chat of its own, so this screen is where its comments come back. Read when the screen opens,
  // after the share sheet closes, and every so often, since a comment can arrive at any time.
  const [waiting, setWaiting] = useState<(PrototypeComment & { email: string })[]>([]);
  const [waitingRead, setWaitingRead] = useState(0);
  const [handling, setHandling] = useState<string | null>(null);
  useEffect(() => {
    if (!account || !id || sharing) return;
    let live = true;
    const read = () => api.appPreviewShares(account, String(id)).then(r => {
      if (live) setWaiting(r.shares.flatMap(share => share.comments.filter(c => !c.setAsideAt).map(c => ({ ...c, email: share.email }))).sort((a, b) => a.createdAt - b.createdAt));
    }, () => { if (live) setWaiting([]); });
    void read();
    const timer = setInterval(() => void read(), 20_000);
    return () => { live = false; clearInterval(timer); };
  }, [account, id, sharing, waitingRead]);
  const [mode, setMode] = useState<PreviewMode>("use");
  const [size, setSize] = useState<keyof typeof SIZES>("phone");
  const [src, setSrc] = useState<string | null>(null);
  const [page, setPage] = useState("/");
  const [goTo, setGoTo] = useState("");
  const [spot, setSpot] = useState<PreviewSpot | null>(null);
  const [comment, setComment] = useState("");
  const [changes, setChanges] = useState<PreviewChanges | null>(null);
  const [note, setNote] = useState("");
  const [frame, setFrame] = useState<any>(null);
  const modeRef = useRef<PreviewMode>("use");

  useEffect(() => {
    if (!account || !id) return;
    let live = true;
    api.project(account, String(id)).then(r => {
      if (!live) return;
      setProject(r.project);
      const p = r.appPreview ?? null;
      const url = p ? (p.url || `${account.serverUrl.replace(/\/+$/, "")}${p.path}`) : null;
      setPreview(p && url ? { url, builtAt: p.builtAt, commit: p.commit } : null);
      if (url) setSrc(`${url.replace(/\/+$/, "")}${cleanPreviewPath(startPath || "/")}`);
    }, e => { if (live) { setPreview(null); setError(e instanceof ServerError ? e.message : "Couldn't load this project"); } });
    return () => { live = false; };
  }, [account, id, startPath]);

  // Tell the page which mode it's in. It forgets on every full load, so this runs again when it says it's ready.
  const sendMode = useCallback((m: PreviewMode) => {
    const msg = JSON.stringify({ servant: "app-preview-mode", mode: m });
    if (Platform.OS === "web") frame?.contentWindow?.postMessage(msg, "*");
    else frame?.injectJavaScript(`window.__servantMode && window.__servantMode(${JSON.stringify(m)}); true;`);
  }, [frame]);
  const pick = (m: PreviewMode) => { modeRef.current = m; setMode(m); setSpot(null); if (m !== "edit") setChanges(null); sendMode(m); };

  const handle = useCallback((raw: unknown) => {
    const m = parsePreviewMessage(raw);
    if (!m) return;
    if (m.type === "ready" || m.type === "page") { setPage(m.page); setSpot(null); if (m.type === "ready") sendMode(modeRef.current); }
    else if (m.type === "at") { setSpot(m); setComment(""); }
    else if (m.type === "edits") setChanges(m.edits.length || m.styles.length ? m : null);
  }, [sendMode]);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const listen = (e: MessageEvent) => { if (frame && e.source === frame.contentWindow) handle(e.data); };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [frame, handle]);

  if (!account) return null;
  const name = project?.name ?? "App";
  const ask = (text: string) => {
    if (!project) return;
    // The ask waits in the new chat's message box, so it can be read and changed before it goes.
    openNewChat(account, { projectId: project.id }, {}, text);
  };
  // Either way the comment leaves the list: handed to the agent (as a message waiting in a new chat, to be read
  // before it is sent), or set aside because it was dealt with some other way.
  const settle = async (item: PrototypeComment & { email: string }, toAgent: boolean) => {
    if (!account || !preview || handling) return;
    setHandling(item.id);
    try {
      await api.setAppPreviewCommentAside(account, String(id), item.id);
      setWaiting(list => list.filter(c => c.id !== item.id));
      if (toAgent) ask(reviewerAsk({ projectName: name, url: preview.url, email: item.email, page: item.page, anchor: item.anchor, comment: item.text, commit: preview.commit }));
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't do that. Try again"); setWaitingRead(n => n + 1); }
    finally { setHandling(null); }
  };
  const sendComment = () => {
    if (!spot || !comment.trim() || !preview) return;
    ask(commentAsk({ projectName: name, url: preview.url, spot, comment, commit: preview.commit }));
    setSpot(null); setComment("");
  };
  const sendEdits = () => {
    if (!changes || !preview) return;
    ask(editsAsk({ projectName: name, url: preview.url, changes, note, commit: preview.commit }));
    setChanges(null); setNote("");
    if (src) setSrc(`${src.split("#")[0]}#${Date.now()}`);
  };
  const go = () => { if (!preview) return; setSrc(`${preview.url.replace(/\/+$/, "")}${cleanPreviewPath(goTo)}`); setGoTo(""); };

  if (preview === undefined) return <View style={styles.root}><Stack.Screen options={{ title: "App preview" }} /><ServeLoader style={{ marginTop: space.xxl }} /></View>;
  if (!preview || !src) return <View style={styles.root}>
    <Stack.Screen options={{ title: project ? `${project.name} preview` : "App preview" }} />
    <Text accessibilityRole={error ? "alert" : undefined} style={styles.empty}>{error ?? "This project has no app preview yet. Ask the agent to export the app for the web and put it on this server (docs/app-preview.md)"}</Text>
  </View>;

  // The whole device fits on screen: shorter than its real height when the window is (the app scrolls inside it).
  const dims = { width: Math.min(SIZES[size].width, Math.max(280, windowWidth - (wide ? 320 : 0) - 32)), height: Math.max(420, Math.min(SIZES[size].height, windowHeight - (mode === "edit" && changes ? 380 : 220))) };
  const box = spot ? boxPlace(spot, dims) : null;
  const hint = MODES.find(m => m.key === mode)!.hint;
  const built = preview.builtAt ? new Date(preview.builtAt) : null;
  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: `${name} preview` }} />
      <View style={styles.bar}>
        <View accessibilityRole="radiogroup" accessibilityLabel="What clicking does" style={styles.segments}>
          {MODES.map(m => <Pressable key={m.key} testID={`preview-mode-${m.key}`} accessibilityRole="radio" accessibilityState={{ checked: mode === m.key }} aria-checked={mode === m.key}
            onPress={() => pick(m.key)} style={[styles.segment, mode === m.key && styles.segmentOn]}>
            <Text style={[styles.segmentText, mode === m.key && styles.segmentTextOn]}>{m.label}</Text>
          </Pressable>)}
        </View>
        {wide ? <View accessibilityRole="radiogroup" accessibilityLabel="Screen size" style={styles.segments}>
          {(Object.keys(SIZES) as (keyof typeof SIZES)[]).map(k => <Pressable key={k} accessibilityRole="radio" accessibilityState={{ checked: size === k }} aria-checked={size === k}
            onPress={() => { setSize(k); setSpot(null); }} style={[styles.segment, size === k && styles.segmentOn]}>
            <Text style={[styles.segmentText, size === k && styles.segmentTextOn]}>{k === "phone" ? "Phone" : "Tablet"}</Text>
          </Pressable>)}
        </View> : null}
        <View style={styles.goRow}>
          <TextInput accessibilityLabel="Go to a page in the app" value={goTo} onChangeText={setGoTo} onSubmitEditing={go} returnKeyType="go" autoCapitalize="none" autoCorrect={false}
            placeholder={page} placeholderTextColor={colors.muted} style={styles.goInput} />
          <Button label="Go" kind="secondary" compact onPress={go} />
        </View>
        {/* For a business owner or subject matter expert who isn't on the server: a link by email, comments back as to-dos. */}
        <Button testID="preview-share" label="Share with a reviewer" kind="secondary" compact onPress={() => setSharing(true)} />
      </View>
      {sharing && account ? <PrototypeReviewSheet account={account} projectId={String(id)} title={`${name} preview`} onClose={() => setSharing(false)} /> : null}
      <Text testID="preview-hint" style={styles.hint}>{hint}</Text>
      {waiting.length ? <View testID="preview-reviewer-comments" style={styles.waiting}>
        <Text style={styles.waitingTitle}>{waiting.length === 1 ? "1 comment from a reviewer" : `${waiting.length} comments from reviewers`}</Text>
        {waiting.map(item => <View key={item.id} testID={`preview-reviewer-comment-${item.id}`} style={styles.waitingItem}>
          <Text style={styles.waitingBy}>{[item.email, item.anchor ? `On \u201c${item.anchor}\u201d` : null, item.page === "/" ? "First screen" : item.page].filter(Boolean).join(" · ")}</Text>
          <Text selectable style={styles.waitingText}>{item.text}</Text>
          <View style={styles.waitingActions}>
            <Button testID={`preview-reviewer-ask-${item.id}`} label="Ask the agent" accessibilityLabel={`Ask the agent about ${item.email}'s comment: ${item.text.slice(0, 80)}`} kind="secondary" compact busy={handling === item.id} disabled={!!handling} onPress={() => void settle(item, true)} />
            <Button testID={`preview-reviewer-aside-${item.id}`} label="Set aside" accessibilityLabel={`Set aside ${item.email}'s comment: ${item.text.slice(0, 80)}`} kind="link" compact disabled={!!handling} onPress={() => void settle(item, false)} />
          </View>
        </View>)}
      </View> : null}
      <ScrollView style={styles.stageScroll} contentContainerStyle={styles.stage}>
        <View testID="app-preview-frame" style={[styles.device, { width: dims.width, height: dims.height }]}>
          {Platform.OS !== "web"
            ? NativeWebView ? <NativeWebView ref={setFrame} key={src} source={{ uri: src }} style={{ flex: 1 }} startInLoadingState setSupportMultipleWindows={false} onMessage={(e: { nativeEvent: { data: string } }) => handle(e.nativeEvent.data)} /> : <Text style={styles.empty}>Update the app to use App preview</Text>
            : createElement("iframe", { ref: setFrame, key: src, src, title: `${name} preview`, style: { flex: 1, width: "100%", height: "100%", border: 0, backgroundColor: colors.background }, sandbox: "allow-scripts allow-forms allow-popups allow-modals" })}
          {spot && box ? <View testID="preview-comment" style={[styles.box, { left: box.left, top: box.top, width: box.width }]}>
            <Text style={styles.boxTitle}>{spot.anchor ? `About "${spot.anchor.length > 60 ? `${spot.anchor.slice(0, 60)}…` : spot.anchor}"` : "About this spot"}</Text>
            <TextInput testID="preview-comment-text" accessibilityLabel="Your comment" value={comment} onChangeText={setComment} autoFocus multiline maxLength={2000}
              placeholder="What should change?" placeholderTextColor={colors.muted} style={styles.boxInput} />
            <View style={styles.boxRow}>
              <Button label="Cancel" kind="link" compact onPress={() => setSpot(null)} />
              <Button testID="preview-comment-send" label="Ask the agent" compact disabled={!comment.trim()} onPress={sendComment} />
            </View>
          </View> : null}
        </View>
        <Text style={styles.meta}>{`${page}${preview.commit ? ` · built from ${preview.commit}` : ""}${built && !Number.isNaN(built.getTime()) ? ` · ${built.toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}. Sample accounts only`}</Text>
      </ScrollView>
      {mode === "edit" && changes ? <View testID="preview-changes" style={styles.tray}>
        <Text style={styles.trayTitle}>{changesLine(changes)}</Text>
        <TextInput accessibilityLabel="Anything to add for the agent" value={note} onChangeText={setNote} placeholder="Anything to add (optional)" placeholderTextColor={colors.muted} style={styles.goInput} />
        <View style={styles.boxRow}>
          <Button label="Discard" kind="danger" compact onPress={() => { setChanges(null); if (src) setSrc(`${src.split("#")[0]}#${Date.now()}`); }} />
          <Button testID="preview-changes-send" label="Send to the agent" compact onPress={sendEdits} />
        </View>
      </View> : null}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  empty: { ...typography.body, color: colors.muted, margin: space.side },
  bar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs, paddingHorizontal: space.side, paddingTop: space.sm, backgroundColor: colors.background },
  segments: { flexDirection: "row", backgroundColor: colors.surface, borderRadius: radius.pill, padding: space.xxs },
  segment: { minHeight: 44, minWidth: 72, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, paddingHorizontal: space.sm },
  segmentOn: { backgroundColor: colors.background, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  segmentText: { ...typography.captionStrong, color: colors.muted },
  segmentTextOn: { color: colors.ink },
  goRow: { flexDirection: "row", alignItems: "center", gap: space.xs, flexGrow: 1, minWidth: 220 },
  goInput: { ...controls.input, minHeight: 44, flex: 1 },
  waiting: { paddingHorizontal: space.side, paddingVertical: space.xs, gap: space.xs, backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  waitingTitle: { ...typography.label, color: colors.muted },
  waitingItem: { gap: space.xxs, paddingLeft: space.sm, borderLeftWidth: 2, borderLeftColor: colors.line },
  waitingBy: { ...typography.caption, color: colors.muted },
  waitingText: { ...typography.body, color: colors.ink },
  waitingActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.sm },
  hint: { ...typography.caption, color: colors.muted, paddingHorizontal: space.side, paddingVertical: space.xs, backgroundColor: colors.background, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  stageScroll: { flex: 1 },
  stage: { alignItems: "center", padding: space.lg, gap: space.sm },
  device: { maxWidth: "100%", borderRadius: radius.xl, overflow: "hidden", borderWidth: space.xs, borderColor: colors.ink, backgroundColor: colors.background },
  meta: { ...typography.caption, color: colors.muted, textAlign: "center" },
  box: { position: "absolute", padding: space.sm, gap: space.xs, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background, boxShadow: `0 10px 28px -6px ${colors.scrim}` } as object,
  boxTitle: { ...typography.captionStrong, color: colors.ink },
  boxInput: { ...controls.input, minHeight: 88, textAlignVertical: "top" },
  boxRow: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: space.xs },
  tray: { padding: space.side, gap: space.xs, backgroundColor: colors.background, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  trayTitle: { ...typography.bodyStrong, color: colors.ink },
}));
