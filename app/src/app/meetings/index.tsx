import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, AppState, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { BallRefreshControl } from "../../components/BallRefreshControl";
import { Redirect, router, useFocusEffect } from "expo-router";
import { AppIcon } from "../../components/AppIcon";
import { Button } from "../../components/Button";
import { ConversationPicker } from "../../components/ConversationPicker";
import { MeetingRecorder } from "../../components/MeetingRecorder";
import { useActiveCall } from "../../lib/active-call";
import { useLiveList } from "../../lib/live";
import { callErrorText, callsSupported } from "../../lib/meeting-call";
import { anyBusy, durationText, meetingBusy, peopleText, statusLabel } from "../../lib/meetings";
import { refreshMeetings, useMeetings } from "../../lib/meetings-store";
import { api, type Conversation, type MeetingItem } from "../../lib/server";
import { useSession } from "../../lib/session";
import { landingHref, useFeatures } from "../../lib/features";
import { shortTime } from "../../lib/time-label";
import { radius, space, typography, useTheme, createThemedStyles } from "../../lib/theme";
import { ServeLoader } from "../../components/ServeLoader";

// Meetings: calls made in Servant and meetings recorded from here, in one list. Start a call in a
// channel or DM, or record a meeting that happens somewhere else (in the room, or on Zoom, Meet or
// Teams on this computer). Either way the notes and next steps end up here.
export default function Meetings() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account, setAccount } = useSession();
  const { list, error } = useMeetings();
  const active = useActiveCall();
  const { conversations } = useLiveList();
  const [refreshing, setRefreshing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [picking, setPicking] = useState(false);
  const [startingIn, setStartingIn] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [canCall] = useState(() => callsSupported());
  const features = useFeatures();

  const load = useCallback(() => account ? refreshMeetings(account, setAccount) : Promise.resolve(), [account, setAccount]);
  // Notes take a minute to write: look again while any meeting is live or being written up.
  const busy = !!list && anyBusy(list);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => { if (AppState.currentState === "active") void load(); }, 5000);
    return () => clearInterval(timer);
  }, [busy, load]);

  if (!account) return null;
  // A server without meetings: a stale link here goes where the app lands.
  if (!features.meetings) return <Redirect href={landingHref(features)} />;
  // A call's name is its room until the notes give it a real title ("Meeting" is what the agent writes when nothing was said).
  const roomOf = (m: MeetingItem) => { const c = conversations?.find(x => x.id === m.conversationId); return c ? (c.kind === "channel" ? `#${c.name ?? c.title}` : c.title) : null; };
  const generic = (m: MeetingItem) => !m.title || m.title === "Meeting";
  const nameOf = (m: MeetingItem) => !generic(m) ? m.title : m.kind === "call" ? (roomOf(m) ? `Call in ${roomOf(m)}` : "Call") : "Recorded meeting";
  const onCall = !!active && !["ended", "failed"].includes(active.state.status);
  const open = (m: MeetingItem) => router.push({ pathname: "/meetings/[id]", params: { id: m.id, kind: m.kind } });
  const join = (m: MeetingItem) => router.push({ pathname: "/meeting/[id]", params: { id: m.id } });
  // Fewest taps: pick the room, and you're in the call (the server joins the one already running).
  const startIn = async (c: Conversation) => {
    if (startingIn) return;
    setStartingIn(c.id); setStartError(null);
    try {
      const meeting = await api.startMeeting(account, c.id);
      setPicking(false);
      router.push({ pathname: "/meeting/[id]", params: { id: meeting.id } });
    } catch (e) { setStartError(callErrorText(e, "start")); }
    finally { setStartingIn(null); }
  };

  const header = <View style={styles.header}>
    <View style={styles.actions}>
      {canCall ? <Button label={onCall ? "Return to call" : "Start a meeting"} disabled={recording} onPress={() => onCall && active ? router.push({ pathname: "/meeting/[id]", params: { id: active.id } }) : setPicking(true)} style={styles.action} /> : null}
      <Button label="Record a meeting" kind={canCall ? "secondary" : "primary"} disabled={recording} onPress={() => setRecording(true)} style={styles.action} />
    </View>
    {!canCall ? <Text style={styles.hint}>For calls, use the app, Chrome, Safari or Edge.</Text> : null}
    {recording ? <MeetingRecorder account={account} onMove={setAccount} onSaved={() => void load()} onClose={() => setRecording(false)} /> : null}
    {error && list ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;

  return <View style={styles.root}>
    <FlatList
      data={list ?? []}
      keyExtractor={m => `${m.kind}:${m.id}`}
      contentContainerStyle={styles.content}
      refreshControl={<BallRefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
      ListHeaderComponent={header}
      ListEmptyComponent={list === null
        ? (error ? <View style={styles.empty}><Text accessibilityRole="alert" style={styles.emptyBody}>{error}</Text><Button label="Try again" kind="secondary" onPress={() => void load()} /></View> : <ServeLoader style={{ marginTop: space.xl }} />)
        : <View style={styles.empty}>
            <Text accessibilityRole="header" style={styles.emptyTitle}>No meetings yet</Text>
          </View>}
      renderItem={({ item }) => {
        const live = item.status === "live";
        const who = peopleText(item.people, account.user.id);
        const meta = [shortTime(item.startedAt), durationText(item.durationMs), generic(item) ? null : roomOf(item), who].filter(Boolean).join(" · ");
        return <Pressable accessibilityRole="button" accessibilityLabel={`${nameOf(item)}. ${statusLabel(item)}. ${meta}`} onPress={() => open(item)} style={({ pressed }) => [styles.item, pressed && { backgroundColor: colors.surface }]}>
          <View style={[styles.mark, live && styles.markLive]}><AppIcon name={item.kind === "call" ? "meetings" : "mic"} size={18} color={live ? colors.greenDark : colors.muted} /></View>
          <View style={styles.grow}>
            <Text style={styles.itemTitle}>{nameOf(item)}</Text>
            <Text style={styles.itemMeta}>{meta}</Text>
            <Text style={[styles.itemStatus, live && styles.itemStatusLive]}>{statusLabel(item)}</Text>
          </View>
          {live && canCall ? <Button label={onCall && active?.id === item.id ? "Return" : "Join"} compact onPress={() => join(item)} />
            : meetingBusy(item) ? <ActivityIndicator color={colors.blue} /> : <AppIcon name="chevronRight" size={16} color={colors.muted} />}
        </Pressable>;
      }}
    />
    {picking ? <ConversationPicker title="Meeting conversation" hint="Members can join. Calls are recorded for notes." busyId={startingIn} error={startError} onPick={c => void startIn(c)} onClose={() => { setPicking(false); setStartError(null); }} /> : null}
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: space.xxl, width: "100%", maxWidth: 760, alignSelf: "center" },
  header: { padding: space.side, gap: space.sm },
  actions: { flexDirection: "row", gap: space.sm, flexWrap: "wrap" },
  action: { flexGrow: 1, flexBasis: 200 },
  hint: { ...typography.caption, color: colors.muted },
  error: { ...typography.caption, color: colors.red, backgroundColor: colors.redSoft, padding: space.sm, borderRadius: radius.sm },
  empty: { alignItems: "center", gap: space.sm, paddingHorizontal: space.xl, paddingVertical: space.xl },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center" },
  emptyBody: { ...typography.body, color: colors.muted, textAlign: "center" },
  item: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.side, paddingVertical: space.sm, minHeight: 72, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  mark: { width: 36, height: 36, borderRadius: radius.pill, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  markLive: { backgroundColor: colors.greenSoft },
  grow: { flex: 1, minWidth: 0 },
  itemTitle: { ...typography.bodyStrong, color: colors.ink },
  itemMeta: { ...typography.caption, color: colors.muted, marginTop: 2 },
  itemStatus: { ...typography.caption, color: colors.muted, marginTop: 2 },
  itemStatusLive: { ...typography.captionStrong, color: colors.green },
}));
