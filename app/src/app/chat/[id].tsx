import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useChromeHeight } from "../../components/AppChrome";
import { Composer } from "../../components/Messaging";
import { Button } from "../../components/Button";
import { api, sendMessage, ServerError, type Message } from "../../lib/server";
import { useSession } from "../../lib/session";
import { colors, radius, space, typography } from "../../lib/theme";

type Row = Message & { pending?: boolean; failed?: boolean };

export default function ChatScreen() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const { account, setAccount } = useSession();
  const headerHeight = useHeaderHeight();
  const chromeHeight = useChromeHeight();
  const [messages, setMessages] = useState<Row[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [heading, setHeading] = useState(title && title !== "New chat" ? title : "New chat");
  const list = useRef<FlatList<Row>>(null);
  const abort = useRef<AbortController | null>(null);
  const currentLoad = useRef<object | null>(null);

  const load = useCallback(async () => {
    if (!account || !id) return;
    const request = {};
    currentLoad.current = request;
    setMessages(null);
    setLoadError(null);
    try {
      const history = await api.messages(account, id);
      if (request === currentLoad.current) setMessages(history);
    } catch (e) {
      if (request !== currentLoad.current) return;
      setMessages([]);
      setLoadError(e instanceof ServerError ? e.message : "Check your connection and try again.");
    }
  }, [account, id]);

  useEffect(() => {
    void load();
    return () => {
      currentLoad.current = null;
      abort.current?.abort();
    };
  }, [load]);

  if (!account) return null;

  const send = async (text: string) => {
    const body = text.trim();
    if (!body || busy || messages === null || loadError) return false;
    setBusy(true);
    setStatus(null);
    if (heading === "New chat") setHeading(body.replace(/\s+/g, " ").slice(0, 60));
    const stamp = Date.now();
    const mine: Row = { id: `u${stamp}`, role: "user", text: body };
    const reply: Row = { id: `a${stamp}`, role: "assistant", text: "", pending: true };
    setMessages((m) => [...(m ?? []), mine, reply]);
    const update = (fn: (r: Row) => Row) => setMessages((m) => (m ?? []).map((r) => (r.id === reply.id ? fn(r) : r)));
    abort.current = new AbortController();
    let failed = false;
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
          else if (e.type === "error") {
            failed = true;
            update((r) => ({ ...r, text: r.text || e.message, failed: !r.text }));
          }
          else if (e.type === "done") update((r) => ({ ...r, pending: false }));
        },
        abort.current.signal,
        setAccount,
      );
    } catch (e) {
      failed = true;
      update((r) => ({ ...r, pending: false, failed: true, text: e instanceof ServerError ? e.message : "Couldn't send. Check your connection" }));
    } finally {
      update((r) => ({ ...r, pending: false }));
      setBusy(false);
      setStatus(null);
    }
    return !failed;
  };

  const data = [...(messages ?? [])].reverse();

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: heading }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={headerHeight + chromeHeight}>
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
                  <Text accessibilityRole="header" style={styles.emptyTitle}>{loadError ? "Couldn't load this chat" : "What can I help with?"}</Text>
                  {loadError ? <>
                    <Text accessibilityRole="alert" style={styles.emptyBody}>{loadError}</Text>
                    <Button label="Try again" kind="secondary" onPress={() => void load()} style={styles.retry} />
                  </> : <Text style={styles.emptyBody}>A private conversation with the agent on {account.serverName}.</Text>}
                </View>
              ) : undefined
            }
            renderItem={({ item }) => (
              <View accessibilityLabel={item.role === "user" ? "Your message" : "Agent response"} style={[styles.bubble, item.role === "user" ? styles.mine : styles.theirs, item.failed && styles.failed]}>
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
        {messages !== null && !loadError ? <Composer placeholder="Message the agent" onSend={send} allowAttachments={false} clearOnSend /> : null}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  list: { paddingHorizontal: space.side, paddingVertical: space.md },
  bubble: { maxWidth: "88%", borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.sm, marginVertical: space.xxs },
  mine: { alignSelf: "flex-end", backgroundColor: colors.bubbleMine, borderBottomRightRadius: radius.sm },
  theirs: { alignSelf: "flex-start", backgroundColor: colors.bubbleAgent, borderBottomLeftRadius: radius.sm },
  failed: { backgroundColor: colors.redSoft },
  text: { ...typography.body, color: colors.ink },
  mineText: { color: colors.white },
  failedText: { color: colors.red },
  typing: { ...typography.body, color: colors.muted, fontStyle: "italic" },
  empty: { alignItems: "center", marginTop: space.xxl, paddingHorizontal: space.side, paddingBottom: space.lg },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center" },
  emptyBody: { ...typography.body, marginTop: space.xs, color: colors.muted, textAlign: "center", maxWidth: 360 },
  retry: { marginTop: space.lg },
});
