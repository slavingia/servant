import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Redirect, router, Stack, useFocusEffect } from "expo-router";
import { Button, ButtonGroup } from "../components/Button";
import { ServeLoader } from "../components/ServeLoader";
import { SocialPostCard, SocialReplyEditor } from "../components/SocialPost";
import { ScheduleCalendar, ScheduleList, ScheduleViewToggle } from "../components/SocialSchedule";
import { landingHref, useFeatures } from "../lib/features";
import { useWideLayout } from "../lib/layout";
import type { Account } from "../lib/server";
import { useSession } from "../lib/session";
import { connectionLine, lengthLine, monthRange, undrafted, type SocialFilter, type SocialHome, type SocialPost, type SocialReply, type SocialSource } from "../lib/social";
import { socialApi } from "../lib/social-api";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

export default function SocialScreen() {
  const { account } = useSession();
  const features = useFeatures();
  if (!account) return null;
  if (!features.social) return <Redirect href={landingHref(features)} />;
  return <Social key={`${account.serverUrl}:${account.token}:${account.serverKey}`} account={account} />;
}

type Tab = "reply" | "schedule";
type Show = "all" | "mentions" | "search" | "drafted" | "skipped";
const SHOWS: { id: Show; label: string; filter: SocialFilter; source: SocialSource }[] = [
  { id: "all", label: "All", filter: "open", source: "all" },
  { id: "mentions", label: "Mentions", filter: "open", source: "mentions" },
  { id: "search", label: "Other posts", filter: "open", source: "search" },
  { id: "drafted", label: "Drafted", filter: "drafted", source: "all" },
  { id: "skipped", label: "Skipped", filter: "skipped", source: "all" },
];
const said = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback;
const DAY = 86_400_000;
/** Whether a post still belongs in the list being shown, after something about it changed. */
const belongs = (post: SocialPost, show: Show) => {
  if (show === "skipped") return !!post.skipped;
  if (post.skipped || (post.reply && ["scheduled", "posting", "posted"].includes(post.reply.status))) return false;
  return show !== "drafted" || !!post.reply;
};

// Social media: the posts on X that mention the team's account or match its searches, and what the team says back.
// There are far more posts to answer than posts of the team's own, so the screen opens on the posts to answer:
// Agent drafts a reply from the wiki's guide, someone reads it, and someone who holds Social media approves it.
// The other tab is what is approved and when it goes out, as a list or a calendar; that choice sits at the top
// right of a wide window.
function Social({ account }: { account: Account }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const wide = useWideLayout();
  const [tab, setTab] = useState<Tab>("reply");
  const [show, setShow] = useState<Show>("all");
  const [view, setView] = useState<"list" | "calendar">("list");
  const [home, setHome] = useState<SocialHome | null>(null);
  const [posts, setPosts] = useState<{ show: Show; list: SocialPost[]; hasMore: boolean } | null>(null);
  const [schedule, setSchedule] = useState<SocialReply[] | null>(null);
  const [month, setMonth] = useState(() => { const now = new Date(); return { year: now.getFullYear(), month: now.getMonth() }; });
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [more, setMore] = useState(false);
  // Drafting a screenful: how far along it is.
  const [batch, setBatch] = useState<{ done: number; of: number } | null>(null);
  const [composing, setComposing] = useState(false);
  const stop = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stop.current = true; }; }, []);

  const chosen = SHOWS.find(item => item.id === show)!;
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      // The calendar asks for its month; the list for the last week and everything ahead.
      const range = view === "calendar" ? monthRange(month.year, month.month) : { from: new Date().setHours(0, 0, 0, 0) - 7 * DAY, to: Date.now() + 367 * DAY };
      const [nextHome, list, plan] = await Promise.all([
        socialApi.home(account, signal),
        tab === "reply" ? socialApi.posts(account, { filter: chosen.filter, source: chosen.source }, signal) : null,
        tab === "schedule" ? socialApi.schedule(account, range, signal) : null,
      ]);
      if (signal?.aborted || !mounted.current) return;
      setHome(nextHome); setError("");
      // A refresh keeps the posts already loaded past the first page, with what the server now says about each.
      if (list) setPosts(current => {
        if (current?.show !== show) return { show, list: list.posts, hasMore: list.hasMore };
        const fresh = new Map(list.posts.map(post => [post.id, post]));
        const older = current.list.filter(post => !fresh.has(post.id) && list.posts.length > 0 && post.postedAt < list.posts[list.posts.length - 1]!.postedAt);
        return { show, list: [...list.posts, ...older], hasMore: older.length ? current.hasMore : list.hasMore };
      });
      if (plan) setSchedule(plan.replies);
    } catch (reason) {
      if (!signal?.aborted && mounted.current) setError(said(reason, "Couldn't load Social. Try again."));
    }
  }, [account, chosen.filter, chosen.source, month, show, tab, view]);
  // New posts arrive and replies go out while this is open.
  useFocusEffect(useCallback(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => { if (AppState.currentState === "active" && !(Platform.OS === "web" && document.hidden) && !stop.current) void load(controller.signal); }, 20_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [load]));

  const changed = useCallback((next: SocialPost) => {
    setPosts(current => current && { ...current, list: belongs(next, current.show) ? current.list.map(post => post.id === next.id ? next : post) : current.list.filter(post => post.id !== next.id) });
    void socialApi.home(account).then(value => { if (mounted.current) setHome(value); }).catch(() => {});
  }, [account]);
  const check = async () => {
    if (checking) return;
    setChecking(true); setError("");
    try { await socialApi.sync(account); await load(); } catch (reason) { if (mounted.current) setError(said(reason, "Couldn't check X. Try again.")); } finally { if (mounted.current) setChecking(false); }
  };
  const loadMore = async () => {
    const last = posts?.list[posts.list.length - 1];
    if (!last || more) return;
    setMore(true);
    try {
      const next = await socialApi.posts(account, { filter: chosen.filter, source: chosen.source, before: last.id });
      if (mounted.current) setPosts(current => current?.show === show ? { show, list: [...current.list, ...next.posts.filter(post => !current.list.some(have => have.id === post.id))], hasMore: next.hasMore } : current);
    } catch (reason) { if (mounted.current) setError(said(reason, "Couldn't load more posts. Try again.")); } finally { if (mounted.current) setMore(false); }
  };
  // Ask Agent for a draft for each post on screen that has none, one after another, so a screenful is ready to read.
  const waiting = posts?.show === show ? undrafted(posts.list) : [];
  const draftAll = async () => {
    if (batch || !waiting.length) return;
    stop.current = false; setError("");
    for (let i = 0; i < waiting.length; i++) {
      if (stop.current || !mounted.current) break;
      setBatch({ done: i, of: waiting.length });
      try { changed((await socialApi.draft(account, waiting[i]!.id)).post); }
      catch (reason) { if (mounted.current) setError(said(reason, "Agent couldn't draft a reply. Try again.")); break; }
    }
    if (mounted.current) setBatch(null);
  };

  const list = posts?.show === show ? posts.list : null;
  const tabs = <View accessibilityRole="tablist" accessibilityLabel="Social" style={styles.tabs}>
    {([["reply", "To reply", home?.counts.open], ["schedule", "Scheduled", home?.counts.scheduled]] as const).map(([id, label, count]) =>
      <Pressable key={id} testID={`social-tab-${id}`} accessibilityRole="tab" accessibilityLabel={count ? `${label}, ${count}` : label} accessibilityState={{ selected: tab === id }} aria-selected={tab === id} onPress={() => setTab(id)} style={[styles.tab, tab === id && styles.tabOn]}>
        <Text style={[styles.tabText, tab === id && styles.tabTextOn]}>{count ? `${label} · ${count}` : label}</Text>
      </Pressable>)}
  </View>;
  const toggle = <ScheduleViewToggle view={view} onChange={setView} />;
  return <ScrollView testID="social" style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    {/* List or Calendar sits at the top right of a wide window, in the screen's own bar. */}
    <Stack.Screen options={{ headerRight: tab === "schedule" && wide ? () => <View style={styles.headerRight}>{toggle}</View> : undefined }} />
    <View style={styles.top}>
      {tabs}
      {tab === "schedule" && !wide ? toggle : null}
    </View>
    {home ? <View style={styles.status}>
      <Text testID="social-connection" style={[styles.caption, !!home.error && styles.problem]}>{connectionLine(home)}</Text>
      <ButtonGroup>
        <Button testID="social-check" label="Check now" kind="link" compact busy={checking} onPress={() => void check()} />
        <Button testID="social-guide" label="Guide" accessibilityLabel="Open the social media guide in the wiki" kind="link" compact onPress={() => router.push({ pathname: "/wiki", params: { page: home.guidePageId } })} />
      </ButtonGroup>
    </View> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}

    {tab === "reply" ? <>
      <View accessibilityRole="radiogroup" accessibilityLabel="Posts to show" style={styles.chips}>
        {SHOWS.map(item => <Pressable key={item.id} testID={`social-show-${item.id}`} accessibilityRole="radio" accessibilityLabel={item.label} accessibilityState={{ checked: show === item.id }} aria-checked={show === item.id} onPress={() => setShow(item.id)} style={[styles.chip, show === item.id && styles.chipOn]}>
          <Text style={[styles.chipText, show === item.id && styles.chipTextOn]}>{item.label}</Text>
        </Pressable>)}
      </View>
      {show !== "skipped" && show !== "drafted" && (waiting.length || batch) ? <View style={styles.batch}>
        {batch
          ? <><Text testID="social-batch" style={styles.caption}>{`Agent is drafting reply ${batch.done + 1} of ${batch.of}.`}</Text><Button label="Stop" kind="danger" compact onPress={() => { stop.current = true; }} /></>
          : <Button testID="social-draft-all" label={`Draft replies to ${waiting.length === 1 ? "1 post" : `these ${waiting.length} posts`}`} kind="secondary" compact onPress={() => void draftAll()} />}
      </View> : null}
      {!list && !error ? <ServeLoader accessibilityLabel="Loading posts" style={styles.loading} /> : null}
      {list && !list.length ? <Text testID="social-empty" style={styles.empty}>{show === "skipped" ? "No skipped posts." : show === "drafted" ? "No drafts are waiting for approval." : "You're all caught up. New posts appear here as they arrive."}</Text> : null}
      {home && list ? list.map(post => <SocialPostCard key={post.id} account={account} post={post} canApprove={home.canApprove} limit={home.limit} onChange={changed} />) : null}
      {list && posts?.hasMore ? <Button label="Load more posts" kind="secondary" busy={more} onPress={() => void loadMore()} style={styles.more} /> : null}
    </> : <>
      {/* The team's own posts are the rare case: one button, and their drafts above the schedule. */}
      <View style={styles.batch}><Button testID="social-new-post" label="New post" kind="secondary" compact onPress={() => setComposing(true)} /></View>
      {composing && home ? <Compose account={account} limit={home.limit} onDone={() => { setComposing(false); void load(); }} /> : null}
      {home?.ownDrafts.length ? <View testID="social-own-drafts" style={styles.own}>
        <Text accessibilityRole="header" style={styles.section}>Posts waiting for approval</Text>
        {home.ownDrafts.map(reply => <View key={reply.id} style={styles.ownDraft}><SocialReplyEditor account={account} reply={reply} canApprove={home.canApprove} limit={home.limit} onReply={() => void load()} /></View>)}
      </View> : null}
      {!schedule && !error ? <ServeLoader accessibilityLabel="Loading the schedule" style={styles.loading} /> : null}
      {schedule && home ? view === "list"
        ? <ScheduleList account={account} replies={schedule} canApprove={home.canApprove} onChanged={() => void load()} />
        : <ScheduleCalendar account={account} replies={schedule} year={month.year} month={month.month} wide={wide} canApprove={home.canApprove} onMonth={setMonth} onChanged={() => void load()} /> : null}
    </>}
    <Text style={styles.foot}>{home ? `Approved replies go out at least ${home.spacingMinutes === 1 ? "1 minute" : `${home.spacingMinutes} minutes`} apart.${home.searches.length ? ` Searching X for: ${home.searches.join(", ")}.` : ""}` : ""}</Text>
    <View style={{ height: space.xxl, backgroundColor: colors.background }} />
  </ScrollView>;
}

// A post of the team's own: say what it should say and Agent writes it from the guide, or write it as it should go out.
function Compose({ account, limit, onDone }: { account: Account; limit: number; onDone: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"agent" | "own" | null>(null);
  const [error, setError] = useState("");
  const count = lengthLine(text, limit);
  const go = async (how: "agent" | "own") => {
    if (busy || !text.trim()) return;
    setBusy(how); setError("");
    try { await socialApi.compose(account, how === "agent" ? { note: text.trim() } : { text: text.trim() }); onDone(); }
    catch (reason) { setError(said(reason, "Couldn't save the post. Try again.")); setBusy(null); }
  };
  return <View testID="social-compose" style={styles.compose}>
    <TextInput testID="social-compose-text" accessibilityLabel="What the post should say" placeholder="What should the post say?" placeholderTextColor={colors.muted} value={text} onChangeText={setText} multiline autoFocus editable={!busy} style={styles.composeInput} />
    <Text style={styles.caption}>{`${count.text} if saved as written`}</Text>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <ButtonGroup>
      <Button testID="social-compose-agent" label="Ask Agent to write it" compact busy={busy === "agent"} disabled={!text.trim() || !!busy} onPress={() => void go("agent")} />
      <Button testID="social-compose-own" label="Save as written" kind="secondary" compact busy={busy === "own"} disabled={!text.trim() || count.over || !!busy} onPress={() => void go("own")} />
      <Button label="Cancel" kind="link" compact disabled={!!busy} onPress={onDone} />
    </ButtonGroup>
  </View>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: space.side, paddingTop: space.md, width: "100%", maxWidth: 960, alignSelf: "center", gap: space.xs },
  top: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.xs },
  headerRight: { paddingRight: space.md },
  // The same segmented tabs as Cases and Saved.
  tabs: { flexDirection: "row", backgroundColor: colors.surface, borderRadius: radius.pill, padding: space.xxs, width: "100%", maxWidth: 400 },
  tab: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, paddingHorizontal: space.xs },
  tabOn: { backgroundColor: colors.background, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  tabText: { ...typography.captionStrong, color: colors.muted },
  tabTextOn: { color: colors.ink },
  status: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: space.sm },
  caption: { ...typography.caption, color: colors.muted, flexShrink: 1 },
  problem: { color: colors.red },
  error: { ...typography.caption, color: colors.red },
  // The same chips as To-dos and Cases.
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  chip: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.sm, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background },
  chipOn: { backgroundColor: colors.blueSoft, borderColor: colors.blue },
  chipText: { ...typography.label, color: colors.ink },
  chipTextOn: { color: colors.blueDark },
  batch: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
  loading: { paddingVertical: space.xl },
  empty: { ...typography.body, color: colors.muted, paddingVertical: space.xl, textAlign: "center" },
  more: { marginTop: space.md },
  own: { gap: space.xs, marginTop: space.xs },
  ownDraft: { paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  section: { ...typography.label, color: colors.muted },
  compose: { gap: space.xs, padding: space.sm, borderRadius: radius.md, backgroundColor: colors.surface },
  composeInput: { ...controls.input, ...controls.inputMultiline, minHeight: 88 },
  foot: { ...typography.meta, color: colors.muted, marginTop: space.lg },
}));
