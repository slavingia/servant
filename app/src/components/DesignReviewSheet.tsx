import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { designReviewText, designStatus, designTitle } from "../lib/designs";
import { api, ServerError, type Chat, type Conversation } from "../lib/server";
import { useSession } from "../lib/session";
import { AppIcon } from "./AppIcon";
import { Button } from "./Button";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

export function DesignReviewSheet({ design, onClose }: { design: Chat; onClose: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { account } = useSession();
  const [list, setList] = useState<Conversation[] | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!account) return;
    let live = true;
    setList(null);
    setLoadError(null);
    api.conversations(account).then(
      conversations => { if (live) setList(conversations.filter(c => !c.archived && !c.agentDm)); },
      e => { if (live) setLoadError(e instanceof ServerError ? e.message : "Couldn't load your conversations"); },
    );
    return () => { live = false; };
  }, [account, loadAttempt]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list ?? []).filter(conversation => !q || conversationLabel(conversation).toLowerCase().includes(q));
  }, [list, query]);
  if (!account) return null;

  const share = async () => {
    if (!picked || busy) return;
    const conversation = list?.find(item => item.id === picked);
    if (!conversation) return;
    setBusy(true);
    setShareError(null);
    try {
      const post = await api.post(account, picked, designReviewText(design, focus));
      if (!mounted.current) return;
      onClose();
      router.push({ pathname: "/thread", params: { conv: picked, root: post.id, title: conversationLabel(conversation) } });
    } catch (e) {
      if (!mounted.current) return;
      setShareError(e instanceof ServerError ? e.message : "Couldn't share this design. Check your connection and try again.");
      setBusy(false);
    }
  };

  const retryDestinations = () => {
    setPicked(null);
    setList(null);
    setLoadError(null);
    setLoadAttempt(value => value + 1);
  };

  const close = () => { if (!busy) onClose(); };

  return <Modal transparent animationType="fade" visible onRequestClose={close}>
    <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === "ios" ? "padding" : Platform.OS === "android" ? "height" : undefined}>
      <View style={[styles.overlay, { paddingTop: insets.top + space.side, paddingBottom: insets.bottom + space.side }]}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="Cancel sharing" accessibilityState={{ disabled: busy }} disabled={busy} onPress={close} />
        <View accessibilityViewIsModal testID="design-review-sheet" style={styles.card}>
          <View style={styles.header}>
            <View style={styles.headingCopy}>
              <Text accessibilityRole="header" style={styles.title}>Share for review</Text>
              <Text style={styles.subtitle}>Feedback will stay in the message thread.</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" accessibilityState={{ disabled: busy }} disabled={busy} hitSlop={12} onPress={close}>
              <AppIcon name="close" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer} keyboardShouldPersistTaps="handled">
            <View style={styles.summary}>
              <View style={styles.designIcon}><AppIcon name="code" size={18} color={colors.blueDark} /></View>
              <View style={styles.summaryCopy}>
                <Text style={styles.designTitle} numberOfLines={1}>{designTitle(design)}</Text>
                <Text style={styles.meta}>{designStatus(design)} · Preview link included</Text>
              </View>
            </View>

            <TextInput value={query} onChangeText={setQuery} placeholder="Search channels and direct messages" placeholderTextColor={colors.muted}
              accessibilityLabel="Search channels and direct messages" autoCorrect={false} style={styles.search} />
            <View accessibilityRole="radiogroup" accessibilityLabel="Share destination" style={styles.list}>
              {list === null && !loadError
                ? <ActivityIndicator accessibilityLabel="Loading channels and direct messages" accessibilityRole="progressbar" style={styles.loading} color={colors.blue} />
                : loadError
                  ? <View style={styles.loadFailure}>
                    <Text accessibilityRole="alert" style={styles.error}>{loadError}</Text>
                    <Button label="Retry" kind="secondary" compact onPress={retryDestinations} style={styles.retry} />
                  </View>
                  : shown.length === 0
                    ? <Text style={styles.empty}>{query ? "Nothing matches your search" : "Join a channel or start a direct message first"}</Text>
                    : shown.map(item => {
                      const selected = picked === item.id;
                      return <Pressable key={item.id} accessibilityRole="radio" accessibilityState={{ checked: selected }} accessibilityLabel={conversationLabel(item)} onPress={() => setPicked(item.id)}
                        style={({ pressed }) => [styles.row, selected && styles.rowSelected, pressed && { backgroundColor: colors.surface }]}>
                        <AppIcon name={item.kind === "channel" ? "hash" : "chat"} size={17} color={selected ? colors.blueDark : colors.muted} />
                        <Text numberOfLines={1} style={styles.rowText}>{conversationLabel(item)}</Text>
                        {selected ? <AppIcon name="check" size={17} color={colors.blue} /> : null}
                      </Pressable>;
                    })}
            </View>
            <TextInput value={focus} onChangeText={setFocus} placeholder="What should reviewers focus on? (optional)" placeholderTextColor={colors.muted}
              accessibilityLabel="Review focus" multiline style={styles.focus} />
            {shareError ? <Text accessibilityRole="alert" style={styles.error}>{shareError}</Text> : null}
            <Button label="Share and open thread" onPress={() => { void share(); }} busy={busy} disabled={!picked} />
          </ScrollView>
        </View>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

function conversationLabel(conversation: Conversation) {
  return conversation.kind === "channel" ? `#${conversation.name ?? conversation.title}` : conversation.title;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  keyboard: { flex: 1 },
  overlay: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: space.side, backgroundColor: "rgba(0,0,0,0.35)" },
  card: { width: "100%", maxWidth: 440, maxHeight: "100%", backgroundColor: colors.background, borderRadius: radius.lg, padding: space.side, gap: space.sm },
  content: { flexShrink: 1, minHeight: 0 },
  contentContainer: { gap: space.sm },
  header: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: space.sm },
  headingCopy: { flex: 1, minWidth: 0 },
  title: { ...typography.heading, color: colors.ink },
  subtitle: { ...typography.caption, color: colors.muted, marginTop: 2 },
  summary: { flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, borderRadius: radius.md, backgroundColor: colors.surface },
  designIcon: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: colors.blueSoft },
  summaryCopy: { flex: 1, minWidth: 0 },
  designTitle: { ...typography.bodyStrong, color: colors.ink },
  meta: { ...typography.caption, color: colors.muted, marginTop: 2 },
  search: { ...typography.body, minHeight: 44, paddingHorizontal: space.sm, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong, color: colors.ink },
  list: { flexGrow: 0 },
  loading: { marginVertical: space.lg },
  loadFailure: { alignItems: "center", gap: space.sm, marginVertical: space.sm },
  retry: { minWidth: 120 },
  row: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.sm, borderRadius: radius.sm },
  rowSelected: { backgroundColor: colors.blueSoft },
  rowText: { ...typography.body, flex: 1, color: colors.ink },
  empty: { ...typography.caption, color: colors.muted, textAlign: "center", marginVertical: space.md },
  focus: { ...typography.body, minHeight: 64, maxHeight: 110, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong, color: colors.ink },
  error: { ...typography.caption, color: colors.red },
}));
