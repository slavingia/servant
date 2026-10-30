import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, sendMessage, HubError, type Message } from "../../lib/hub";
import { useSession } from "../../lib/session";
import { colors } from "../../lib/theme";

type Row = Message & { pending?: boolean; failed?: boolean };

export default function ChatScreen() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const { account } = useSession();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const [messages, setMessages] = useState<Row[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [heading, setHeading] = useState(title && title !== "New chat" ? title : "New chat");
  const list = useRef<FlatList<Row>>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!account || !id) return;
    api
      .messages(account, id)
      .then((m) => setMessages(m))
      .catch((e) => {
        setMessages([]);
        setLoadError(e instanceof HubError ? e.message : "Couldn't load this chat");
      });
    return () => abort.current?.abort();
  }, [account, id]);

  if (!account) return null;

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setText("");
    setBusy(true);
    setStatus(null);
    if (heading === "New chat") setHeading(body.replace(/\s+/g, " ").slice(0, 60));
    const stamp = Date.now();
    const mine: Row = { id: `u${stamp}`, role: "user", text: body };
    const reply: Row = { id: `a${stamp}`, role: "assistant", text: "", pending: true };
    setMessages((m) => [...(m ?? []), mine, reply]);
    const update = (fn: (r: Row) => Row) => setMessages((m) => (m ?? []).map((r) => (r.id === reply.id ? fn(r) : r)));
    abort.current = new AbortController();
    try {
      await sendMessage(
        account,
        String(id),
        body,
        (e) => {
          if (e.type === "delta") {
            setStatus(null);
            update((r) => ({ ...r, text: r.text + e.text }));
          } else if (e.type === "message") update((r) => ({ ...r, text: e.text || r.text }));
          else if (e.type === "status") setStatus(e.text);
          else if (e.type === "error") update((r) => ({ ...r, text: r.text || e.message, failed: !r.text }));
          else if (e.type === "done") update((r) => ({ ...r, pending: false }));
        },
        abort.current.signal,
      );
    } catch (e) {
      update((r) => ({ ...r, pending: false, failed: true, text: e instanceof HubError ? e.message : "Couldn't send. Check your connection" }));
    } finally {
      update((r) => ({ ...r, pending: false }));
      setBusy(false);
      setStatus(null);
    }
  };

  const data = [...(messages ?? [])].reverse();

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: heading }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={headerHeight}>
        {messages === null ? (
          <ActivityIndicator style={{ flex: 1 }} color={colors.blue} />
        ) : (
          <FlatList
            ref={list}
            inverted
            data={data}
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.list}
            ListFooterComponent={
              messages.length === 0 ? (
                <View style={styles.empty}>
                  <Text style={styles.emptyTitle}>{loadError ?? "What can I help with?"}</Text>
                  {!loadError ? <Text style={styles.emptyBody}>Your messages go to {account.hubName}</Text> : null}
                </View>
              ) : undefined
            }
            renderItem={({ item }) => (
              <View style={[styles.bubble, item.role === "user" ? styles.mine : styles.theirs, item.failed && styles.failed]}>
                {item.pending && !item.text ? (
                  <Text style={styles.typing}>{status ?? "Thinking…"}</Text>
                ) : (
                  <Text selectable style={[styles.text, item.role === "user" && styles.mineText, item.failed && styles.failedText]}>
                    {item.text}
                  </Text>
                )}
              </View>
            )}
          />
        )}
        <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
          <TextInput
            accessibilityLabel="Message"
            value={text}
            onChangeText={setText}
            placeholder="Message"
            placeholderTextColor="#8A8F96"
            multiline
            style={styles.input}
            onSubmitEditing={Platform.OS === "web" ? send : undefined}
            blurOnSubmit={false}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            onPress={send}
            disabled={!text.trim() || busy}
            style={[styles.send, (!text.trim() || busy) && { opacity: 0.4 }]}
          >
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  list: { paddingHorizontal: 16, paddingVertical: 16 },
  bubble: { maxWidth: "84%", borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, marginVertical: 4 },
  mine: { alignSelf: "flex-end", backgroundColor: colors.bubbleMine, borderBottomRightRadius: 6 },
  theirs: { alignSelf: "flex-start", backgroundColor: colors.bubbleAgent, borderBottomLeftRadius: 6 },
  failed: { backgroundColor: "#FDECEF" },
  text: { fontSize: 17, lineHeight: 23, color: colors.ink },
  mineText: { color: colors.white },
  failedText: { color: colors.red },
  typing: { fontSize: 16, color: colors.muted, fontStyle: "italic" },
  empty: { alignItems: "center", marginTop: 80, paddingHorizontal: 20 },
  emptyTitle: { fontSize: 20, fontWeight: "600", color: colors.ink, textAlign: "center" },
  emptyBody: { marginTop: 6, fontSize: 15, color: colors.muted, textAlign: "center" },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: colors.white,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 16,
    paddingTop: 11,
    paddingBottom: 11,
    fontSize: 17,
    color: colors.ink,
    backgroundColor: colors.surface,
  },
  send: { marginLeft: 8, height: 44, paddingHorizontal: 16, borderRadius: 22, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" },
  sendText: { color: colors.white, fontSize: 16, fontWeight: "600" },
});
