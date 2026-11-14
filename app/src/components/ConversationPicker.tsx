import { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLiveList } from "../lib/live";
import { useSession } from "../lib/session";
import { type Conversation } from "../lib/server";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { AppIcon } from "./AppIcon";
import { IconButton } from "./Button";
import { Avatar, dmPeer } from "./Messaging";

/** Pick a channel or direct message, most recent first. One tap picks it. */
export function ConversationPicker({ title, hint, busyId, error, onPick, onClose }: { title: string; hint?: string; busyId?: string | null; error?: string | null; onPick: (c: Conversation) => void; onClose: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { account } = useSession();
  const { conversations } = useLiveList();
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (conversations ?? []).filter(c => !c.archived && !c.agentDm).sort((a, b) => b.updatedAt - a.updatedAt).filter(c => !q || label(c).toLowerCase().includes(q));
  }, [conversations, query]);

  return <Modal transparent animationType="fade" visible onRequestClose={onClose}>
    <View style={[styles.overlay, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}>
      <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="Cancel" onPress={onClose} />
      <View accessibilityViewIsModal testID="conversation-picker" style={styles.card}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>{title}</Text>
          <IconButton icon="close" label="Cancel" edge="end" onPress={onClose} />
        </View>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        <TextInput value={query} onChangeText={setQuery} placeholder="Search channels and people" placeholderTextColor={colors.muted}
          accessibilityLabel="Search channels and people" autoCorrect={false} style={styles.search} />
        <FlatList
          data={shown}
          keyExtractor={c => c.id}
          keyboardShouldPersistTaps="handled"
          style={styles.list}
          ListEmptyComponent={<Text style={styles.empty}>{query ? "No matches" : "No conversations"}</Text>}
          renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={label(item)} accessibilityState={{ busy: busyId === item.id }} disabled={!!busyId} onPress={() => onPick(item)}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}>
            <View style={styles.rowIcon}>
              {item.kind === "dm" ? <Avatar name={item.title} userId={dmPeer(item, account?.user.id)} size={24} /> : <AppIcon name={item.private ? "lock" : "hash"} size={16} color={colors.muted} />}
            </View>
            <Text style={styles.rowText}>{item.kind === "channel" ? item.name ?? item.title : item.title}</Text>
            {busyId === item.id ? <Text style={styles.meta}>Starting…</Text> : <AppIcon name="chevronRight" size={14} color={colors.muted} />}
          </Pressable>}
        />
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      </View>
    </View>
  </Modal>;
}

const label = (c: Conversation) => c.kind === "channel" ? `#${c.name ?? c.title}` : c.title;

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  overlay: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: space.side, backgroundColor: colors.scrim },
  card: { width: "100%", maxWidth: 420, maxHeight: "100%", backgroundColor: colors.background, borderRadius: radius.lg, padding: space.side, gap: space.sm },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginVertical: -space.xs },
  title: { ...typography.bodyStrong, color: colors.ink },
  hint: { ...typography.caption, color: colors.muted },
  search: controls.input,
  list: { maxHeight: 320, flexGrow: 0 },
  row: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xs, borderRadius: radius.sm },
  rowIcon: { width: 28, alignItems: "center" },
  rowText: { ...typography.body, color: colors.ink, flex: 1 },
  meta: { ...typography.meta, color: colors.muted },
  empty: { ...typography.caption, color: colors.muted, textAlign: "center", paddingVertical: space.lg },
  error: { ...typography.caption, color: colors.red },
}));
