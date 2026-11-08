import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { designTitle } from "../lib/designs";
import { appendToDraft } from "../lib/drafts";
import { prototypePageUrl, prototypeVersionUrl } from "../lib/prototype-adjustments";
import { useProjects } from "../lib/projects-store";
import { api, ServerError, type Chat, type DesignVersion } from "../lib/server";
import { useSession } from "../lib/session";
import { createThemedStyles, radius, space, typography } from "../lib/theme";
import { shortTime as when } from "../lib/time-label";

// react-native-web renders this as a real <iframe> (web and the Mac app only).
const Frame = "iframe" as never as React.ComponentType<Record<string, unknown>>;

/**
 * A design's earlier versions: Servant keeps a copy whenever a reply changed
 * the published page. Look at one, compare it with the latest side by side, and
 * (the author) put it back. Restoring saves the current page as a version first.
 */
export default function Versions() {
  const styles = useStyles();
  const { account } = useSession();
  const projects = useProjects();
  const { chat: chatId } = useLocalSearchParams<{ chat?: string }>();
  const { width } = useWindowDimensions();
  const [chat, setChat] = useState<Chat | null>(null);
  const [versions, setVersions] = useState<DesignVersion[] | null>(null);
  const [canRestore, setCanRestore] = useState(false);
  const [chosen, setChosen] = useState<number | null>(null);
  const [compare, setCompare] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    if (!account || !chatId) return;
    try {
      const [info, list] = await Promise.all([api.chat(account, String(chatId)), api.designVersions(account, String(chatId))]);
      setChat(info);
      setVersions(list.versions);
      setCanRestore(list.canRestore && !info.readOnly);
      setChosen(current => current ?? list.versions[0]?.n ?? null);
      setError(null);
    } catch (e) {
      setVersions(current => current ?? []);
      setError(e instanceof ServerError ? e.message : "Couldn't load this design's versions. Check your connection and try again.");
    }
  }, [account, chatId]);
  useEffect(() => { const timer = setTimeout(() => { void load(); }, 0); return () => clearTimeout(timer); }, [load]);

  if (!account) return null;
  const origin = projects?.prototypeOrigin;
  const selected = versions?.find(v => v.n === chosen) ?? null;
  const latest = versions?.[0] ?? null;
  const pageOf = (v: DesignVersion | null) => v ? prototypeVersionUrl(v.url, origin) : null;
  const web = Platform.OS === "web";
  const side = width >= 900;
  const restore = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.restoreDesignVersion(account, String(chatId), selected.n);
      setVersions(result.versions);
      setChosen(result.restored);
      setCompare(false);
      setConfirming(false);
      // The agent's conversation still remembers the newer page: a note for it waits, unsent, in the design chat.
      const before = versions?.[0]?.n;
      appendToDraft(`chat:${chatId}`, `I restored version ${selected.n} of the page, so it's now version ${result.restored}. Work from the files as they are now.`);
      setNotice(`Version ${selected.n} is the live page again (saved as version ${result.restored}).${before ? ` To go back, restore version ${before}.` : ""} A note for the agent is waiting in your design chat's message box.`);
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't restore this version. Try again.");
    } finally { setBusy(false); }
  };
  const open = (v: DesignVersion | null) => { const page = pageOf(v); if (page) void WebBrowser.openBrowserAsync(page); };
  const frame = (v: DesignVersion | null, label: string) => {
    const page = pageOf(v);
    if (!page) return <View style={styles.framePlaceholder}><Text style={styles.help}>No preview for this version.</Text></View>;
    return <View style={styles.frameBox}>
      <Text style={styles.frameLabel}>{label}</Text>
      <Frame key={page} src={page} title={`${label} of ${chat ? designTitle(chat) : "the design"}`} sandbox="allow-scripts allow-forms"
        style={{ flex: 1, width: "100%", minHeight: 360, border: 0, backgroundColor: "#FFFFFF" }} />
    </View>;
  };
  const label = (v: DesignVersion) => `Version ${v.n}${v.latest ? " · Latest" : ""}`;

  return <View style={styles.root}>
    <Stack.Screen options={{ title: chat ? `Versions of ${designTitle(chat)}` : "Version history" }} />
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.help}>A copy is kept each time the page changes (the last 20).{canRestore ? " Restoring keeps the current page as a version too." : ""}</Text>
      <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {versions === null ? <Text style={styles.help}>Loading versions…</Text>
        : !versions.length ? <Text style={styles.help}>No versions yet. One is kept as soon as the design has a published page.</Text>
        : <View style={[styles.layout, side && styles.layoutSide]}>
          <View accessibilityRole="list" accessibilityLabel="Versions" style={[styles.list, side && styles.listSide]}>
            {versions.map(v => <Pressable key={v.n} accessibilityRole="button" accessibilityState={{ selected: v.n === chosen }}
              accessibilityLabel={`${label(v)}, ${when(v.at)}${v.restoredFrom ? `, restored from version ${v.restoredFrom}` : v.request ? `, after: ${v.request}` : ""}`}
              onPress={() => { setChosen(v.n); setNotice(""); }} style={({ pressed }) => [styles.version, v.n === chosen && styles.versionSelected, pressed && styles.pressed]}>
              <Text style={[styles.versionTitle, v.n === chosen && styles.versionTitleSelected]}>{label(v)}</Text>
              <Text style={styles.meta}>{when(v.at)}{v.restoredFrom ? ` · Restored from version ${v.restoredFrom}` : ""}</Text>
              {v.request && !v.restoredFrom ? <Text style={styles.request} numberOfLines={2}>“{v.request}”</Text> : null}
            </Pressable>)}
          </View>
          <View style={styles.detail}>
            {selected ? <>
              <View style={styles.row}>
                {web && !selected.latest ? <Button label={compare ? "Show this version only" : "Compare with latest"} kind="secondary" compact onPress={() => setCompare(!compare)} /> : null}
                {!web ? <Button label="Open this version" kind="secondary" compact onPress={() => open(selected)} /> : null}
                {canRestore && !selected.latest ? <Button label={`Restore version ${selected.n}`} compact onPress={() => setConfirming(true)} /> : null}
              </View>
              {web ? <View style={[styles.frames, side && compare && styles.framesSide]}>
                {frame(selected, label(selected))}
                {compare && !selected.latest ? frame(latest, latest ? label(latest) : "Latest") : null}
              </View> : null}
            </> : null}
          </View>
        </View>}
      {chat && !prototypePageUrl(chat.previewUrl, origin) && origin ? <Text style={styles.help}>This design's page isn't hosted on this server.</Text> : null}
    </ScrollView>
    <ConfirmDialog visible={confirming && !!selected} title={`Restore version ${selected?.n ?? ""}?`} destructive={false}
      description="It becomes the live page that reviewers see. The current page is kept as a version, so you can switch back." confirmLabel="Restore"
      busy={busy} error={confirming ? error : null} onConfirm={() => { void restore(); }} onCancel={() => setConfirming(false)} />
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.side, gap: space.sm, paddingBottom: space.xxl },
  help: { ...typography.caption, color: colors.muted },
  notice: { ...typography.caption, color: colors.ink, minHeight: 0 },
  error: { ...typography.caption, color: colors.red },
  layout: { gap: space.md },
  layoutSide: { flexDirection: "row", alignItems: "flex-start" },
  list: { gap: 2 },
  listSide: { width: 240 },
  version: { minHeight: 52, justifyContent: "center", paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.md },
  versionSelected: { backgroundColor: colors.blueSoft },
  versionTitle: { ...typography.body, color: colors.ink },
  versionTitleSelected: { color: colors.blueDark, fontWeight: "600" },
  meta: { ...typography.meta, color: colors.muted },
  request: { ...typography.meta, color: colors.ink, marginTop: 2 },
  pressed: { backgroundColor: colors.surface },
  detail: { flex: 1, minWidth: 0, gap: space.sm },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  frames: { gap: space.sm },
  framesSide: { flexDirection: "row" },
  frameBox: { flex: 1, minWidth: 0, minHeight: 400, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, overflow: "hidden" },
  frameLabel: { ...typography.label, color: colors.muted, padding: space.xs, backgroundColor: colors.surface },
  framePlaceholder: { minHeight: 120, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.subtle },
}));
