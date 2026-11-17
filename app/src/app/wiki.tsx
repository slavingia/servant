import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { AppIcon } from "../components/AppIcon";
import { Button, IconButton } from "../components/Button";
import { WikiAbbreviations } from "../components/WikiAbbreviations";
import { WikiPage } from "../components/WikiPage";
import { useWideLayout } from "../lib/layout";
import type { Account } from "../lib/server";
import { useSession } from "../lib/session";
import { createThemedStyles, space, typography, useTheme } from "../lib/theme";
import { ABBREVIATIONS_PAGE, ABBREVIATIONS_TITLE, UNTITLED, WIKI_MAX_DEPTH, wikiAncestors, wikiDepth, wikiLanding, wikiOpened, wikiRows, type WikiPageSummary, type WikiRow } from "../lib/wiki";
import { wikiApi } from "../lib/wiki-api";
import { ServeLoader } from "../components/ServeLoader";

export default function WikiScreen() {
  const { account } = useSession();
  return account ? <Wiki key={`${account.serverUrl}:${account.serverKey}:${account.user.id}:${account.token}`} account={account} /> : null;
}

// The team's wiki: a tree of pages on the left and the open page beside it. Pages are added, and subpages put
// under them, from the tree; the page itself is for reading and for asking Agent to change it. On a phone there is room for one of
// the two, so the tree is the screen and a page opens over it.
function Wiki({ account }: { account: Account }) {
  const styles = useStyles();
  const wide = useWideLayout();
  const params = useLocalSearchParams<{ page?: string }>();
  const [pages, setPages] = useState<WikiPageSummary[] | null>(null);
  const [error, setError] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = useState(false);
  // The page that was just made, so it opens ready to be written.
  const [fresh, setFresh] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); }; }, []);

  const load = useCallback(async () => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    try {
      const next = await wikiApi.list(account, controller.signal);
      if (mounted.current && !controller.signal.aborted) { setPages(next.pages); setError(""); }
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Couldn't load the wiki. Try again.");
    }
  }, [account]);
  useFocusEffect(useCallback(() => { void load(); return () => pending.current?.abort(); }, [load]));

  const chosen = typeof params.page === "string" && params.page ? params.page : null;
  // A wide window always has a page beside the tree; a phone shows the tree until one is chosen.
  const open = chosen ?? (wide && pages ? wikiLanding(pages) : null);
  const rows = useMemo(() => wikiRows(pages ?? [], closed), [pages, closed]);
  const show = useCallback((id: string | null) => {
    if (id === null) { if (router.canGoBack() && !wide) router.back(); else router.setParams({ page: undefined }); return; }
    // Opening a page opens the branches that would hide it in the tree.
    if (pages) setClosed(current => wikiOpened(pages, id, current));
    // On a phone the page is a step forward, so Back returns to the tree; beside the tree it replaces what is open.
    if (wide || chosen) router.setParams({ page: id }); else router.push({ pathname: "/wiki", params: { page: id } });
  }, [chosen, pages, wide]);

  const create = async (parentId: string | null) => {
    if (creating) return;
    setCreating(true); setError("");
    try {
      const page = await wikiApi.create(account, { title: UNTITLED, parentId });
      if (!mounted.current) return;
      setPages(current => [...(current ?? []), page]);
      if (parentId) setClosed(current => { const next = new Set(current); next.delete(parentId); return next; });
      setFresh(page.id); show(page.id);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "Couldn't add a page. Try again.");
    } finally { if (mounted.current) setCreating(false); }
  };
  const toggle = (id: string) => setClosed(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const tree = <ScrollView testID="wiki-tree" style={wide ? styles.treeWide : styles.treeNarrow} contentContainerStyle={styles.treeContent} keyboardShouldPersistTaps="handled">
    <View style={styles.treeHead}>
      <Button testID="wiki-new-page" label="New page" compact busy={creating} onPress={() => void create(null)} />
    </View>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {!pages && !error ? <ServeLoader accessibilityLabel="Loading the wiki" style={styles.loading} /> : null}
    {rows.map(row => <TreeRow key={row.id} row={row} current={row.id === open} canAdd={!row.special && !!pages && wikiDepth(pages, row.id) < WIKI_MAX_DEPTH}
      onOpen={() => show(row.id)} onToggle={() => toggle(row.id)} onAdd={() => void create(row.id)} />)}
    {pages && !pages.length ? <Text style={styles.hint}>No pages yet. Choose New page to write the first one.</Text> : null}
  </ScrollView>;

  if (!open) return <View style={styles.root}>{tree}</View>;

  const path = pages && open !== ABBREVIATIONS_PAGE ? wikiAncestors(pages, open) : [];
  const header = <View style={styles.crumbs}>
    {!wide ? <Button label="All pages" kind="link" compact onPress={() => show(null)} /> : null}
    {path.length ? <Text testID="wiki-crumbs" style={styles.crumb}>{path.map(page => page.title).join(" / ")}</Text> : null}
  </View>;
  const pane = open === ABBREVIATIONS_PAGE
    ? <WikiAbbreviations account={account} header={<>{header}<Text accessibilityRole="header" style={styles.title}>{ABBREVIATIONS_TITLE}</Text></>} />
    : <WikiPage key={open} account={account} id={open} header={header} fresh={fresh === open}
        onSaved={() => { setFresh(null); void load(); }}
        onDeleted={page => { setPages(current => current?.filter(item => item.id !== page.id) ?? null); if (wide) router.setParams({ page: page.parentId ?? undefined }); else show(null); void load(); }} />;
  return <View style={[styles.root, wide && styles.split]}>
    {wide ? tree : null}
    <View style={styles.pane}>{pane}</View>
  </View>;
}

function TreeRow({ row, current, canAdd, onOpen, onToggle, onAdd }: { row: WikiRow; current: boolean; canAdd: boolean; onOpen: () => void; onToggle: () => void; onAdd: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return <View testID={`wiki-row-${row.id}`} style={[styles.row, current && styles.rowCurrent, { paddingLeft: space.xs + row.depth * space.md }]}>
    {row.hasChildren
      ? <Pressable accessibilityRole="button" accessibilityLabel={`${row.open ? "Hide" : "Show"} the pages under ${row.title}`} accessibilityState={{ expanded: row.open }} aria-expanded={row.open}
          onPress={onToggle} style={({ pressed }) => [styles.disclosure, pressed && styles.pressed]}>
          <AppIcon name={row.open ? "chevronDown" : "chevronRight"} size={16} color={colors.muted} />
        </Pressable>
      : <View style={styles.disclosure}>{row.special ? <AppIcon name="code" size={16} color={colors.muted} /> : null}</View>}
    <Pressable accessibilityRole="link" accessibilityLabel={row.title} aria-current={current ? "page" : undefined} onPress={onOpen} style={({ pressed }) => [styles.rowMain, pressed && styles.pressed]}>
      <Text style={[styles.rowTitle, current && styles.rowTitleCurrent]}>{row.title}</Text>
    </Pressable>
    {canAdd ? <IconButton icon="plus" label={`Add a page under ${row.title}`} onPress={onAdd} /> : null}
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  split: { flexDirection: "row" },
  pane: { flex: 1, minWidth: 0 },
  treeWide: { flexGrow: 0, flexShrink: 0, flexBasis: "32%", maxWidth: 320, minWidth: 220, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.line, backgroundColor: colors.background },
  treeNarrow: { flex: 1 },
  treeContent: { paddingVertical: space.sm, paddingHorizontal: space.xs },
  treeHead: { flexDirection: "row", paddingHorizontal: space.xs, paddingBottom: space.sm },
  row: { flexDirection: "row", alignItems: "center", minHeight: 44, borderRadius: space.xs },
  rowCurrent: { backgroundColor: colors.blueSoft },
  disclosure: { width: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  rowMain: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: "center", paddingVertical: space.xs },
  rowTitle: { ...typography.body, color: colors.ink },
  rowTitleCurrent: { ...typography.bodyStrong, color: colors.ink },
  pressed: { opacity: 0.6 },
  hint: { ...typography.body, color: colors.muted, padding: space.sm },
  error: { ...typography.body, color: colors.red, padding: space.sm },
  loading: { paddingVertical: space.lg },
  crumbs: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.sm },
  crumb: { ...typography.caption, color: colors.muted },
  title: { ...typography.title, color: colors.ink, marginBottom: space.xs },
}));
