import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, AppState, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { BallRefreshControl } from "../../components/BallRefreshControl";
import { router, useFocusEffect } from "expo-router";
import { AppIcon } from "../../components/AppIcon";
import { Button } from "../../components/Button";
import { VoiceRecorder } from "../../components/VoiceRecorder";
import { anyBusy, durationText, recordingBusy, statusLabel } from "../../lib/recording-labels";
import { refreshRecordings, useRecordings } from "../../lib/recordings-store";
import type { RecordingSummary } from "../../lib/server";
import { useSession } from "../../lib/session";
import { shortTime } from "../../lib/time-label";
import { space, typography, useTheme, createThemedStyles, radius } from "../../lib/theme";
import { ServeLoader } from "../../components/ServeLoader";

// Notetaker (voice memos): record, stop, and get notes and next steps. The audio stays private to the person who made it.
export default function Recordings() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account, setAccount } = useSession();
  const { list, error } = useRecordings();
  const [refreshing, setRefreshing] = useState(false);
  const [recording, setRecording] = useState(false);

  const load = useCallback(() => account ? refreshRecordings(account, setAccount) : Promise.resolve(), [account, setAccount]);
  const busy = !!list && anyBusy(list);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => { if (AppState.currentState === "active") void load(); }, 5000);
    return () => clearInterval(timer);
  }, [busy, load]);

  if (!account) return null;
  const titleOf = (r: RecordingSummary) => r.title && r.title !== "Meeting" ? r.title : "Voice memo";
  const open = (r: RecordingSummary) => router.push({ pathname: "/recordings/[id]", params: { id: r.id } });
  const header = <View style={styles.header}>
    {recording ? <VoiceRecorder account={account} onMove={setAccount} onSaved={() => void load()} onClose={() => setRecording(false)} />
      : <Button label="Take notes" onPress={() => setRecording(true)} />}
    {error && list ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;

  return <View style={styles.root}>
    <FlatList
      data={list ?? []}
      keyExtractor={r => r.id}
      contentContainerStyle={styles.content}
      refreshControl={<BallRefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
      ListHeaderComponent={header}
      ListEmptyComponent={list === null
        ? (error ? <View style={styles.empty}><Text accessibilityRole="alert" style={styles.emptyBody}>{error}</Text><Button label="Try again" kind="secondary" onPress={() => void load()} /></View> : <ServeLoader style={{ marginTop: space.xl }} />)
        : <View style={styles.empty}><Text accessibilityRole="header" style={styles.emptyTitle}>No notes yet</Text></View>}
      renderItem={({ item }) => {
        const meta = [shortTime(item.createdAt), durationText(item.durationMs)].filter(Boolean).join(" · ");
        return <Pressable accessibilityRole="button" accessibilityLabel={`${titleOf(item)}. ${statusLabel(item)}. ${meta}`} onPress={() => open(item)} style={({ pressed }) => [styles.item, pressed && { backgroundColor: colors.surface }]}>
          <View style={styles.mark}><AppIcon name="mic" size={18} color={colors.muted} /></View>
          <View style={styles.grow}>
            <Text style={styles.itemTitle}>{titleOf(item)}</Text>
            <Text style={styles.itemMeta}>{meta}</Text>
            <Text style={styles.itemStatus}>{statusLabel(item)}</Text>
          </View>
          {recordingBusy(item) ? <ActivityIndicator color={colors.blue} /> : <AppIcon name="chevronRight" size={16} color={colors.muted} />}
        </Pressable>;
      }}
    />
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: space.xxl, width: "100%", maxWidth: 760, alignSelf: "center" },
  header: { padding: space.side, gap: space.sm },
  error: { ...typography.caption, color: colors.red, backgroundColor: colors.redSoft, padding: space.sm, borderRadius: radius.sm },
  empty: { alignItems: "center", gap: space.sm, paddingHorizontal: space.xl, paddingVertical: space.xl },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center" },
  emptyBody: { ...typography.body, color: colors.muted, textAlign: "center" },
  item: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.side, paddingVertical: space.sm, minHeight: 72, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  mark: { width: 36, height: 36, borderRadius: radius.pill, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  grow: { flex: 1, minWidth: 0 },
  itemTitle: { ...typography.bodyStrong, color: colors.ink },
  itemMeta: { ...typography.caption, color: colors.muted, marginTop: 2 },
  itemStatus: { ...typography.caption, color: colors.muted, marginTop: 2 },
}));
