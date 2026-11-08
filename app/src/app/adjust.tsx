import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { router, Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Button } from "../components/Button";
import { useRadioGroup } from "../components/useRadioGroup";
import { appendToDraft } from "../lib/drafts";
import { useProjects } from "../lib/projects-store";
import {
  DEVICE_SIZES,
  addAdjustment,
  adjustCommand,
  adjustPageUrl,
  adjustmentPrompt,
  contrastCheck,
  elementName,
  findingComment,
  groupAdjustments,
  offSystem,
  parseDesignReview,
  parseSuggestion,
  prototypePageUrl,
  ratioText,
  readAdjustMessage,
  readableColor,
  readableLine,
  removeElementAdjustments,
  replayChanges,
  scanFindings,
  scopeName,
  suggestionText,
  tidyValue,
  tokensFor,
  validStyleValue,
  type AdjustElement,
  type AdjustProp,
  type AdjustScope,
  type AdjustStyle,
  type Adjustment,
  type DesignToken,
  type DeviceSize,
  type Finding,
  type Layer,
} from "../lib/prototype-adjustments";
import { AppIcon } from "../components/AppIcon";
import { api, ServerError } from "../lib/server";
import { useSession } from "../lib/session";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

// react-native-web renders this as a real <iframe> (web and the Mac app only).
const Frame = "iframe" as any;
type Mode = { kind: "author"; chatId: string } | { kind: "reviewer"; conv: string; root: string; fromThread: boolean };
type Ready = { mode: Mode; page: string; title: string };

/**
 * Quick adjustments to a design prototype, on its live preview (web and the
 * Mac app). The author's changes become a request in the design chat's message
 * box, to review and send; a reviewer's become a suggestion in the review
 * thread. Nothing changes the prototype until its agent applies them.
 */
export default function AdjustPrototype() {
  const styles = useStyles();
  const { account } = useSession();
  const projects = useProjects();
  const params = useLocalSearchParams<{ chat?: string; conv?: string; root?: string; from?: string }>();
  const [ready, setReady] = useState<Ready | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);

  // Work out what may be adjusted from the server, never from the link alone.
  useEffect(() => {
    if (!account || !projects) return;
    let live = true;
    const origin = projects.prototypeOrigin;
    const fail = (message: string) => { if (live) setBlocked(message); };
    if (Platform.OS !== "web") { fail("Adjusting designs works in a browser and the Mac app for now."); return; }
    if (!origin) { fail("This server doesn't support adjusting designs yet."); return; }
    if (params.chat) {
      api.chat(account, String(params.chat)).then(chat => {
        const page = prototypePageUrl(chat.previewUrl, origin);
        if (chat.mode !== "vibe" || chat.readOnly || chat.canSend === false) return fail("Only the design's author can adjust it here. Others can suggest adjustments from its review thread.");
        if (!page || chat.previewReady === false) return fail("This design doesn't have a published page yet.");
        if (live) setReady({ mode: { kind: "author", chatId: chat.id }, page, title: chat.title || "Untitled design" });
      }).catch(e => fail(e instanceof ServerError ? e.message : "Couldn't open this design."));
    } else if (params.conv && params.root) {
      api.thread(account, String(params.conv), String(params.root)).then(thread => {
        const review = parseDesignReview(thread.root.text);
        const page = review && prototypePageUrl(review.preview, origin);
        if (!review || !page) return fail("This message isn't a design review with a preview from this server.");
        if (live) setReady({ mode: { kind: "reviewer", conv: String(params.conv), root: String(params.root), fromThread: params.from === "thread" }, page, title: review.title });
      }).catch(e => fail(e instanceof ServerError ? e.message : "Couldn't open this review thread."));
    } else fail("Open Adjust design from a design's preview or its review thread.");
    return () => { live = false; };
  }, [account, projects, params.chat, params.conv, params.root, params.from]);

  return <View style={styles.root}>
    <Stack.Screen options={{ title: ready ? `Adjust ${ready.title}` : "Adjust design" }} />
    {ready ? <Adjuster {...ready} /> : <View style={styles.center}>
      <Text accessibilityRole={blocked ? "alert" : undefined} style={styles.help}>{blocked ?? "Opening the preview…"}</Text>
      {blocked ? <Button label="Back" kind="secondary" onPress={() => router.back()} /> : null}
    </View>}
  </View>;
}

type Tab = "edit" | "changes" | "check";

function Adjuster({ mode, page, title }: Ready) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const navigation = useNavigation();
  const { width, height } = useWindowDimensions();
  const wide = width >= 900;
  const frame = useRef<HTMLIFrameElement | null>(null);
  const attachFrame = useCallback((node: HTMLIFrameElement | null) => { frame.current = node; }, []);
  const src = useMemo(() => adjustPageUrl(page), [page]);
  const [connected, setConnected] = useState(false);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<AdjustElement | null>(null);
  const selectedId = useRef<string | null>(null);
  const [changes, setChanges] = useState<Adjustment[]>([]);
  // Earlier lists, newest last, for Undo. The message handler reads the current list from the ref.
  const history = useRef<Adjustment[][]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const changesRef = useRef<Adjustment[]>([]);
  // The editor's fields start over only when the page describes the element after a change of the
  // list, not when it's described again for another reason (a new preview size), so typing isn't lost.
  const revision = useRef(0);
  const [described, setDescribed] = useState(0);
  const [tokens, setTokens] = useState<DesignToken[]>([]);
  const [device, setDevice] = useState<DeviceSize>("fit");
  // A size-only change applies to the element it was chosen for; selecting another goes back to all sizes.
  const [scope, setScope] = useState<AdjustScope | undefined>(undefined);
  const [original, setOriginal] = useState(false);
  const [tab, setTab] = useState<Tab>("edit");
  const [layers, setLayers] = useState<Layer[] | null>(null);
  const layersOpen = useRef(false);
  const [findings, setFindings] = useState<{ list: Finding[]; stale: boolean } | null>(null);
  const [scanning, setScanning] = useState(false);
  // A finding's comment waits until its element is selected (the page describes it then).
  const pendingComment = useRef<{ id: string; text: string } | null>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [note, setNote] = useState("");
  const [notice, setNotice] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [leaving, setLeaving] = useState<null | (() => void)>(null);
  const finished = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unsaved = changes.length > 0 || !!note.trim();

  const send = useCallback((message: Record<string, unknown>) => { frame.current?.contentWindow?.postMessage(message, "*"); }, []);
  // Each change list goes to the page in full: it restores the original, then shows each change in order.
  const update = useCallback((next: Adjustment[], { undo = false } = {}) => {
    const before = changesRef.current;
    // A change that changes nothing (the same value again) isn't a step to undo.
    if (next === before || JSON.stringify(next) === JSON.stringify(before)) return;
    changesRef.current = next;
    revision.current += 1;
    setChanges(next);
    if (!undo) history.current = [...history.current, before].slice(-50);
    setCanUndo(history.current.length > 0);
    setOriginal(false);
    setFindings(found => found && { ...found, stale: true });
    send(adjustCommand("replay", { changes: replayChanges(next) }));
  }, [send]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      // Only the preview this screen opened; its messages are checked before use.
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const message = readAdjustMessage(event.data);
      if (!message) return;
      if (message.type === "ready") {
        setConnected(true);
        setTokens(message.tokens);
        // Ready to pick straight away: click anything in the preview.
        send(adjustCommand("pick", { on: true }));
      }
      else if (message.type === "picking") setPicking(message.on);
      else if (message.type === "editing") setNotice(message.on ? "Editing the text on the page. Press Enter to keep it or Escape to cancel." : "");
      else if (message.type === "selected") {
        // The page describes the selection again after every change; only a new one is announced.
        const fresh = selectedId.current !== message.element.id;
        if (fresh) { setScope(undefined); setNotice(`Selected: ${elementName(message.element)}`); }
        selectedId.current = message.element.id;
        setDescribed(revision.current);
        setSelected(message.element);
        const waiting = pendingComment.current;
        if (waiting && waiting.id === message.element.id) {
          pendingComment.current = null;
          update(addAdjustment(changesRef.current, message.element, "comment", waiting.text));
          setNotice(`Added a comment to ${elementName(message.element)} for the agent.`);
        }
      }
      else if (message.type === "edited") {
        setSelected(message.element);
        update(addAdjustment(changesRef.current, message.element, "text", message.text));
      }
      else if (message.type === "layers") setLayers(message.items);
      else if (message.type === "scanned") {
        const list = scanFindings(message.issues, message.texts);
        setScanning(false);
        setFindings({ list, stale: false });
        setNotice(list.length ? `The check found ${list.length === 1 ? "1 thing" : `${list.length} things`} to look at.` : "The check found nothing to fix.");
      }
      else if (message.type === "replayed") {
        if (layersOpen.current) send(adjustCommand("layers"));
        if (message.failed.length) setNotice(`${message.failed.length === 1 ? "1 change" : `${message.failed.length} changes`} couldn't be shown in the preview. They're still in your list.`);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [send, update]);
  const undo = useCallback(() => {
    const previous = history.current.at(-1);
    if (!previous) return;
    history.current = history.current.slice(0, -1);
    update(previous, { undo: true });
    setNotice("Undid the last change.");
  }, [update]);
  // ⌘Z / Ctrl+Z undoes, except while typing in a field (which has its own undo).
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== "z") return;
      if (target && (/^(input|textarea|select)$/i.test(target.tagName) || target.isContentEditable)) return;
      event.preventDefault();
      undo();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [undo]);
  // Leaving with changes that haven't gone anywhere asks first (Back, Cancel, the sidebar, closing the tab).
  useEffect(() => {
    if (!unsaved) return;
    const leave = (event: { preventDefault: () => void; data: { action: unknown } }) => {
      if (finished.current) return;
      event.preventDefault();
      setLeaving(() => () => navigation.dispatch(event.data.action as never));
    };
    const unsubscribe = navigation.addListener("beforeRemove" as never, leave as never);
    const unload = (event: BeforeUnloadEvent) => { if (!finished.current) event.preventDefault(); };
    window.addEventListener("beforeunload", unload);
    return () => { unsubscribe(); window.removeEventListener("beforeunload", unload); };
  }, [unsaved, navigation]);

  const change = (prop: AdjustProp, value: string | boolean) => {
    if (!selected) return;
    const before = changesRef.current.length;
    const next = addAdjustment(changesRef.current, selected, prop, value, scope);
    update(next);
    if (prop === "move") setNotice(next.length > before ? `Moved ${elementName(selected)} ${value === "earlier" ? "earlier" : "later"}.` : "It can't move further that way.");
    if (prop === "comment") setNotice(value ? `Comment added to ${elementName(selected)}.` : "Comment removed.");
  };
  const togglePicking = () => send(adjustCommand("pick", { on: !picking }));
  const step = (to: "parent" | "child" | "previous" | "next") => selected && send(adjustCommand("select", { id: selected.id, to }));
  const pickDevice = (next: DeviceSize) => {
    setDevice(next);
    setScope(undefined);
    // Its styles at the new width (a size-only change starts from these).
    if (selectedId.current) setTimeout(() => send(adjustCommand("select", { id: selectedId.current })), 150);
  };
  const toggleOriginal = () => {
    const next = !original;
    setOriginal(next);
    send(adjustCommand("replay", { changes: next ? [] : replayChanges(changes) }));
    setNotice(next ? "Showing the original. Your changes are kept." : "Showing your changes.");
  };
  const toggleLayers = () => {
    layersOpen.current = !layers;
    if (layers) setLayers(null); else send(adjustCommand("layers"));
  };
  const scan = () => { setScanning(true); send(adjustCommand("scan")); };
  const addFinding = (finding: Finding) => {
    if (finding.id) {
      pendingComment.current = { id: finding.id, text: findingComment(finding) };
      send(adjustCommand("select", { id: finding.id }));
    } else {
      setNote(current => [current.trim(), findingComment(finding)].filter(Boolean).join("\n"));
      setNotice("Added to your note for the agent.");
    }
  };
  const devices = useRadioGroup({ values: DEVICE_SIZES.map(d => d.id), value: device, onChange: pickDevice, label: "Preview size" });
  const tabs = useRadioGroup({ values: ["edit", "changes", "check"] as const, value: tab, onChange: setTab, label: "Adjust panel" });

  // Back where this came from (asks first when there are changes), or to the design chat or thread when opened from a link.
  const leave = () => {
    const go = () => {
      finished.current = true;
      if (router.canGoBack()) router.back();
      else if (mode.kind === "author") router.replace({ pathname: "/chat/[id]", params: { id: mode.chatId, title, studio: "1" } });
      else router.replace({ pathname: "/thread", params: { conv: mode.conv, root: mode.root } });
    };
    if (unsaved) setLeaving(() => go); else go();
  };
  const request = mode.kind === "author" ? adjustmentPrompt({ title, page, list: changes, note }) : suggestionText({ title, list: changes, note });
  const finish = async () => {
    if ((!changes.length && !note.trim()) || busy || !account) return;
    setBusy(true);
    setError(null);
    try {
      finished.current = true;
      if (mode.kind === "author") {
        // Left unsent: the author sends it from the design chat.
        appendToDraft(`chat:${mode.chatId}`, request);
        if (router.canGoBack()) router.back();
        else router.replace({ pathname: "/chat/[id]", params: { id: mode.chatId, title, compose: "1", studio: "1" } });
      } else {
        await api.post(account, mode.conv, request, mode.root);
        // Back to the thread, where the suggestion now is (wherever Suggest adjustments was pressed).
        if (mode.fromThread && router.canGoBack()) router.back();
        else router.replace({ pathname: "/thread", params: { conv: mode.conv, root: mode.root } });
      }
    } catch (e) {
      finished.current = false;
      setError(e instanceof ServerError ? e.message : "Couldn't post the suggestion. Check your connection and try again.");
      setBusy(false);
    }
  };

  // A device size shows the page at that width, scaled down to fit when the space is narrower.
  const deviceWidth = DEVICE_SIZES.find(d => d.id === device)?.width ?? null;
  const scale = deviceWidth && area.width && deviceWidth > area.width ? area.width / deviceWidth : 1;
  const frameStyle = deviceWidth
    ? { width: deviceWidth, height: area.height ? area.height / scale : "100%", flex: undefined, transform: `scale(${scale})`, transformOrigin: "top left" }
    : { flex: 1, width: "100%", height: "100%" };
  // The page also runs in the server's sandbox (its own origin, no access to Servant).
  const preview = <Frame ref={attachFrame} src={src} title={`Preview of ${title}, for adjusting`} sandbox="allow-scripts allow-forms"
    style={{ border: 0, backgroundColor: "#FFFFFF", minHeight: 0, display: "block", ...frameStyle }} />;
  const groups = groupAdjustments(changes);
  const scopeChoice = deviceWidth && device !== "fit" ? device as AdjustScope : null;
  const count = changes.length;

  return <View style={[styles.layout, wide && styles.layoutWide]}>
    <View style={[styles.previewColumn, wide ? styles.previewWide : { height: Math.max(220, Math.min(420, Math.round(height * 0.38))) }]}>
      <View style={styles.toolbar}>
        <View {...devices.group} style={styles.chips}>{DEVICE_SIZES.map((d, index) => <Chip key={d.id} {...devices.radio(d.id, index)} label={d.label}
          hint={d.width ? `Shows the page ${d.width}px wide` : "Fills the space available"} selected={device === d.id} />)}</View>
        <View style={styles.chips}>
          <ToolButton label={original ? "Show changes" : "Show original"} disabled={!connected || !count} onPress={toggleOriginal}
            hint="Switches the preview between the page as published and with your changes" />
          <ToolButton label="Undo" disabled={!canUndo} onPress={undo} hint="Undoes your last change. Command or Control Z works too." />
        </View>
      </View>
      {scope ? <View style={styles.scopeBar}>
        <Text style={styles.scopeText}>Style changes to this element apply to {scopeName(scope).toLowerCase()} sizes only.</Text>
        <Button label="Apply to all sizes" kind="link" compact onPress={() => setScope(undefined)} />
      </View> : null}
      <View style={[styles.previewWrap, !!deviceWidth && scale === 1 && styles.previewCentered]} onLayout={event => setArea({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>{preview}</View>
      {original ? <Text style={styles.banner}>Showing the original page</Text> : null}
    </View>
    <View style={[styles.panel, wide && styles.panelWide]}>
      <View style={styles.panelHead}>
        {wide ? <Text style={styles.help}>{mode.kind === "author" ? "Changes show only here until you add them to your design chat." : "Changes show only here until you post them as a suggestion."}</Text> : null}
        <Text accessibilityLiveRegion="polite" style={styles.status}>{connected ? notice : "Connecting to the preview…"}</Text>
        <View {...tabs.group} style={styles.tabs}>
          {(["edit", "changes", "check"] as const).map((id, index) => <Chip key={id} {...tabs.radio(id, index)} selected={tab === id}
            label={id === "edit" ? "Edit" : id === "changes" ? `Changes${count ? ` (${count})` : ""}` : "Accessibility"} />)}
        </View>
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={styles.panelContent} keyboardShouldPersistTaps="handled">
        {tab === "edit" ? <>
          <View style={styles.row}>
            <Button label={picking ? "Selecting: on" : "Select in the preview"} kind={picking ? "primary" : "secondary"} compact disabled={!connected} onPress={togglePicking}
              accessibilityHint={picking ? "Click an element in the preview to select it, or double-click text to edit it. Press to turn selecting off and use the page normally." : "Then click an element in the preview."} />
            <Button label={layers ? "Hide layers" : "Layers"} kind="secondary" compact disabled={!connected} onPress={toggleLayers} accessibilityHint="Lists the page's elements so you can select one" />
            <Button label="Select first element" kind="link" compact disabled={!connected} onPress={() => send(adjustCommand("select", { id: "first" }))}
              accessibilityHint="Then use Parent, Previous, Next and Inside to move" />
          </View>
          {layers ? <View accessibilityRole="list" accessibilityLabel="Layers" style={styles.layers}>
            {layers.map(layer => <Pressable key={layer.id} accessibilityRole="button" accessibilityLabel={`${elementName(layer)}${layer.hidden ? ", hidden" : ""}, level ${layer.depth + 1}`}
              accessibilityState={{ selected: selected?.id === layer.id }} onPress={() => send(adjustCommand("select", { id: layer.id }))}
              style={({ pressed }) => [styles.layer, { paddingLeft: space.xs + layer.depth * 12 }, selected?.id === layer.id && styles.layerSelected, pressed && styles.pressed]}>
              <Text numberOfLines={1} style={[styles.layerText, layer.hidden && styles.layerHidden]}>{elementName(layer)}</Text>
            </Pressable>)}
          </View> : null}
          {selected ? <ElementEditor key={`${selected.id}|${described}|${scope ?? ""}`} element={selected} tokens={tokens}
            comment={changes.find(item => item.element.id === selected.id && item.prop === "comment")?.to as string | undefined}
            scopeChoice={scopeChoice} scope={scope} onScope={setScope} onChange={change} onStep={step} onEditOnPage={() => send(adjustCommand("edit", { id: selected.id }))} />
            : <Text style={styles.help}>Click something in the preview to change its text, style or layout, or to leave a comment on it.</Text>}
        </> : tab === "changes" ? <View style={styles.section}>
          {groups.length ? groups.map(group => <View key={group.element.id} style={styles.change}>
            <View style={styles.flex}>
              <Text style={styles.strongText}>{elementName(group.element)}</Text>
              {group.changes.map((line, index) => <Text key={index} style={styles.changeText}>{line}</Text>)}
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove changes to ${elementName(group.element)}`} hitSlop={8}
              onPress={() => update(removeElementAdjustments(changes, group.element.id))} style={({ pressed }) => [styles.remove, pressed && styles.pressed]}>
              <AppIcon name="close" size={16} />
            </Pressable>
          </View>) : <Text style={styles.help}>No changes yet. Select something in the preview to start.</Text>}
          {count > 1 ? <Button label="Remove all" kind="link" compact onPress={() => update([])} /> : null}
          <Field label={mode.kind === "author" ? "Note for the agent (optional)" : "Note for the author (optional)"} value={note} onChange={setNote} multiline />
        </View> : <View style={styles.section}>
          <Text style={styles.help}>Checks contrast, names, labels, headings and tap sizes. It's no substitute for testing with assistive technology.</Text>
          <Button label={findings ? "Check again" : "Check accessibility"} kind="secondary" compact busy={scanning} disabled={!connected} onPress={scan} />
          {findings?.stale ? <Text style={styles.help}>You've made changes since this check. Check again to include them.</Text> : null}
          {findings && !findings.list.length ? <Text style={styles.help}>Nothing found.</Text> : null}
          {findings?.list.map((finding, index) => <View key={`${finding.id}-${index}`} style={styles.finding}>
            <AppIcon name="warning" size={14} color={colors.red} />
            <View style={styles.flex}>
              <Text style={styles.changeText}><Text style={styles.strong}>{finding.name}:</Text> {finding.problem}</Text>
              <View style={styles.row}>
                {finding.id ? <Button label="Select it" kind="link" compact onPress={() => send(adjustCommand("select", { id: finding.id }))} /> : null}
                <Button label={finding.id ? "Add as a comment" : "Add to my note"} kind="link" compact onPress={() => addFinding(finding)}
                  accessibilityHint="Asks the agent to fix it, with your other changes" />
              </View>
            </View>
          </View>)}
        </View>}
      </ScrollView>
      <View style={styles.footer}>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <View style={styles.footerRow}>
          <Button label="Cancel" kind="link" compact onPress={leave} />
          <Button label={mode.kind === "author" ? "Review request" : "Review suggestion"} disabled={!count && !note.trim()} onPress={() => setReviewing(true)} style={styles.flex}
            accessibilityHint={mode.kind === "author" ? "Shows the request for the agent before it's added to your design chat" : "Shows the suggestion before it's posted to the thread"} />
        </View>
      </View>
    </View>
    {reviewing ? <ReviewSheet mode={mode.kind} request={request} busy={busy} error={error} onConfirm={() => { void finish(); }} onClose={() => setReviewing(false)} /> : null}
    <ConfirmDialog visible={!!leaving} title="Leave without your changes?" confirmLabel="Leave"
      description={mode.kind === "author" ? "Your changes haven't been added to your design chat yet, so they'll be lost." : "Your suggestion hasn't been posted yet, so it will be lost."}
      onConfirm={() => { const go = leaving; finished.current = true; setLeaving(null); go?.(); }} onCancel={() => setLeaving(null)} />
  </View>;
}

// The full request (or suggestion) to read before it goes anywhere.
function ReviewSheet({ mode, request, busy, error, onConfirm, onClose }: { mode: "author" | "reviewer"; request: string; busy: boolean; error: string | null; onConfirm: () => void; onClose: () => void }) {
  const styles = useStyles();
  const people = mode === "reviewer" ? suggestionForPeople(request) : null;
  return <Modal visible transparent animationType="fade" onRequestClose={() => { if (!busy) onClose(); }}>
    <View style={styles.scrim}>
      <View accessibilityViewIsModal style={styles.sheet}>
        <Text accessibilityRole="header" style={styles.heading}>{mode === "author" ? "Review your request" : "Review your suggestion"}</Text>
        <Text style={styles.help}>{mode === "author"
          ? "This is added to your design chat's message box. Nothing is sent until you send it there."
          : "This is posted in the review thread, where everyone in it can read it. Only the design's author can add it to their design chat."}</Text>
        <ScrollView style={styles.requestBox} contentContainerStyle={styles.requestContent}>
          <Text selectable style={styles.requestText}>{people ?? request}</Text>
        </ScrollView>
        {people ? <Text style={styles.help}>The posted reply also says where each element is on the page, for the agent.</Text> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <View style={styles.sheetActions}>
          <Button label="Keep editing" kind="secondary" disabled={busy} onPress={onClose} />
          <Button label={mode === "author" ? "Add to design chat" : "Post to the thread"} busy={busy} onPress={onConfirm} />
        </View>
      </View>
    </View>
  </Modal>;
}
// A suggestion as teammates read it: the changes without CSS paths, sizes rounded.
function suggestionForPeople(text: string) {
  const parsed = parseSuggestion(text);
  if (!parsed) return text;
  return [...parsed.changes.map(line => `• ${readableLine(line)}`), ...(parsed.note ? ["", `Reviewer's note: ${parsed.note}`] : [])].join("\n");
}

function ToolButton({ label, hint, disabled, onPress }: { label: string; hint: string; disabled?: boolean; onPress: () => void }) {
  const styles = useStyles();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.chip, disabled && styles.disabled, pressed && styles.pressed]}>
    <Text style={styles.chipText}>{label}</Text>
  </Pressable>;
}

const WEIGHTS = [{ value: "400", label: "Regular" }, { value: "500", label: "Medium" }, { value: "600", label: "Semibold" }, { value: "700", label: "Bold" }] as const;
const ALIGNS = [{ value: "left", label: "Left" }, { value: "center", label: "Center" }, { value: "right", label: "Right" }] as const;
const STYLE_LABELS: Partial<Record<AdjustStyle, string>> = { "font-size": "Font size", "border-radius": "Corner radius", padding: "Padding", margin: "Margin", width: "Width", height: "Height" };

function ElementEditor({ element, tokens, comment, scopeChoice, scope, onScope, onChange, onStep, onEditOnPage }: {
  element: AdjustElement;
  tokens: readonly DesignToken[];
  comment: string | undefined;
  scopeChoice: AdjustScope | null;
  scope: AdjustScope | undefined;
  onScope: (scope: AdjustScope | undefined) => void;
  onChange: (prop: AdjustProp, value: string | boolean) => void;
  onStep: (to: "parent" | "child" | "previous" | "next") => void;
  onEditOnPage: () => void;
}) {
  const styles = useStyles();
  const [text, setText] = useState(element.text ?? "");
  const [note, setNote] = useState(comment ?? "");
  const weight = WEIGHTS.find(w => w.value === element.styles["font-weight"])?.value ?? null;
  const align = ALIGNS.find(a => a.value === element.styles["text-align"] || (a.value === "left" && element.styles["text-align"] === "start"))?.value ?? null;
  const weights = useRadioGroup({ values: WEIGHTS.map(w => w.value), value: weight, onChange: value => onChange("font-weight", value), label: "Font weight" });
  const aligns = useRadioGroup({ values: ALIGNS.map(a => a.value), value: align, onChange: value => onChange("text-align", value), label: "Text alignment" });
  const scopes = useRadioGroup({ values: ["all", "size"] as const, value: scope ? "size" : "all", onChange: value => onScope(value === "size" && scopeChoice ? scopeChoice : undefined), label: "Style changes apply to" });
  const contrast = element.text !== null || element.label ? contrastCheck(element.styles.color, element.backdrop, element.styles["font-size"], element.styles["font-weight"]) : null;
  return <View style={styles.section}>
    <Text accessibilityRole="header" style={styles.heading}>{elementName(element)}</Text>
    <View style={styles.row}>
      <Button label="Parent" kind="secondary" compact disabled={!element.hasParent} onPress={() => onStep("parent")} />
      <Button label="Previous" kind="secondary" compact disabled={!element.previous} onPress={() => onStep("previous")} />
      <Button label="Next" kind="secondary" compact disabled={!element.next} onPress={() => onStep("next")} />
      <Button label="Inside" kind="secondary" compact disabled={!element.hasChildren} onPress={() => onStep("child")} />
    </View>

    <Text accessibilityRole="header" style={styles.subheading}>Content</Text>
    {element.text !== null ? <>
      <Field label="Text" value={text} onChange={setText} multiline={text.length > 60} />
      <View style={styles.row}>
        <Button label="Apply text" kind="secondary" compact disabled={text === element.text} onPress={() => onChange("text", text)} />
        <Button label="Edit on page" kind="link" compact onPress={onEditOnPage} accessibilityHint="Type straight into the preview. Enter keeps it, Escape cancels." />
      </View>
    </> : <Text style={styles.help}>This holds other elements. Select one inside it to change its text.</Text>}

    <Text accessibilityRole="header" style={styles.subheading}>Style</Text>
    {scopeChoice ? <>
      <Text style={styles.label}>Style changes apply to</Text>
      <View {...scopes.group} style={styles.chips}>
        <Chip {...scopes.radio("all", 0)} label="All sizes" selected={!scope} />
        <Chip {...scopes.radio("size", 1)} label={`${scopeName(scopeChoice)} only`} selected={!!scope} hint="For this element only. Other sizes keep the current style." />
      </View>
    </> : null}
    <Text style={styles.help}>Sizes like 16px, 1.5rem or 50%. Press Enter to apply.</Text>
    <ColorField label="Text color" prop="color" element={element} tokens={tokens} onApply={value => onChange("color", value)} />
    <ColorField label="Background" prop="background-color" element={element} tokens={tokens} onApply={value => onChange("background-color", value)} />
    {contrast && contrast.ratio !== null ? <Text accessibilityLiveRegion="polite" style={contrast.ok ? styles.help : styles.warning}>
      {contrast.ok ? `Text contrast ${ratioText(contrast.ratio)} (needs ${contrast.needed}:1).` : `Low text contrast: ${ratioText(contrast.ratio)} (needs ${contrast.needed}:1).`}
    </Text> : null}
    <StyleField prop="font-size" element={element} tokens={tokens} onApply={value => onChange("font-size", value)} />
    <Text style={styles.label}>Font weight</Text>
    <View {...weights.group} style={styles.chips}>{WEIGHTS.map((w, index) => <Chip key={w.value} {...weights.radio(w.value, index)} label={w.label} selected={weight === w.value} />)}</View>
    <Text style={styles.label}>Text alignment</Text>
    <View {...aligns.group} style={styles.chips}>{ALIGNS.map((a, index) => <Chip key={a.value} {...aligns.radio(a.value, index)} label={a.label} selected={align === a.value} />)}</View>
    <StyleField prop="border-radius" element={element} tokens={tokens} onApply={value => onChange("border-radius", value)} />
    <StyleField prop="padding" element={element} tokens={tokens} onApply={value => onChange("padding", value)} />
    <StyleField prop="margin" element={element} tokens={tokens} onApply={value => onChange("margin", value)} />

    <Text accessibilityRole="header" style={styles.subheading}>Layout</Text>
    <StyleField prop="width" element={element} tokens={tokens} onApply={value => onChange("width", value)} />
    <StyleField prop="height" element={element} tokens={tokens} onApply={value => onChange("height", value)} />
    <View style={styles.row}>
      <Button label="Move earlier" kind="secondary" compact disabled={!element.previous} onPress={() => onChange("move", "earlier")}
        accessibilityHint={element.previous ? `Moves it before ${elementName(element.previous)}` : undefined} />
      <Button label="Move later" kind="secondary" compact disabled={!element.next} onPress={() => onChange("move", "later")}
        accessibilityHint={element.next ? `Moves it after ${elementName(element.next)}` : undefined} />
      <Button label={element.hidden ? "Show element" : "Hide element"} kind="secondary" compact onPress={() => onChange("hidden", !element.hidden)} />
    </View>

    <Text accessibilityRole="header" style={styles.subheading}>Comment</Text>
    <Field label="Comment for the agent (optional)" value={note} onChange={setNote} multiline help="For things that aren't a quick change, like “make this feel less crowded”." />
    <Button label={comment ? (note.trim() ? "Update comment" : "Remove comment") : "Add comment"} kind="secondary" compact disabled={note.trim() === (comment ?? "")}
      onPress={() => onChange("comment", note)} />
  </View>;
}

function Chip({ label, selected, hint, ...radio }: { label: string; selected: boolean; hint?: string } & Record<string, unknown>) {
  const styles = useStyles();
  return <Pressable {...radio} accessibilityLabel={label} accessibilityHint={hint} style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}>
    <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
  </Pressable>;
}

function Field({ label, value, onChange, multiline, onDone, invalid, help }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean; onDone?: () => void; invalid?: string | null; help?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} multiline={multiline} onBlur={onDone} onSubmitEditing={multiline ? undefined : onDone}
      placeholderTextColor={colors.muted} style={[styles.input, multiline && styles.multiline, !!invalid && styles.inputInvalid]} />
    {invalid ? <Text accessibilityRole="alert" style={styles.error}>{invalid}</Text> : help ? <Text style={styles.help}>{help}</Text> : null}
  </View>;
}

// The page's design-kit tokens that fit this property, as one-tap choices.
function TokenChips({ prop, element, tokens, onPick }: { prop: AdjustStyle; element: AdjustElement; tokens: readonly DesignToken[]; onPick: (value: string) => void }) {
  const styles = useStyles();
  const fitting = tokensFor(prop, tokens).slice(0, 8);
  if (!fitting.length) return null;
  const color = prop === "color" || prop === "background-color";
  return <View accessibilityRole="list" accessibilityLabel={`Design kit ${color ? "colors" : "sizes"}`} style={styles.chips}>
    {fitting.map(token => {
      const current = element.tokens[prop] === token.name;
      return <Pressable key={token.name} accessibilityRole="button" accessibilityLabel={`Design kit ${token.name.replace(/^--/, "")}, ${color ? readableColor(token.value) : token.value}${current ? ", in use" : ""}`}
        accessibilityState={{ selected: current }} onPress={() => onPick(`var(${token.name})`)} style={({ pressed }) => [styles.token, current && styles.chipSelected, pressed && styles.pressed]}>
        {color ? <View style={[styles.swatch, { backgroundColor: token.value }]} /> : null}
        <Text style={[styles.tokenText, current && styles.chipTextSelected]} numberOfLines={1}>{token.name.replace(/^--/, "")}</Text>
      </Pressable>;
    })}
  </View>;
}

function StyleField({ prop, element, tokens, onApply }: { prop: AdjustStyle; element: AdjustElement; tokens: readonly DesignToken[]; onApply: (value: string) => void }) {
  const styles = useStyles();
  const start = element.tokens[prop] ? `var(${element.tokens[prop]})` : tidyValue(element.styles[prop]);
  const [value, setValue] = useState(start);
  const [invalid, setInvalid] = useState<string | null>(null);
  const apply = (next = value) => {
    if (next.trim() === start) return;
    if (!validStyleValue(prop, next)) { setInvalid(`Enter a valid ${(STYLE_LABELS[prop] ?? prop).toLowerCase()}, like ${prop === "width" || prop === "height" ? "320px, 50% or auto" : prop === "margin" ? "16px or 8px auto" : "16px"}.`); return; }
    setInvalid(null);
    onApply(next.trim());
  };
  const off = !invalid && value.trim() !== start && offSystem(prop, value, tokens);
  return <View style={styles.field}>
    <Field label={STYLE_LABELS[prop] ?? prop} value={value} onChange={setValue} onDone={() => apply()} invalid={invalid} />
    {off ? <Text style={styles.help}>Not one of this page's design-kit values.</Text> : null}
    <TokenChips prop={prop} element={element} tokens={tokens} onPick={token => { setValue(token); apply(token); }} />
  </View>;
}

function ColorField({ label, prop, element, tokens, onApply }: { label: string; prop: "color" | "background-color"; element: AdjustElement; tokens: readonly DesignToken[]; onApply: (value: string) => void }) {
  const styles = useStyles();
  const start = element.tokens[prop] ? `var(${element.tokens[prop]})` : readableColor(element.styles[prop]);
  const [text, setText] = useState(start);
  const [invalid, setInvalid] = useState<string | null>(null);
  const apply = (next: string) => {
    if (next.trim() === start) return;
    if (!validStyleValue("color", next)) { setInvalid("Enter a color like #1a73e8."); return; }
    setInvalid(null);
    onApply(next.trim());
  };
  // The swatch shows the color in use, even when the field holds a token name.
  const shownColor = readableColor(element.styles[prop]);
  const swatch = /^#[0-9a-f]{6}$/i.test(text) ? text : /^#[0-9a-f]{6}$/i.test(shownColor) ? shownColor : "#ffffff";
  const off = !invalid && text.trim() !== start && offSystem(prop, text, tokens);
  return <View style={styles.field}>
    <View style={styles.colorRow}>
      {createElement("input", { type: "color", value: swatch, "aria-label": `${label} picker`, style: { width: 44, height: 44, padding: 0, border: 0, background: "transparent" },
        onChange: (event: { target: { value: string } }) => { setText(event.target.value); apply(event.target.value); } })}
      <View style={styles.flex}><Field label={label} value={text} onChange={setText} onDone={() => apply(text)} invalid={invalid} /></View>
    </View>
    {off ? <Text style={styles.help}>Not one of this page's design-kit colors.</Text> : null}
    <TokenChips prop={prop} element={element} tokens={tokens} onPick={token => { setText(token); apply(token); }} />
  </View>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md, padding: space.side },
  layout: { flex: 1 },
  layoutWide: { flexDirection: "row" },
  previewColumn: { backgroundColor: colors.surface, borderColor: colors.line, borderBottomWidth: 1 },
  previewWide: { flex: 1, borderBottomWidth: 0, borderRightWidth: 1 },
  previewWrap: { flex: 1, overflow: "hidden", alignItems: "flex-start" },
  previewCentered: { alignItems: "center" },
  toolbar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.xs, padding: space.xs, borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.background },
  banner: { ...typography.caption, color: colors.ink, textAlign: "center", paddingVertical: space.xxs, backgroundColor: colors.subtle },
  layers: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingVertical: space.xxs, maxHeight: 320, overflow: "scroll" as never },
  layer: { minHeight: 36, justifyContent: "center", paddingRight: space.xs },
  layerSelected: { backgroundColor: colors.blueSoft },
  layerText: { ...typography.caption, color: colors.ink },
  layerHidden: { color: colors.muted, textDecorationLine: "line-through" },
  finding: { flexDirection: "row", alignItems: "flex-start", gap: space.xs, paddingVertical: space.xxs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  strong: { fontWeight: "600" },
  strongText: { ...typography.caption, color: colors.ink, fontWeight: "600" },
  warning: { ...typography.caption, color: colors.red },
  remove: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.pill },
  token: { minHeight: 32, flexDirection: "row", alignItems: "center", gap: space.xxs, paddingHorizontal: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background, maxWidth: 180 },
  tokenText: { ...typography.meta, color: colors.ink },
  swatch: { width: 14, height: 14, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  panel: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0 },
  panelWide: { flexGrow: 0, flexShrink: 0, flexBasis: 400, width: 400, minHeight: 0 },
  panelHead: { paddingHorizontal: space.side, paddingTop: space.sm, gap: space.xs, borderBottomWidth: 1, borderBottomColor: colors.line, paddingBottom: space.sm },
  panelContent: { padding: space.side, gap: space.md, paddingBottom: space.xl },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  footerRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  footer: { paddingHorizontal: space.side, paddingVertical: space.sm, gap: space.xxs, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.background },
  scopeBar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.xs, paddingHorizontal: space.sm, backgroundColor: colors.blueSoft },
  scopeText: { ...typography.caption, color: colors.blueDark, flexShrink: 1 },
  disabled: { opacity: 0.45 },
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", padding: space.side, backgroundColor: "rgba(17,46,81,0.42)" },
  sheet: { width: "100%", maxWidth: 640, maxHeight: "90%", gap: space.sm, padding: space.side, borderRadius: radius.lg, backgroundColor: colors.background },
  requestBox: { maxHeight: 420, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, backgroundColor: colors.surface },
  requestContent: { padding: space.sm },
  requestText: { ...typography.caption, color: colors.ink },
  sheetActions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.xs },
  section: { gap: space.xs },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, alignItems: "center" },
  heading: { ...typography.heading, color: colors.ink },
  subheading: { ...typography.bodyStrong, color: colors.ink, marginTop: space.sm },
  label: { ...typography.label, color: colors.ink },
  help: { ...typography.caption, color: colors.muted },
  status: { ...typography.caption, color: colors.ink },
  error: { ...typography.caption, color: colors.red },
  field: { gap: space.xxs },
  input: controls.input,
  multiline: controls.inputMultiline,
  inputInvalid: { borderColor: colors.red },
  colorRow: { flexDirection: "row", alignItems: "flex-end", gap: space.xs },
  flex: { flex: 1, minWidth: 0 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  chip: { minHeight: 36, justifyContent: "center", paddingHorizontal: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background },
  chipSelected: { borderColor: colors.blue, backgroundColor: colors.blueSoft },
  chipText: { ...typography.caption, color: colors.ink },
  chipTextSelected: { color: colors.blueDark, fontWeight: "600" },
  pressed: { opacity: 0.75 },
  change: { flexDirection: "row", alignItems: "flex-start", gap: space.xs, paddingVertical: space.xs, borderBottomWidth: 1, borderBottomColor: colors.line },
  changeText: { ...typography.caption, color: colors.ink },
}));
