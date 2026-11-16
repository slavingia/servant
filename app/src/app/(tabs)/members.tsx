import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Redirect, router, useFocusEffect, useScrollToTop } from "expo-router";
import { SkeletonRows } from "../../components/Skeleton";
import { Avatar } from "../../components/Messaging";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { AppIcon } from "../../components/AppIcon";
import { PresenceDot, useStatusNow } from "../../components/Presence";
import { api, ServerError, type Person } from "../../lib/server";
import { useLivePresence } from "../../lib/live";
import { presenceDot, presenceLabel } from "../../lib/message-status";
import { useSession } from "../../lib/session";
import { landingHref, useFeature, useFeatures } from "../../lib/features";
import { emailLine, type EmailLine } from "../../lib/person-email";
import { AGENT_ROLES, roleLabel } from "../../lib/agent-roles";
import { chosenLimit, costNote, limitApplies, limitChange, limitRows, limitSummary, roleCostLine, unbroken, type LimitChoice, type RoleCosts, type RoleLimits } from "../../lib/token-limit";
import { radius, space, typography, useTheme, createThemedStyles } from "../../lib/theme";

// A person's work email under their role (person-email.ts), for owners: the same line in the list and in the sheet.
function EmailNote({ line }: { line: EmailLine }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return <View style={styles.emailRow}>
    {line.unverified ? <View style={styles.emailMark}><AppIcon name="warning" size={13} color={colors.red} /></View> : null}
    <Text style={[styles.detail, styles.emailText]}>{line.text}</Text>
  </View>;
}

// One part of the person sheet. Only one is open at a time, so the open one has room to say what each choice means;
// a closed one says what is chosen.
function SheetSection({ title, summary, open, onToggle, children }: { title: string; summary: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return <View style={styles.section}>
    <Pressable accessibilityRole="button" accessibilityLabel={summary ? `${title}: ${summary}` : title} accessibilityState={{ expanded: open }} aria-expanded={open}
      onPress={onToggle} style={({ pressed }) => [styles.sectionHead, pressed && { backgroundColor: colors.surface }]}>
      <View style={styles.optionCopy}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {!open && summary ? <Text style={styles.optionHint}>{summary}</Text> : null}
      </View>
      <AppIcon name={open ? "chevronDown" : "chevronRight"} size={18} color={colors.muted} />
    </Pressable>
    {open ? children : null}
  </View>;
}

export default function Members() {
  const styles = useStyles();
  // Tapping the tab you're already on scrolls back to the top.
  const scrollRef = useRef<FlatList<Person>>(null);
  useScrollToTop(scrollRef);
  const { colors } = useTheme();
  const { account, deepWork } = useSession();
  // Tapping a person opens a direct message; on a server without DMs the row is just a listing.
  const dms = useFeature("directMessages");
  // Deep work hides People (features.ts withDeepWork); a link or a tab left open lands where the app opens.
  const features = useFeatures();
  const { presence, connected } = useLivePresence();
  const now = useStatusNow();
  const [directory, setDirectory] = useState<{ token: string; people: Person[]; emailChecks?: boolean; roleLimits?: RoleLimits; roleCosts?: RoleCosts } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whose ••• sheet is open: owners set a person's role and daily token limit there, or remove them.
  const [managing, setManaging] = useState<string | null>(null);
  // Which part of that sheet is open. The role first: it decides what a limit is a limit on.
  const [section, setSection] = useState<"role" | "limit" | null>("role");
  const manage = (id: string) => { setSection("role"); setManaging(id); };
  const [removing, setRemoving] = useState<Person | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // iOS won't present the confirm while the sheet is still animating away, so it waits for the sheet's dismissal.
  const queuedRemove = useRef<Person | null>(null);
  const load = useCallback(async () => {
    if (!account) return;
    try {
      const result = await api.people(account);
      setDirectory({ token: account.token, people: result.people, emailChecks: result.emailChecks === true, roleLimits: result.tierTokenLimits, roleCosts: result.tierCosts });
      setError(null);
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't load members. Pull down to try again");
    } finally { setRefreshing(false); }
  }, [account]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  if (!account) return null;
  if (!features.people) return <Redirect href={landingHref(features)} />;
  const people = directory?.token === account.token ? directory.people : null;
  const owner = account.user.role === "owner";
  const reconnecting = !connected && people !== null;
  const managed = managing ? people?.find(p => p.id === managing) ?? null : null;
  const emailOf = (person: Person) => owner && !person.owner ? emailLine(person, directory?.emailChecks === true) : null;
  const managedEmail = managed ? emailOf(managed) : null;
  const canManage = (person: Person) => owner && !person.owner && person.id !== account.user.id;
  // Your own row says only whether you're in deep work (deep-work.ts); everyone else's says what you see of them.
  const statusOf = (person: Person) => person.id === account.user.id ? (deepWork ? "Deep work" : "") : presenceLabel(presence[person.id] ?? { ...person, online: false }, now, connected);
  // One line under the name: role or agent tier, the lifted token limit (owners only), presence.
  const describe = (person: Person, status: string) => [
    person.owner ? "Workspace owner" : person.agentTier ? roleLabel(person.agentTier) : "Member",
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
  // Owners set someone's daily agent limit: their role's own, a fixed step, or none (token-limit.ts).
  const setLimit = async (person: Person, choice: LimitChoice) => {
    if (opening || chosenLimit(person)?.key === choice.key) return;
    setOpening(person.id); setError(null);
    try {
      const { person: updated } = await api.setDailyLimit(account, person.id, limitChange(choice));
      setDirectory(d => d && { ...d, people: d.people.map(p => p.id === updated.id ? { ...p, unlimitedTokens: !!updated.unlimitedTokens, tokenLimit: updated.tokenLimit ?? undefined } : p) });
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
        {/* Same header as Messages and Agent: title on the left, one icon button on the right. The count sits beside the title to save a line. */}
        <View style={styles.header}>
          <View style={styles.titleRow}>
            <Text accessibilityRole="header" style={styles.title}>People</Text>
            {people ? <Text style={styles.count}>{`${people.length} ${people.length === 1 ? "member" : "members"}`}</Text> : null}
          </View>
          <Text aria-hidden={!reconnecting} accessibilityLiveRegion="polite" style={[styles.status, { opacity: reconnecting ? 1 : 0 }]}>Reconnecting…</Text>
          {owner ? <Pressable accessibilityRole="button" accessibilityLabel="Invite people" onPress={() => router.push("/invite")} style={styles.compose}>
            <AppIcon name="addPerson" size={22} color={colors.ink} />
          </Pressable> : null}
        </View>
        {error && !managed ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      </View>}
      ListEmptyComponent={people === null && !error ? <SkeletonRows label="Loading members" /> : <View style={styles.empty}>
        <Text style={styles.emptyTitle}>{error ? "Couldn't load members" : "No members yet"}</Text>
        {error ? <Button label="Try again" kind="secondary" busy={refreshing} onPress={() => { setRefreshing(true); void load(); }} style={styles.emptyAction} /> : null}
      </View>}
      renderItem={({ item }) => {
        const self = item.id === account.user.id;
        const status = statusOf(item);
        const detail = describe(item, status);
        const manageable = canManage(item);
        const busy = opening === item.id;
        const email = emailOf(item);
        return <View style={styles.rowWrap}>
          <Pressable accessibilityRole={self || !dms ? undefined : "button"} accessibilityLabel={`${item.name}${self ? ", you" : ""}, ${detail}${email ? `, ${email.label}` : ""}`} accessibilityHint={self || !dms ? undefined : "Open direct message"} disabled={self || !dms || !!opening} onPress={() => void message(item)}
            onLongPress={manageable ? () => manage(item.id) : undefined}
            accessibilityActions={manageable ? [{ name: "manage", label: `Manage ${item.name}` }, { name: "remove", label: `Remove ${item.name} from ${account.serverName}` }] : undefined}
            onAccessibilityAction={e => { if (e.nativeEvent.actionName === "manage") manage(item.id); if (e.nativeEvent.actionName === "remove") askRemove(item); }}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}>
            <View>
              <Avatar name={item.name} userId={item.id} size={40} />
              {/* The same badge as the sidebar: green for available, the moon for deep work (deep-work.ts), so the line below never has to carry it alone. */}
              <PresenceDot status={self ? (deepWork ? "deepWork" : "off") : presenceDot(presence[item.id] ?? { ...item, online: false }, connected)} size={10} ring={colors.background} />
            </View>
            <View style={styles.copy}>
              <Text style={styles.name}>{item.name}{self ? <Text style={styles.you}> · You</Text> : null}</Text>
              <Text style={[styles.detail, status === "Online" && styles.online]}>{detail}</Text>
              {email ? <EmailNote line={email} /> : null}
            </View>
            {/* The chat glyph sits where ••• sits on the rows an owner can manage, and on the Messages tab. */}
            {!manageable ? <View style={styles.trailing}>{busy ? <ActivityIndicator color={colors.blue} /> : self || !dms ? null : <AppIcon name="chat" size={18} color={colors.muted} />}</View> : null}
          </Pressable>
          {manageable ? <Pressable accessibilityRole="button" accessibilityLabel={`Actions for ${item.name}`} accessibilityState={{ disabled: !!opening }} disabled={!!opening} onPress={() => manage(item.id)} style={({ pressed }) => [styles.trailing, styles.more, pressed && { opacity: 0.7 }]}>
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
                <Text accessibilityRole="header" style={styles.cardTitle}>{managed.name}</Text>
                <Text style={styles.detail}>{describe(managed, statusOf(managed))}</Text>
                {managedEmail ? <EmailNote line={managedEmail} /> : null}
              </View>
              {opening === managed.id ? <ActivityIndicator color={colors.blue} /> : null}
            </View>
            {error ? <Text accessibilityRole="alert" style={styles.cardError}>{error}</Text> : null}
            {/* The choices scroll; the name above and Remove and Done below stay put, so a small phone, a short window
                or large text never puts them out of reach. */}
            <ScrollView style={styles.cardScroll} keyboardShouldPersistTaps="handled">
            <SheetSection title="What their agent can do" summary={roleLabel(managed.agentTier)} open={section === "role"} onToggle={() => setSection(open => open === "role" ? null : "role")}>
              <View accessibilityRole="radiogroup" accessibilityLabel="What their agent can do">
                {AGENT_ROLES.map(t => {
                  const on = (managed.agentTier ?? 0) === t.tier;
                  // What the role comes with: its own daily limit, about what a day of it costs, and its agent's model.
                  const cost = roleCostLine(t.tier, directory?.roleLimits, directory?.roleCosts);
                  return <Pressable key={t.tier} testID={`tier-${t.tier}-${managed.id}`} accessibilityRole="radio" accessibilityState={{ checked: on, disabled: !!opening }} aria-checked={on} accessibilityLabel={`${t.label}: ${managed.name}`} accessibilityHint={[t.hint, cost].filter(Boolean).join(". ")}
                    disabled={!!opening} onPress={() => void setTier(managed, t.tier)} style={({ pressed }) => [styles.option, pressed && { backgroundColor: colors.surface }]}>
                    <View style={styles.optionCopy}>
                      <Text style={[styles.optionLabel, on && styles.optionOn]}>{t.label}</Text>
                      {t.hint ? <Text style={styles.optionHint}>{t.hint}</Text> : null}
                      {cost ? <Text testID={`tier-cost-${t.tier}`} style={styles.optionHint}>{unbroken(cost)}</Text> : null}
                    </View>
                    {on ? <AppIcon name="check" size={20} color={colors.blue} /> : null}
                  </Pressable>;
                })}
              </View>
            </SheetSection>
            {/* One list, like the roles: a limit and "no limit" can never both look chosen, and each row says what it means. */}
            {limitApplies(managed) ? <SheetSection title="Daily token limit" summary={limitSummary(managed, directory?.roleLimits, directory?.roleCosts)} open={section === "limit"} onToggle={() => setSection(open => open === "limit" ? null : "limit")}>
              <Text style={styles.sectionNote}>The most their agent can use in a day. It stops at the limit and starts again at midnight.</Text>
              <View accessibilityRole="radiogroup" accessibilityLabel="Daily token limit">
                {limitRows(managed, directory?.roleLimits, directory?.roleCosts).map(row => {
                  const on = chosenLimit(managed)?.key === row.key;
                  return <Pressable key={row.key} testID={`limit-${row.key}-${managed.id}`} accessibilityRole="radio" accessibilityState={{ checked: on, disabled: !!opening }} aria-checked={on}
                    accessibilityLabel={`${row.title}: ${managed.name}`} accessibilityHint={row.hint} disabled={!!opening}
                    onPress={() => void setLimit(managed, row)} style={({ pressed }) => [styles.option, pressed && { backgroundColor: colors.surface }]}>
                    <View style={styles.optionCopy}>
                      <Text style={[styles.optionLabel, on && styles.optionOn]}>{row.title}</Text>
                      {row.hint ? <Text style={styles.optionHint}>{row.hint}</Text> : null}
                    </View>
                    {on ? <AppIcon name="check" size={20} color={colors.blue} /> : null}
                  </Pressable>;
                })}
              </View>
              {/* What the dollar figures assume, once, under the amounts they sit beside. */}
              {costNote(directory?.roleCosts?.[String(managed.agentTier ?? 0)]) ? <Text testID="limit-cost-note" style={[styles.sectionNote, styles.sectionFootnote]}>{costNote(directory?.roleCosts?.[String(managed.agentTier ?? 0)])}</Text> : null}
            </SheetSection> : null}
            </ScrollView>
            <View style={styles.cardActions}>
              <Button testID={`remove-${managed.id}`} label="Remove" accessibilityLabel={`Remove ${managed.name}`} kind="danger" disabled={!!opening} onPress={() => askRemove(managed)} style={styles.done} />
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
  header: { minHeight: 60, paddingLeft: space.side, paddingRight: space.xs, paddingVertical: space.xs, flexDirection: "row", alignItems: "center", gap: space.xs },
  title: { ...typography.title, color: colors.ink, flexShrink: 1 },
  compose: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  titleRow: { flexShrink: 1, flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", columnGap: space.xs },
  count: { ...typography.caption, color: colors.muted },
  status: { ...typography.caption, marginLeft: "auto", color: colors.muted },
  error: { ...typography.caption, marginTop: space.xs, marginHorizontal: space.side, color: colors.red },
  // Rows measure the same as the Messages list: 40pt avatar, 72pt minimum, hairline between rows, 44pt trailing slot.
  rowWrap: { flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  row: { flex: 1, minWidth: 0, minHeight: 72, paddingLeft: space.side, paddingRight: space.xs, paddingVertical: space.sm, flexDirection: "row", alignItems: "center" },
  copy: { flex: 1, minWidth: 0, marginLeft: space.sm },
  name: { ...typography.body, color: colors.ink },
  you: { color: colors.muted },
  emailRow: { flexDirection: "row", alignItems: "center", gap: space.xxs, marginTop: space.xxs },
  // The mark keeps its size when a long address has to give way.
  emailMark: { flexShrink: 0 },
  emailText: { marginTop: 0, flexShrink: 1 },
  detail: { ...typography.caption, marginTop: space.xxs, color: colors.muted },
  online: { color: colors.blueDark },
  trailing: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  more: { marginRight: space.xs },
  // The person sheet: the same card as a project's access editor.
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: space.side, paddingVertical: space.lg, backgroundColor: colors.scrim },
  card: { width: "100%", maxWidth: 420, maxHeight: "100%", backgroundColor: colors.background, borderRadius: radius.lg, paddingVertical: space.side, overflow: "hidden" },
  cardScroll: { flexGrow: 0, flexShrink: 1 },
  cardHead: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.side, paddingBottom: space.sm },
  cardTitle: { ...typography.heading, color: colors.ink },
  cardError: { ...typography.caption, color: colors.red, marginHorizontal: space.side, marginBottom: space.sm },
  section: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  sectionHead: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.side, paddingVertical: space.xs },
  sectionTitle: { ...typography.bodyStrong, color: colors.ink },
  sectionNote: { ...typography.caption, color: colors.muted, paddingHorizontal: space.side, paddingBottom: space.xs },
  sectionFootnote: { paddingTop: space.xs },
  option: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.side, paddingVertical: space.xs },
  optionCopy: { flex: 1, minWidth: 0 },
  optionLabel: { ...typography.body, color: colors.ink },
  optionOn: { ...typography.bodyStrong },
  optionHint: { ...typography.caption, color: colors.muted },
  cardActions: { flexDirection: "row", gap: space.sm, paddingTop: space.md, paddingHorizontal: space.side, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  done: { flex: 1 },
  empty: { marginTop: space.xxl, paddingHorizontal: space.lg, alignItems: "center" },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center" },
  emptyAction: { marginTop: space.lg },
}));
