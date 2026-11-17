import { useEffect, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { api, ServerError, type Conversation } from "../lib/server";
import { useSession } from "../lib/session";
import { useFeatures } from "../lib/features";
import { Button, IconButton } from "./Button";
import { AppIcon } from "./AppIcon";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { ServeLoader } from "./ServeLoader";

export type ForwardTarget = { chatId: string; messageId: string; author: string; text: string; files: number };

// Forward an agent chat message into a channel or DM, with an optional note.
// The server writes the "Forwarded message from …" header from the stored message.
export function ForwardSheet({ target, onClose }: { target: ForwardTarget; onClose: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { account } = useSession();
  const features = useFeatures();
  // Only the kinds of conversation this server uses can receive a forward (features.ts).
  const where = features.channels && features.directMessages ? "channels and people" : features.channels ? "channels" : "people";
  const [list, setList] = useState<Conversation[] | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!account) return;
    let live = true;
    api.conversations(account).then(
      all => { if (live) setList(all.filter(c => !c.archived)); },
      e => { if (live) { setList([]); setError(e instanceof ServerError ? e.message : "Couldn't load your conversations"); } },
    );
    return () => { live = false; };
  }, [account]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list ?? []).filter(c => !q || label(c).toLowerCase().includes(q));
  }, [list, query]);

  if (!account) return null;
  const send = async () => {
    if (!picked || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { conversation } = await api.forwardChatMessage(account, target.chatId, target.messageId, { conversationId: picked, text: note.trim() });
      onClose();
      router.push({ pathname: "/c/[id]", params: { id: conversation.id } });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't forward. Check your connection and try again.");
      setBusy(false);
    }
  };

  return <Modal transparent animationType="fade" visible onRequestClose={onClose}>
    <View style={[styles.overlay, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}>
      <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="Cancel forwarding" onPress={onClose} />
      <View accessibilityViewIsModal testID="forward-sheet" style={styles.card}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>Forward to</Text>
          <IconButton icon="close" label="Cancel" edge="end" onPress={onClose} />
        </View>
        <View style={styles.quote}>
          <Text style={styles.quoteAuthor}>{target.author}</Text>
          {target.text ? <Text numberOfLines={3} style={styles.quoteText}>{target.text}</Text> : null}
          {target.files ? <Text style={styles.meta}>{target.files === 1 ? "1 attachment" : `${target.files} attachments`}</Text> : null}
        </View>
        <TextInput value={query} onChangeText={setQuery} placeholder={`Search ${where}`} placeholderTextColor={colors.muted}
          accessibilityLabel={`Search ${where}`} autoCorrect={false} style={styles.search} />
        <FlatList
          data={shown}
          keyExtractor={c => c.id}
          keyboardShouldPersistTaps="handled"
          style={styles.list}
          ListEmptyComponent={list === null ? <ServeLoader style={{ marginVertical: space.lg }} />
            : <Text style={styles.empty}>{query ? "No matches" : features.channels && features.directMessages ? "No conversations" : features.channels ? "No channels" : "No chats"}</Text>}
          renderItem={({ item }) => {
            const on = picked === item.id;
            return <Pressable accessibilityRole="radio" accessibilityState={{ checked: on }} aria-checked={on} accessibilityLabel={label(item)} onPress={() => setPicked(item.id)}
              style={({ pressed }) => [styles.row, on && styles.rowOn, pressed && { backgroundColor: colors.surface }]}>
              <Text style={styles.rowText}>{label(item)}</Text>
              {on ? <AppIcon name="check" size={16} color={colors.blue} /> : null}
            </Pressable>;
          }}
        />
        <TextInput value={note} onChangeText={setNote} placeholder="Add a note (optional)" placeholderTextColor={colors.muted}
          accessibilityLabel="Add a note" multiline style={styles.note} />
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <Button label="Forward" onPress={() => { void send(); }} busy={busy} disabled={!picked} />
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
  quote: { borderLeftWidth: 3, borderLeftColor: colors.blue, paddingLeft: space.sm, paddingVertical: 2, gap: 2 },
  quoteAuthor: { ...typography.captionStrong, color: colors.ink },
  quoteText: { ...typography.body, color: colors.ink },
  meta: { ...typography.meta, color: colors.muted },
  search: controls.input,
  list: { maxHeight: 260, flexGrow: 0 },
  row: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.sm, borderRadius: radius.sm },
  rowOn: { backgroundColor: colors.blueSoft },
  rowText: { ...typography.body, flex: 1, color: colors.ink },
  empty: { ...typography.caption, color: colors.muted, textAlign: "center", marginVertical: space.md },
  note: { ...controls.input, maxHeight: 100 },
  error: { ...typography.caption, color: colors.red },
}));
