import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect, useScrollToTop } from "expo-router";
import { PageTitle } from "../../components/Band";
import { SkeletonRows } from "../../components/Skeleton";
import { Avatar } from "../../components/Messaging";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { AppIcon } from "../../components/AppIcon";
import { useStatusNow } from "../../components/Presence";
import { api, ServerError, type Person } from "../../lib/server";
import { useLive } from "../../lib/live";
import { presenceLabel } from "../../lib/message-status";
import { useSession } from "../../lib/session";
import { radius, space, typography, useTheme, createThemedStyles } from "../../lib/theme";

export default function Members() {
  const styles = useStyles();
  // Tapping the tab you're already on scrolls back to the top.
  const scrollRef = useRef<FlatList<Person>>(null);
  useScrollToTop(scrollRef);
  const { colors } = useTheme();
  const { account } = useSession();
  const { presence, connected } = useLive();
  const now = useStatusNow();
  const [directory, setDirectory] = useState<{ token: string; people: Person[] } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Person | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!account) return;
    try {
      const result = await api.people(account);
      setDirectory({ token: account.token, people: result.people });
      setError(null);
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't load members. Pull down to try again");
    } finally { setRefreshing(false); }
  }, [account]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  if (!account) return null;
  const people = directory?.token === account.token ? directory.people : null;
  const owner = account.user.role === "owner";
  // Owners mark people who aren't programmers: their agent chats become vibe coding.
  const toggleVibe = async (person: Person) => {
    if (opening) return;
    setOpening(person.id); setError(null);
    try {
      const { person: updated } = await api.setVibeCoder(account, person.id, !person.vibeCoder);
      setDirectory(d => d && { ...d, people: d.people.map(p => p.id === updated.id ? { ...p, vibeCoder: updated.vibeCoder } : p) });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't change that. Try again");
    } finally { setOpening(null); }
  };
  // Owners lift someone's daily agent token cap (designers iterating on a big task, testers).
  const toggleTokens = async (person: Person) => {
    if (opening) return;
    setOpening(person.id); setError(null);
    try {
      const { person: updated } = await api.setUnlimitedTokens(account, person.id, !person.unlimitedTokens);
      setDirectory(d => d && { ...d, people: d.people.map(p => p.id === updated.id ? { ...p, unlimitedTokens: updated.unlimitedTokens } : p) });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't change that. Try again");
    } finally { setOpening(null); }
  };
  const remove = async () => {
    if (!removing || removeBusy) return;
    setRemoveBusy(true); setRemoveError(null);
    try {
      await api.removePerson(account, removing.id);
      setDirectory(d => d && { ...d, people: d.people.filter(p => p.id !== removing.id) });
      setRemoving(null);
    } catch (e) {
      setRemoveError(e instanceof ServerError ? e.message : "Couldn't remove them. Try again");
    } finally { setRemoveBusy(false); }
  };
  const message = async (person: Person) => {
    if (opening) return;
    setOpening(person.id); setError(null);
    try {
      const conversation = await api.openDm(account, [person.id]);
      router.push({ pathname: "/c/[id]", params: { id: conversation.id, compose: "1" } });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't open the conversation. Try again");
    } finally { setOpening(null); }
  };
  return <View style={styles.root}>
    <FlatList ref={scrollRef} contentInsetAdjustmentBehavior="automatic"
      data={people ?? []}
      keyExtractor={person => person.id}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl tintColor={colors.blue} colors={[colors.blue]} progressBackgroundColor={colors.surface} refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />}
      ListHeaderComponent={<>
        <PageTitle action={account.user.role === "owner" ? <Button label="Invite people" kind="link" compact onPress={() => router.push("/invite")} /> : undefined}>People</PageTitle>
        {people?.length ? <Text style={styles.resultCount}>{`${people.length} ${people.length === 1 ? "member" : "members"}`}</Text> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      </>}
      ListEmptyComponent={people === null && !error ? <SkeletonRows label="Loading members" /> : <View style={styles.empty}>
        <Text style={styles.emptyTitle}>{error ? "Couldn't load members" : "No members yet"}</Text>
        <Text style={styles.emptyBody}>{error ? "Try again to see who's here." : "People will appear here when they join your server."}</Text>
        {error ? <Button label="Try again" kind="secondary" busy={refreshing} onPress={() => { setRefreshing(true); void load(); }} style={styles.emptyAction} /> : null}
      </View>}
      renderItem={({ item }) => {
        const self = item.id === account.user.id;
        const status = self ? "" : presenceLabel(presence[item.id] ?? { ...item, online: false }, now, connected);
        return <Pressable accessibilityRole={self ? undefined : "button"} accessibilityLabel={`${item.name}${self ? ", you" : ""}, ${item.owner ? "owner" : "member"}${status ? `, ${status}` : ""}`} accessibilityHint={self ? undefined : "Open direct message"} disabled={self || !!opening} onPress={() => void message(item)} onLongPress={owner && !self && !item.owner ? () => { setRemoveError(null); setRemoving(item); } : undefined}
          accessibilityActions={owner && !self && !item.owner ? [{ name: "remove", label: `Remove ${item.name} from ${account.serverName}` }] : undefined}
          onAccessibilityAction={e => { if (e.nativeEvent.actionName === "remove") { setRemoveError(null); setRemoving(item); } }} style={({ pressed }) => [styles.row, owner && !item.owner && styles.rowTall, pressed && { backgroundColor: colors.surface }]}>
          <Avatar name={item.name} userId={item.id} size={36} />
          <View style={styles.copy}>
            <Text style={styles.name}>{item.name}{self ? <Text style={styles.you}> · You</Text> : null}</Text>
            <Text style={[styles.role, status === "Online" && styles.online]}>{item.owner ? "Workspace owner" : !owner && item.vibeCoder ? "Vibe coder" : "Member"}{status ? ` · ${status}` : ""}</Text>
            {/* Owner controls go under the name: beside it they squeezed names to a syllable per line on phones. */}
            {owner && !item.owner ? <View style={styles.controls}>
              <Pressable testID={`vibe-${item.id}`} accessibilityRole="switch" accessibilityState={{ checked: !!item.vibeCoder, disabled: !!opening }} accessibilityLabel={`Vibe coder: ${item.name}`}
                accessibilityHint="Their agent chats build prototypes with a preview link" hitSlop={4} onPress={() => void toggleVibe(item)}
                style={({ pressed }) => [styles.chip, item.vibeCoder && styles.chipOn, pressed && { opacity: 0.7 }]}>
                <Text style={[styles.chipText, item.vibeCoder && styles.chipTextOn]}>Vibe coder</Text>
              </Pressable>
              <Pressable testID={`tokens-${item.id}`} accessibilityRole="switch" accessibilityState={{ checked: !!item.unlimitedTokens, disabled: !!opening }} accessibilityLabel={`No token limit: ${item.name}`}
                accessibilityHint="Lifts their daily agent limit" hitSlop={4} onPress={() => void toggleTokens(item)}
                style={({ pressed }) => [styles.chip, item.unlimitedTokens && styles.chipOn, pressed && { opacity: 0.7 }]}>
                <Text style={[styles.chipText, item.unlimitedTokens && styles.chipTextOn]}>No token limit</Text>
              </Pressable>
              {!self ? <Pressable testID={`remove-${item.id}`} accessibilityRole="button" accessibilityLabel={`Remove ${item.name}`} hitSlop={4}
                onPress={() => { setRemoveError(null); setRemoving(item); }} style={({ pressed }) => [styles.removeLink, pressed && { opacity: 0.6 }]}>
                <Text style={styles.removeText}>Remove</Text>
              </Pressable> : null}
            </View> : null}
          </View>
          <View style={[styles.trailing, owner && !item.owner && styles.trailingTall]}>{opening === item.id ? <ActivityIndicator color={colors.blue} /> : !self ? <AppIcon name="chat" size={18} color={colors.muted} /> : null}</View>
        </Pressable>;
      }}
      contentContainerStyle={styles.content}
    />
    <ConfirmDialog visible={!!removing} title={removing ? `Remove ${removing.name}?` : ""}
      description={`They're signed out of every device right away and can't use ${account.serverName} again unless you invite them back. Their messages stay, and #general notes that they left.`}
      confirmLabel="Remove" busy={removeBusy} error={removeError}
      onCancel={() => { setRemoving(null); setRemoveError(null); }} onConfirm={() => void remove()} />
  </View>;
}
const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: space.xl, flexGrow: 1 },
  resultCount: { ...typography.caption, marginHorizontal: space.side, marginBottom: space.xs, color: colors.muted },
  row: { minHeight: 64, paddingHorizontal: space.side, paddingVertical: space.sm, flexDirection: "row", alignItems: "center" },
  // With controls under the name the row is three lines tall: line the avatar and the chat glyph up with the name.
  rowTall: { alignItems: "flex-start" },
  trailing: { width: 36, minHeight: 36, alignItems: "center", justifyContent: "center" },
  trailingTall: { marginTop: 2 },
  copy: { flex: 1, minWidth: 0, marginLeft: space.sm, marginRight: space.xs },
  name: { ...typography.bodyStrong, color: colors.ink },
  you: { ...typography.body, color: colors.muted },
  role: { ...typography.caption, marginTop: 2, color: colors.muted },
  online: { color: colors.blueDark },
  controls: { flexDirection: "row", alignItems: "center", gap: space.xs, marginTop: space.xs },
  // 36pt chips with 4pt hit slop: a 44pt target without a tall row.
  chip: { minHeight: 36, flexShrink: 0, paddingHorizontal: space.xs + 2, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, justifyContent: "center" },
  chipOn: { backgroundColor: colors.blueSoft, borderColor: colors.blueSoft },
  chipText: { ...typography.meta, color: colors.muted },
  chipTextOn: { color: colors.blueDark, fontWeight: "600" },
  removeLink: { minHeight: 36, paddingHorizontal: space.xs, justifyContent: "center", marginLeft: "auto" },
  removeText: { ...typography.meta, color: colors.red },
  error: { ...typography.caption, marginHorizontal: space.side, marginVertical: space.xs, color: colors.red },
  loading: { marginTop: space.xxl },
  empty: { marginTop: space.xxl, paddingHorizontal: space.lg, alignItems: "center" },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center" },
  emptyBody: { ...typography.body, marginTop: space.xs, maxWidth: 320, color: colors.muted, textAlign: "center" },
  emptyAction: { marginTop: space.lg },
}));
