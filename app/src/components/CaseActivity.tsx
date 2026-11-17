import { useCallback, useRef, useState } from "react";
import { AppState, FlatList, Platform, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { inboxCursor, mergeInboxMessages, pollInbox, type InboxActivity, type InboxClient } from "../lib/secure-inbox";
import { createThemedStyles, space, typography } from "../lib/theme";
import { ServeLoader } from "./ServeLoader";

export function CaseActivity({ client, id, active }: { client: InboxClient; id: string; active: boolean }) {
  const styles = useStyles();
  const [activity, setActivity] = useState<InboxActivity[] | null>(null);
  const history = useRef<InboxActivity[]>([]);
  const [error, setError] = useState("");
  useFocusEffect(useCallback(() => {
    if (!active) return;
    return pollInbox(async signal => {
      if ((AppState.currentState && AppState.currentState !== "active") || (Platform.OS === "web" && document.hidden)) return;
      let more = false;
      do {
        const after = inboxCursor(history.current);
        const page = await client.activity(id, after, signal);
        if (signal.aborted) return;
        history.current = mergeInboxMessages(history.current, page.activity);
        if (page.hasMore && inboxCursor(history.current) <= after) throw new Error("Couldn't load the next activity. Try again.");
        more = page.hasMore;
      } while (more);
      setActivity([...history.current].reverse()); setError("");
    }, cause => setError(cause instanceof Error ? cause.message : "Couldn't load the case activity. Try again."));
  }, [client, id, active]));
  return <View style={[styles.root, !active && styles.hidden]} accessibilityElementsHidden={!active} importantForAccessibility={active ? "auto" : "no-hide-descendants"}>
    <FlatList data={activity ?? []} keyExtractor={item => item.id} contentContainerStyle={styles.content}
      ListHeaderComponent={<View style={styles.header}><Text accessibilityRole="header" style={styles.title}>Activity</Text><Text style={styles.caption}>A lasting record of this case. Only your team sees it.</Text>{error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}</View>}
      ListEmptyComponent={!error && activity === null ? <ServeLoader accessibilityLabel="Loading case activity" /> : undefined}
      renderItem={({ item }) => <View style={styles.event}><Text style={styles.eventText}>{item.text}</Text><Text style={styles.caption}>{item.actorName} · {new Date(item.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</Text></View>} />
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, minHeight: 0 }, hidden: { display: "none" }, content: { padding: space.side, paddingBottom: space.xxl }, header: { gap: space.xs, marginBottom: space.md }, title: { ...typography.heading, color: colors.ink }, caption: { ...typography.caption, color: colors.muted }, event: { paddingVertical: space.sm, gap: space.xxs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line }, eventText: { ...typography.body, color: colors.ink }, error: { ...typography.caption, color: colors.red },
}));
