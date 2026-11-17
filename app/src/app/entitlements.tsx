import { useCallback, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { BallRefreshControl } from "../components/BallRefreshControl";
import { useFocusEffect } from "expo-router";
import { Button } from "../components/Button";
import { CheckBox } from "../components/CheckBox";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { api, ServerError, type Entitlement, type EntitlementsPage, type EntitlementStanding } from "../lib/server";
import { useSession } from "../lib/session";
import { askLabel, canAsk, checksLine, holders, hostsLine, parseHosts, refusedLine, requestLine, standingLine, waitingOnYou } from "../lib/entitlements";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

// Entitlements (docs/entitlements.md): the named access a person's agent may use. Everyone sees the list and asks
// for what they already have themselves; a manager answers their reports' requests; an owner makes and retires them.
type Draft = { id: string | null; native?: boolean; name: string; description: string; hosts: string; confirmation: string };
type Danger = { kind: "revoke"; entitlement: Entitlement; person: EntitlementStanding } | { kind: "retire"; entitlement: Entitlement };

export default function EntitlementsScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const [page, setPage] = useState<EntitlementsPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // What is being worked on right now, so one tap can't fire twice: "<entitlement id>:<person id or action>".
  const [busy, setBusy] = useState<string | null>(null);
  // Asking: the entitlement, whether the confirmation is ticked, and the optional note.
  const [asking, setAsking] = useState<Entitlement | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const [askError, setAskError] = useState<string | null>(null);
  // Owners: making or changing an entitlement.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [danger, setDanger] = useState<Danger | null>(null);
  const [dangerError, setDangerError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!account) return;
    try { setPage(await api.entitlements(account)); setError(null); }
    catch (e) { setError(e instanceof ServerError ? e.message : "Couldn't load entitlements. Pull down to try again"); }
  }, [account]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  if (!account) return null;

  const replace = (entitlement: Entitlement) => setPage(p => p && { ...p, entitlements: p.entitlements.map(e => e.id === entitlement.id ? entitlement : e) });
  const failed = (e: unknown, fallback: string) => e instanceof ServerError ? e.message : fallback;

  const ask = async () => {
    if (!asking || busy) return;
    if (!confirmed) { setAskError("Tick the box to confirm before you ask"); return; }
    setBusy(`${asking.id}:ask`); setAskError(null);
    try {
      const { entitlement } = await api.askForEntitlement(account, asking.id, note.trim());
      replace(entitlement);
      setAsking(null);
    } catch (e) { setAskError(failed(e, "Couldn't send your request. Try again")); }
    finally { setBusy(null); }
  };
  const decide = async (entitlement: Entitlement, person: EntitlementStanding, decision: "grant" | "once" | "deny") => {
    if (busy) return;
    setBusy(`${entitlement.id}:${person.userId}:${decision}`); setError(null);
    try {
      replace((await api.decideEntitlement(account, entitlement.id, person.userId, decision)).entitlement);
      setPage(p => p && { ...p, waiting: Math.max(0, p.waiting - 1) });
    } catch (e) { setError(failed(e, "Couldn't save that decision. Try again")); }
    finally { setBusy(null); }
  };
  const confirmDanger = async () => {
    if (!danger || busy) return;
    setBusy("danger"); setDangerError(null);
    try {
      if (danger.kind === "revoke") replace((await api.decideEntitlement(account, danger.entitlement.id, danger.person.userId, "revoke")).entitlement);
      else { await api.retireEntitlement(account, danger.entitlement.id); setPage(p => p && { ...p, entitlements: p.entitlements.filter(e => e.id !== danger.entitlement.id) }); }
      setDanger(null);
    } catch (e) { setDangerError(failed(e, danger.kind === "revoke" ? "Couldn't take it back. Try again" : "Couldn't retire it. Try again")); }
    finally { setBusy(null); }
  };
  const save = async () => {
    if (!draft || busy) return;
    const body = { name: draft.name.trim(), description: draft.description.trim(), hosts: parseHosts(draft.hosts), confirmation: draft.confirmation.trim() };
    if (!body.name) { setDraftError("Give the entitlement a name"); return; }
    setBusy("draft"); setDraftError(null);
    try {
      if (draft.id) replace((await api.updateEntitlement(account, draft.id, body)).entitlement);
      else { const { entitlement } = await api.createEntitlement(account, body); setPage(p => p && { ...p, entitlements: [...p.entitlements, entitlement].sort((a, b) => a.name.localeCompare(b.name)) }); }
      setDraft(null);
    } catch (e) { setDraftError(failed(e, "Couldn't save the entitlement. Try again")); }
    finally { setBusy(null); }
  };
  const openAsk = (entitlement: Entitlement) => { setConfirmed(false); setNote(""); setAskError(null); setAsking(entitlement); };
  const openDraft = (entitlement?: Entitlement) => {
    setDraftError(null);
    setDraft(entitlement ? { id: entitlement.id, native: entitlement.native, name: entitlement.name, description: entitlement.description, hosts: entitlement.hosts.join("\n"), confirmation: entitlement.confirmation } : { id: null, name: "", description: "", hosts: "", confirmation: "" });
  };

  const owner = !!page?.canCreate;
  const waiting = page ? waitingOnYou(page.entitlements) : [];
  const managerName = page?.manager?.name ?? null;

  return <View style={styles.root}>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
      refreshControl={<BallRefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); try { await load(); } finally { setRefreshing(false); } }} />}>
      <Text style={styles.intro}>What your agent may reach for you. Ask for what you already have access to yourself{owner ? "." : managerName ? `; ${managerName} decides.` : "; an owner decides."}</Text>
      {/* Owners are told plainly whether any of this is being enforced. */}
      {owner && page ? <Text testID="gate-state" style={styles.note}>{page.egress.mode === "ask"
        ? "The network gate is on: an agent reaches a host only through an entitlement its person holds."
        : "The network gate is off, so nothing is blocked yet. Entitlements are a record of who asked for and was given what until it is turned on."}</Text> : null}
      {owner && page ? <Text testID="checks-state" style={styles.note}>{checksLine(page.capabilities?.mode)}</Text> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {!page && !error ? <ActivityIndicator color={colors.blue} style={styles.spinner} /> : null}

      {waiting.length ? <View>
        <Text accessibilityRole="header" style={styles.section}>{`Waiting on you (${waiting.length})`}</Text>
        <View style={styles.list}>
          {waiting.map(({ entitlement, request }) => <View key={`${entitlement.id}:${request.userId}`} testID={`request-${entitlement.id}-${request.userId}`} style={styles.row}>
            <Text style={styles.name}>{requestLine(request, entitlement)}</Text>
            {request.note ? <Text style={styles.meta}>{`"${request.note}"`}</Text> : null}
            {/* Asked by the agent trying: what it was about to do. Asked by the person: the words they confirmed. */}
            {request.via === "use"
              ? request.detail ? <Text testID={`detail-${entitlement.id}-${request.userId}`} style={styles.body}>{request.detail}</Text> : null
              : <Text style={styles.meta}>{`They confirmed: ${entitlement.confirmation}`}</Text>}
            <View style={styles.actions}>
              {/* A built-in entitlement can be allowed for this one action, or from now on. */}
              {entitlement.native ? <Button testID={`once-${entitlement.id}-${request.userId}`} label="Allow once" accessibilityLabel={`Allow ${entitlement.name} once for ${request.name}`} compact busy={busy === `${entitlement.id}:${request.userId}:once`} disabled={!!busy} onPress={() => void decide(entitlement, request, "once")} /> : null}
              <Button testID={`grant-${entitlement.id}-${request.userId}`} label={entitlement.native ? "Allow always" : "Grant"} accessibilityLabel={entitlement.native ? `Always allow ${entitlement.name} for ${request.name}` : `Grant ${entitlement.name} to ${request.name}`} kind={entitlement.native ? "secondary" : "primary"} compact busy={busy === `${entitlement.id}:${request.userId}:grant`} disabled={!!busy} onPress={() => void decide(entitlement, request, "grant")} />
              <Button testID={`deny-${entitlement.id}-${request.userId}`} label="Decline" accessibilityLabel={`Decline ${request.name}'s request for ${entitlement.name}`} kind="secondary" compact busy={busy === `${entitlement.id}:${request.userId}:deny`} disabled={!!busy} onPress={() => void decide(entitlement, request, "deny")} />
            </View>
          </View>)}
        </View>
      </View> : null}

      {page ? <View>
        <Text accessibilityRole="header" style={styles.section}>Entitlements</Text>
        {page.entitlements.every(e => e.native) ? <Text testID="none-of-your-own" style={styles.empty}>{owner ? "Four are built in. Make one for each other system your team's agents should reach." : "Four are built in. An owner makes the others."}</Text> : null}
        <View style={page.entitlements.length ? styles.list : null}>
          {page.entitlements.map(entitlement => {
            const standing = standingLine(entitlement.mine, managerName);
            const held = holders(entitlement);
            return <View key={entitlement.id} testID={`entitlement-${entitlement.id}`} style={styles.row}>
              <Text style={styles.name}>{entitlement.name}{entitlement.native ? <Text style={styles.builtIn}> · Built in</Text> : null}</Text>
              {entitlement.description ? <Text style={styles.body}>{entitlement.description}</Text> : null}
              {/* The filesystem pair opens no hosts and never will: saying so would only puzzle. */}
              {entitlement.native && !entitlement.hosts.length ? null : <Text style={styles.meta}>{hostsLine(entitlement.hosts)}</Text>}
              {standing ? <Text testID={`standing-${entitlement.id}`} style={[styles.standing, entitlement.mine?.status === "granted" && styles.granted]}>{standing}</Text> : null}
              {/* The people you decide for who hold it, each with a way to take it back. */}
              {held.map(person => <View key={person.userId} style={styles.holder}>
                <Text style={styles.holderName}>{`${person.name} has this`}</Text>
                <Button testID={`revoke-${entitlement.id}-${person.userId}`} label="Take back" accessibilityLabel={`Take ${entitlement.name} back from ${person.name}`} kind="danger" compact disabled={!!busy} onPress={() => { setDangerError(null); setDanger({ kind: "revoke", entitlement, person }); }} />
              </View>)}
              <View style={styles.actions}>
                {canAsk(entitlement.mine) ? <Button testID={`ask-${entitlement.id}`} label={askLabel(entitlement.mine)} accessibilityLabel={`${askLabel(entitlement.mine)}: ${entitlement.name}`} kind="secondary" compact disabled={!!busy} onPress={() => openAsk(entitlement)} /> : null}
                {owner ? <Button testID={`edit-${entitlement.id}`} label="Edit" accessibilityLabel={`Edit ${entitlement.name}`} kind="secondary" compact disabled={!!busy} onPress={() => openDraft(entitlement)} /> : null}
                {owner && !entitlement.native ? <Button testID={`retire-${entitlement.id}`} label="Retire" accessibilityLabel={`Retire ${entitlement.name}`} kind="danger" compact disabled={!!busy} onPress={() => { setDangerError(null); setDanger({ kind: "retire", entitlement }); }} /> : null}
              </View>
            </View>;
          })}
        </View>
        {owner ? <Button testID="new-entitlement" label="New entitlement" onPress={() => openDraft()} style={styles.add} /> : null}
      </View> : null}

      {/* Owners: what agents were refused lately, so a missing entitlement or host shows up here. */}
      {owner && page?.egress.refused?.length ? <View>
        <Text accessibilityRole="header" style={styles.section}>Recently refused</Text>
        <View style={styles.list}>
          {page.egress.refused.map(r => <View key={`${r.userId}:${r.host}`} style={styles.row}><Text style={styles.body}>{refusedLine(r)}</Text></View>)}
        </View>
      </View> : null}
    </ScrollView>

    <Modal visible={!!asking} transparent animationType="fade" onRequestClose={() => setAsking(null)}>
      <View style={styles.scrim}>
        {asking ? <View accessibilityViewIsModal style={styles.dialog}>
          <Text accessibilityRole="header" style={styles.title}>{`Ask for ${asking.name}`}</Text>
          <Text style={styles.body}>{hostsLine(asking.hosts)}</Text>
          <Pressable testID="ask-confirm" accessibilityRole="checkbox" accessibilityState={{ checked: confirmed }} aria-checked={confirmed} accessibilityLabel={asking.confirmation}
            onPress={() => { setConfirmed(v => !v); setAskError(null); }} style={({ pressed }) => [styles.confirm, pressed && { backgroundColor: colors.surface }]}>
            <CheckBox on={confirmed} />
            <Text style={styles.confirmText}>{asking.confirmation}</Text>
          </Pressable>
          <Text style={styles.label}>Note (optional)</Text>
          <TextInput testID="ask-note" accessibilityLabel="Note" value={note} onChangeText={setNote} maxLength={500} multiline editable={!busy} placeholder="Why you need it" placeholderTextColor={colors.muted} style={[styles.input, styles.multiline]} />
          {askError ? <Text accessibilityRole="alert" style={styles.error}>{askError}</Text> : null}
          <Button testID="ask-send" label="Ask" busy={busy === `${asking.id}:ask`} onPress={() => void ask()} />
          <Button label="Cancel" kind="secondary" disabled={!!busy} onPress={() => setAsking(null)} />
        </View> : null}
      </View>
    </Modal>

    <Modal visible={!!draft} transparent animationType="fade" onRequestClose={() => setDraft(null)}>
      <View style={styles.scrim}>
        {draft ? <View accessibilityViewIsModal style={styles.dialog}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
            <Text accessibilityRole="header" style={styles.title}>{draft.id ? "Edit entitlement" : "New entitlement"}</Text>
            <Text style={styles.label}>{draft.native ? "Name (built in, can't be changed)" : "Name"}</Text>
            <TextInput testID="draft-name" accessibilityLabel="Name" value={draft.name} onChangeText={name => setDraft(d => d && { ...d, name })} maxLength={60} editable={!busy && !draft.native} placeholder="GitHub" placeholderTextColor={colors.muted} style={styles.input} />
            <Text style={styles.label}>Description</Text>
            <TextInput testID="draft-description" accessibilityLabel="Description" value={draft.description} onChangeText={description => setDraft(d => d && { ...d, description })} maxLength={300} editable={!busy} placeholder="What it is for" placeholderTextColor={colors.muted} style={styles.input} />
            <Text style={styles.label}>Hosts, one per line</Text>
            <TextInput testID="draft-hosts" accessibilityLabel="Hosts" value={draft.hosts} onChangeText={hosts => setDraft(d => d && { ...d, hosts })} multiline editable={!busy} autoCapitalize="none" autoCorrect={false} placeholder={"github.com\n*.github.com"} placeholderTextColor={colors.muted} style={[styles.input, styles.multiline]} />
            <Text style={styles.meta}>The names an agent may reach for someone who holds this. *.example.gov covers every name under example.gov.</Text>
            <Text style={styles.label}>What people confirm when they ask (optional)</Text>
            <TextInput testID="draft-confirmation" accessibilityLabel="Confirmation" value={draft.confirmation} onChangeText={confirmation => setDraft(d => d && { ...d, confirmation })} maxLength={500} multiline editable={!busy} placeholder="I already have this access myself, under my own name…" placeholderTextColor={colors.muted} style={[styles.input, styles.multiline]} />
            {draftError ? <Text accessibilityRole="alert" style={styles.error}>{draftError}</Text> : null}
            <Button testID="draft-save" label="Save" busy={busy === "draft"} onPress={() => void save()} />
            <Button label="Cancel" kind="secondary" disabled={!!busy} onPress={() => setDraft(null)} />
          </ScrollView>
        </View> : null}
      </View>
    </Modal>

    <ConfirmDialog visible={!!danger}
      title={danger ? danger.kind === "revoke" ? `Take ${danger.entitlement.name} back from ${danger.person.name}?` : `Retire ${danger.entitlement.name}?` : ""}
      description={danger?.kind === "revoke" ? "Their agent stops reaching its hosts right away. They can ask again." : "Nobody can ask for it any more and it stops opening anything for everyone who holds it. Its history is kept."}
      confirmLabel={danger?.kind === "revoke" ? "Take back" : "Retire"} busy={busy === "danger"} error={dangerError}
      onCancel={() => { setDanger(null); setDangerError(null); }} onConfirm={() => void confirmDanger()} />
  </View>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 720, alignSelf: "center" },
  intro: { ...typography.body, color: colors.muted, marginBottom: space.sm },
  note: { ...typography.caption, color: colors.muted, marginBottom: space.sm },
  error: { ...typography.caption, color: colors.red, marginBottom: space.sm },
  spinner: { marginVertical: space.lg },
  empty: { ...typography.body, color: colors.muted, marginVertical: space.md },
  section: { ...typography.label, color: colors.muted, marginTop: space.md, marginBottom: space.xs },
  list: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  row: { paddingVertical: space.sm, gap: space.xxs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  name: { ...typography.bodyStrong, color: colors.ink },
  builtIn: { ...typography.caption, color: colors.muted },
  body: { ...typography.body, color: colors.ink },
  meta: { ...typography.caption, color: colors.muted },
  standing: { ...typography.caption, color: colors.muted },
  granted: { color: colors.blueDark },
  holder: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm, marginTop: space.xs },
  holderName: { ...typography.body, color: colors.ink, flex: 1, minWidth: 0 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.xs },
  add: { marginTop: space.md, alignSelf: "flex-start" },
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", padding: space.lg, backgroundColor: colors.scrim },
  dialog: { width: "100%", maxWidth: 440, maxHeight: "100%", padding: space.lg, gap: space.sm, backgroundColor: colors.background, borderRadius: radius.lg },
  form: { gap: space.sm },
  title: { ...typography.heading, color: colors.ink },
  label: { ...typography.label, color: colors.muted },
  input: controls.input,
  multiline: { minHeight: 72, textAlignVertical: "top" },
  confirm: { minHeight: 44, flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: space.xs, borderRadius: radius.md },
  confirmText: { ...typography.body, color: colors.ink, flex: 1, minWidth: 0 },
}));
