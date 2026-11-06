import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Platform, Pressable, RefreshControl, StyleSheet, Switch, Text, View } from "react-native";
import { router, useFocusEffect, useScrollToTop } from "expo-router";
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

const TIERS = [
  { tier: 0, label: "No agent", hint: "They can't use the agent" },
  { tier: 1, label: "Tester", hint: "Their agent only files GitHub issues" },
  { tier: 2, label: "Design prototyper", hint: "Their agent builds interactive designs with a preview link" },
  { tier: 4, label: "Researcher", hint: "Their agent searches the web and uses skills. No GitHub, no files, no commands" },
  { tier: 3, label: "Design engineer", hint: "Their agent has full access" },
];

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
  // Whose ••• sheet is open: owners set a person's agent tier and token limit there, or remove them.
  const [managing, setManaging] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Person | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // iOS won't present the confirm while the sheet is still animating away, so it waits for the sheet's dismissal.
  const queuedRemove = useRef<Person | null>(null);
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
  const reconnecting = !connected && people !== null;
  const managed = managing ? people?.find(p => p.id === managing) ?? null : null;
  const canManage = (person: Person) => owner && !person.owner && person.id !== account.user.id;
  const statusOf = (person: Person) => person.id === account.user.id ? "" : presenceLabel(presence[person.id] ?? { ...person, online: false }, now, connected);
  // One line under the name: role or agent tier, the lifted token limit (owners only), presence.
  const describe = (person: Person, status: string) => [
    person.owner ? "Workspace owner" : (person.agentTier && TIERS.find(t => t.tier === person.agentTier)?.label) || "Member",
    owner && !person.owner && person.unlimitedTokens ? "No token limit" : null,
    status || null,
  ].filter(Boolean).join(" · ");
  // Owners choose what each person's agent may do: none, file bug reports, build prototypes, or everything.
  const setTier = async (person: Person, tier: number) => {
    if (opening || (person.agentTier ?? 0) === tier) return;
    setOpening(person.id); setError(null);
    try {
      const { person: updated } = await api.setAgentTier(account, person.id, tier);
      setDirectory(d => d && { ...d, people: d.people.map(p => p.id === updated.id ? { ...p, agentTier: updated.agentTier, vibeCoder: updated.vibeCoder } : p) });
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
  const askRemove = (person: Person) => {
    setRemoveError(null);
    if (managing && Platform.OS === "ios") { queuedRemove.current = person; setManaging(null); return; }
    setManaging(null); setRemoving(person);
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
      ListHeaderComponent={<View>
        {/* Same header as Messages and Agent: title on the left, one icon button on the right. */}
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>People</Text>
          {owner ? <Pressable accessibilityRole="button" accessibilityLabel="Invite people" onPress={() => router.push("/invite")} style={styles.compose}>
            <AppIcon name="addPerson" size={22} color={colors.ink} />
          </Pressable> : null}
        </View>
        {/* As tall as the filter pills on the other tabs, so the first row starts on the same line everywhere. */}
        <View style={styles.strip}>
          <View style={styles.countBox}>{people ? <Text style={styles.count}>{`${people.length} ${people.length === 1 ? "member" : "members"}`}</Text> : null}</View>
          <Text aria-hidden={!reconnecting} accessibilityLiveRegion="polite" style={[styles.status, { opacity: reconnecting ? 1 : 0 }]}>Reconnecting…</Text>
        </View>
        {error && !managed ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      </View>}
      ListEmptyComponent={people === null && !error ? <SkeletonRows label="Loading members" /> : <View style={styles.empty}>
        <Text style={styles.emptyTitle}>{error ? "Couldn't load members" : "No members yet"}</Text>
        <Text style={styles.emptyBody}>{error ? "Try again to see who's here." : "People will appear here when they join your server."}</Text>
        {error ? <Button label="Try again" kind="secondary" busy={refreshing} onPress={() => { setRefreshing(true); void load(); }} style={styles.emptyAction} /> : null}
      </View>}
      renderItem={({ item }) => {
        const self = item.id === account.user.id;
        const status = statusOf(item);
        const detail = describe(item, status);
        const manageable = canManage(item);
        const busy = opening === item.id;
        return <View style={styles.rowWrap}>
          <Pressable accessibilityRole={self ? undefined : "button"} accessibilityLabel={`${item.name}${self ? ", you" : ""}, ${detail}`} accessibilityHint={self ? undefined : "Open direct message"} disabled={self || !!opening} onPress={() => void message(item)}
            onLongPress={manageable ? () => setManaging(item.id) : undefined}
            accessibilityActions={manageable ? [{ name: "manage", label: `Manage ${item.name}` }, { name: "remove", label: `Remove ${item.name} from ${account.serverName}` }] : undefined}
            onAccessibilityAction={e => { if (e.nativeEvent.actionName === "manage") setManaging(item.id); if (e.nativeEvent.actionName === "remove") askRemove(item); }}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}>
            <Avatar name={item.name} userId={item.id} size={40} />
            <View style={styles.copy}>
              <Text style={styles.name} numberOfLines={1}>{item.name}{self ? <Text style={styles.you}> · You</Text> : null}</Text>
              <Text style={[styles.detail, status === "Online" && styles.online]} numberOfLines={1}>{detail}</Text>
            </View>
            {/* The chat glyph sits where ••• sits on the rows an owner can manage, and on the Messages tab. */}
            {!manageable ? <View style={styles.trailing}>{busy ? <ActivityIndicator color={colors.blue} /> : self ? null : <AppIcon name="chat" size={18} color={colors.muted} />}</View> : null}
          </Pressable>
          {manageable ? <Pressable accessibilityRole="button" accessibilityLabel={`Actions for ${item.name}`} accessibilityState={{ disabled: !!opening }} disabled={!!opening} onPress={() => setManaging(item.id)} style={({ pressed }) => [styles.trailing, styles.more, pressed && { opacity: 0.7 }]}>
            {busy ? <ActivityIndicator color={colors.blue} /> : <AppIcon name="more" size={18} color={colors.muted} />}
          </Pressable> : null}
        </View>;
      }}
      contentContainerStyle={styles.content}
    />
    <Modal visible={!!managed} transparent animationType="fade" onRequestClose={() => setManaging(null)}
      onDismiss={() => { const person = queuedRemove.current; queuedRemove.current = null; if (person) setRemoving(person); }}>
      <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={() => setManaging(null)}>
        <Pressable accessibilityViewIsModal style={styles.card} onPress={() => {}}>
          {managed ? <>
            <View style={styles.cardHead}>
              <Avatar name={managed.name} userId={managed.id} size={40} />
              <View style={styles.copy}>
                <Text accessibilityRole="header" style={styles.cardTitle} numberOfLines={1}>{managed.name}</Text>
                <Text style={styles.detail} numberOfLines={1}>{describe(managed, statusOf(managed))}</Text>
              </View>
              {opening === managed.id ? <ActivityIndicator color={colors.blue} /> : null}
            </View>
            {error ? <Text accessibilityRole="alert" style={styles.cardError}>{error}</Text> : null}
            <Text style={styles.cardLabel}>What their agent can do</Text>
            {TIERS.map(t => {
              const on = (managed.agentTier ?? 0) === t.tier;
              return <Pressable key={t.tier} testID={`tier-${t.tier}-${managed.id}`} accessibilityRole="radio" accessibilityState={{ checked: on, disabled: !!opening }} accessibilityLabel={`${t.label}: ${managed.name}`} accessibilityHint={t.hint}
                disabled={!!opening} onPress={() => void setTier(managed, t.tier)} style={({ pressed }) => [styles.option, pressed && { backgroundColor: colors.surface }]}>
                <View style={styles.optionCopy}>
                  <Text style={[styles.optionLabel, on && styles.optionOn]}>{t.label}</Text>
                  <Text style={styles.optionHint}>{t.hint}</Text>
                </View>
                {on ? <AppIcon name="check" size={20} color={colors.blue} /> : null}
              </Pressable>;
            })}
            <View style={styles.switchRow}>
              <View style={styles.optionCopy}>
                <Text style={styles.optionLabel}>No token limit</Text>
                <Text style={styles.optionHint}>Lifts their daily agent limit</Text>
              </View>
              <Switch testID={`tokens-${managed.id}`} accessibilityLabel={`No token limit: ${managed.name}`} value={!!managed.unlimitedTokens} disabled={!!opening} onValueChange={() => void toggleTokens(managed)}
                trackColor={{ true: colors.blue, false: colors.borderStrong }} thumbColor="#FFFFFF" {...(Platform.OS === "web" ? { activeThumbColor: "#FFFFFF" } : {})} />
            </View>
            <View style={styles.cardActions}>
              <Pressable testID={`remove-${managed.id}`} accessibilityRole="button" accessibilityLabel={`Remove ${managed.name}`} accessibilityState={{ disabled: !!opening }} disabled={!!opening}
                onPress={() => askRemove(managed)} style={({ pressed }) => [styles.removeButton, pressed && { opacity: 0.6 }]}>
                <Text style={styles.removeText}>Remove</Text>
              </Pressable>
              <Button label="Done" kind="secondary" onPress={() => setManaging(null)} style={styles.done} />
            </View>
          </> : null}
        </Pressable>
      </Pressable>
    </Modal>
    <ConfirmDialog visible={!!removing} title={removing ? `Remove ${removing.name}?` : ""}
      description={`They're signed out of every device right away and can't use ${account.serverName} again unless you invite them back. Their messages stay, and #general notes that they left.`}
      confirmLabel="Remove" busy={removeBusy} error={removeError}
      onCancel={() => { setRemoving(null); setRemoveError(null); }} onConfirm={() => void remove()} />
  </View>;
}
const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: space.xxl, flexGrow: 1 },
  // Header, icon button and strip measure the same as on Messages and Agent.
  header: { minHeight: 60, paddingLeft: space.side, paddingRight: space.xs, paddingVertical: space.xs, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.xs },
  title: { ...typography.title, color: colors.ink, flexShrink: 1 },
  compose: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  strip: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.side, paddingVertical: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  // The count stands where a filter pill would: a pill is its 22pt label plus 12pt above and below.
  countBox: { minHeight: typography.bodyStrong.lineHeight + 2 * space.sm, justifyContent: "center" },
  count: { ...typography.caption, color: colors.muted },
  status: { ...typography.caption, marginLeft: "auto", color: colors.muted },
  error: { ...typography.caption, marginTop: space.xs, marginHorizontal: space.side, color: colors.red },
  // Rows measure the same as the Messages list: 40pt avatar, 72pt minimum, hairline between rows, 44pt trailing slot.
  rowWrap: { flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  row: { flex: 1, minWidth: 0, minHeight: 72, paddingLeft: space.side, paddingRight: space.xs, paddingVertical: space.sm, flexDirection: "row", alignItems: "center" },
  copy: { flex: 1, minWidth: 0, marginLeft: space.sm },
  name: { ...typography.body, color: colors.ink },
  you: { color: colors.muted },
  detail: { ...typography.caption, marginTop: space.xxs, color: colors.muted },
  online: { color: colors.blueDark },
  trailing: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  more: { marginRight: space.xs },
  // The person sheet: the same card as a project's access editor.
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: space.side, backgroundColor: "rgba(17,46,81,0.42)" },
  card: { width: "100%", maxWidth: 420, backgroundColor: colors.background, borderRadius: radius.lg, paddingVertical: space.side },
  cardHead: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.side, paddingBottom: space.sm },
  cardTitle: { ...typography.heading, color: colors.ink },
  cardError: { ...typography.caption, color: colors.red, marginHorizontal: space.side, marginBottom: space.sm },
  cardLabel: { ...typography.label, color: colors.muted, paddingHorizontal: space.side, paddingTop: space.sm, paddingBottom: space.xxs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  option: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.side, paddingVertical: space.xs },
  optionCopy: { flex: 1, minWidth: 0 },
  optionLabel: { ...typography.body, color: colors.ink },
  optionOn: { ...typography.bodyStrong },
  optionHint: { ...typography.caption, color: colors.muted, marginTop: 2 },
  switchRow: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.side, marginTop: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  cardActions: { flexDirection: "row", gap: space.sm, marginTop: space.md, marginHorizontal: space.side },
  removeButton: { flex: 1, minHeight: 44, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", paddingHorizontal: space.md, paddingVertical: space.xs },
  removeText: { ...typography.bodyStrong, color: colors.red, textAlign: "center" },
  done: { flex: 1 },
  empty: { marginTop: space.xxl, paddingHorizontal: space.lg, alignItems: "center" },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center" },
  emptyBody: { ...typography.body, marginTop: space.xs, maxWidth: 320, color: colors.muted, textAlign: "center" },
  emptyAction: { marginTop: space.lg },
}));
