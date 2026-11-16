import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Redirect, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { Button, ButtonGroup } from "../../components/Button";
import { CaseActivity } from "../../components/CaseActivity";
import { CaseMessagePanel } from "../../components/CaseMessagePanel";
import { CaseOwnerPicker, type CasePerson } from "../../components/CaseOwnerPicker";
import { CaseTasks } from "../../components/CaseTasks";
import { ConversationKeyboardView } from "../../components/ConversationKeyboardView";
import { request, type Account, type Person } from "../../lib/server";
import { useSession } from "../../lib/session";
import { useWideLayout } from "../../lib/layout";
import { landingHref, useFeatures } from "../../lib/features";
import { createInboxClient, inboxContactConfirmed, inboxDueLabel, inboxOverdue, inboxReplyEmailLine, pollInbox, type InboxCase } from "../../lib/secure-inbox";
import { createThemedStyles, radius, space, typography, useTheme } from "../../lib/theme";

type CaseTab = "conversation" | "team" | "tasks" | "activity";
// The third tab is named for what the screen under it calls them: follow-ups.
const TABS: { id: CaseTab; label: string }[] = [{ id: "conversation", label: "Conversation" }, { id: "team", label: "Team" }, { id: "tasks", label: "Follow-ups" }, { id: "activity", label: "Activity" }];

export default function InboxConversationScreen() {
  const { account } = useSession();
  const features = useFeatures();
  const { id, tab } = useLocalSearchParams<{ id: string; tab?: string }>();
  if (!account) return null;
  if (!features.secureInbox) return <Redirect href={landingHref(features)} />;
  return <CaseWorkspace key={`${account.serverUrl}:${account.token}:${account.serverKey}:${id}`} account={account} id={String(id)} initialTab={tab === "tasks" ? "tasks" : "conversation"} />;
}

function CaseWorkspace({ account, id, initialTab }: { account: Account; id: string; initialTab: CaseTab }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const mobile = !useWideLayout();
  const { width } = useWindowDimensions();
  const columns = !mobile && width >= COLUMNS_MIN_WIDTH;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const writing = mobile && composing;
  const client = useMemo(() => createInboxClient((path, init) => request(account, path, init)), [account]);
  const [workspace, setWorkspace] = useState<InboxCase | null>(null);
  const [tab, setTab] = useState<CaseTab>(initialTab);
  const [people, setPeople] = useState<CasePerson[]>([{ id: account.user.id, name: account.user.name }]);
  const [peopleError, setPeopleError] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [updating, setUpdating] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt(value => value + 1), []);
  const actions = useRef(new AbortController());
  useEffect(() => { actions.current = new AbortController(); return () => actions.current.abort(); }, []);
  useFocusEffect(useCallback(() => {
    const controller = new AbortController();
    void request(account, "/v1/people", { signal: controller.signal }).then(response => response.json()).then((result: { people: Person[] }) => {
      if (controller.signal.aborted) return;
      setPeople(result.people.filter(person => !person.agent)); setPeopleError("");
    }).catch(cause => { if (!controller.signal.aborted) setPeopleError(cause instanceof Error ? cause.message : "Couldn't load teammates. Reopen this case to try again."); });
    return () => controller.abort();
  }, [account]));
  useFocusEffect(useCallback(() => pollInbox(async signal => {
    if ((AppState.currentState && AppState.currentState !== "active") || (Platform.OS === "web" && document.hidden)) return;
    const result = await client.case(id, signal);
    if (!signal.aborted) { setWorkspace(result); setLoadError(""); }
  }, cause => setLoadError(cause instanceof Error ? cause.message : "Couldn't load this case. Try again.")),
  // Saved work or a manual retry refreshes the case overview immediately.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [client, id, attempt]));

  const update = async (patch: { status?: "open" | "resolved"; assigneeId?: string | null }) => {
    if (updating) return;
    setUpdating(true); setError("");
    try { await client.update(id, patch, actions.current.signal); if (!actions.current.signal.aborted) refresh(); }
    catch (cause) { if (!actions.current.signal.aborted) setError(cause instanceof Error ? cause.message : "Couldn't update the case. Try again."); }
    finally { if (!actions.current.signal.aborted) setUpdating(false); }
  };
  const copyVisitorLink = async () => {
    if (copying) return;
    setCopying(true); setError("");
    try {
      const result = await client.visitorLink(id, actions.current.signal);
      if (actions.current.signal.aborted) return;
      if (!result.url) throw new Error("Visitor link unavailable. Ask an owner to configure a public HTTPS address for this server.");
      await Clipboard.setStringAsync(result.url); setCopied(true);
    } catch (cause) { if (!actions.current.signal.aborted) setError(cause instanceof Error ? cause.message : "Couldn't copy the visitor link. Try again."); }
    finally { if (!actions.current.signal.aborted) setCopying(false); }
  };

  if (!workspace) return <View style={styles.center}>{loadError ? <><Text accessibilityRole="alert" style={styles.error}>{loadError}</Text><Button label="Try again" kind="secondary" onPress={refresh} /></> : <ActivityIndicator accessibilityLabel="Loading case" color={colors.blue} />}</View>;
  const conversation = workspace.conversation;
  const next = workspace.nextAction;
  const open = conversation.status === "open";
  const mine = conversation.assigneeId === account.user.id;
  const status = <View style={[styles.status, open && styles.openStatus]}><Text style={styles.statusText}>{open ? "Open" : "Resolved"}</Text></View>;
  // Who it is and what it is about, who owns it, what happens next, and how the visitor gets back in. Beside the
  // conversation when the window has room for both; one press away when it does not.
  const details = (
    <View style={styles.details}>
      <View style={styles.block}>
        <View style={styles.personRow}><Text style={styles.personName}>{conversation.name}</Text>{status}</View>
        <Text style={styles.subject}>{conversation.subject}</Text>
        <Text selectable style={styles.reference}>{workspace.reference}</Text>
      </View>
      <View style={styles.block}>
        <CaseOwnerPicker label="Case owner" value={conversation.assigneeId} people={people} error={peopleError} disabled={updating} onChange={assigneeId => void update({ assigneeId })} />
        <ButtonGroup align="between">
          <Button compact kind="link" label={mine ? "Unassign" : "Assign to me"} disabled={updating} onPress={() => void update({ assigneeId: mine ? null : account.user.id })} style={styles.edgeLink} />
          <Button compact kind="secondary" label={open ? "Resolve" : "Reopen"} accessibilityLabel={open ? "Resolve conversation" : "Reopen conversation"} disabled={updating} onPress={() => void update({ status: open ? "resolved" : "open" })} />
        </ButtonGroup>
      </View>
      <View style={styles.block}>
        <Text style={styles.label}>Next action</Text>
        {next ? <><Text numberOfLines={2} style={styles.nextText}>{next.text}</Text><Text style={styles.caption}>{next.assigneeName || "Unassigned"} · <Text style={inboxOverdue(next.dueDate) ? styles.overdue : undefined}>{inboxDueLabel(next.dueDate)}</Text></Text></> : <Text style={styles.caption}>No open follow-ups</Text>}
        <Button label={next ? "View follow-ups" : "Add first follow-up"} compact kind="link" onPress={() => { setDetailsOpen(false); setTab("tasks"); }} style={styles.edgeLink} />
      </View>
      <View style={styles.block}>
        <Text style={styles.label}>Visitor</Text>
        <Text selectable style={styles.caption}>{conversation.email ? `${conversation.email} · ${inboxContactConfirmed(conversation.email, workspace.notify) ? "Confirmed" : "Unverified"}` : "No contact email"}</Text>
        <Text selectable style={styles.caption}>{inboxReplyEmailLine(workspace.notify)}</Text>
        <Text style={styles.meta}>Share the visitor link only with the person for this case. Anyone with the link can read and reply.</Text>
        <Button label={copied ? "Visitor link copied" : "Copy visitor link"} accessibilityLabel="Copy visitor link" compact kind="link" busy={copying} onPress={() => void copyVisitorLink()} style={styles.edgeLink} />
      </View>
      {error || loadError ? <Text accessibilityRole="alert" style={styles.error}>{error || loadError}</Text> : null}
    </View>
  );
  return <ConversationKeyboardView><View style={[styles.root, columns && styles.rootColumns]}>
    <Stack.Screen options={{ title: columns ? `${workspace.reference} · ${conversation.subject}` : workspace.reference }} />
    <View style={styles.columns}>
      <View style={styles.main}>
        {/* Without the side panel, the subject and the person stay in view above the tabs; the rest is under Details. */}
        {!columns && !writing ? <View style={styles.compactHeader}>
          <View style={styles.compactCopy}><Text style={styles.compactSubject}>{conversation.subject}</Text><Text style={styles.caption}>{conversation.name} · {open ? "Open" : "Resolved"}</Text></View>
          <Button label="Details" accessibilityLabel="Case details" kind="link" compact onPress={() => setDetailsOpen(true)} />
        </View> : null}

        {!writing ? <View style={styles.tabsRow}><View accessibilityRole="tablist" style={styles.tabs}>{TABS.map(item => <Pressable key={item.id} accessibilityRole="tab" accessibilityLabel={item.label} accessibilityState={{ selected: tab === item.id }} aria-selected={tab === item.id} onPress={() => setTab(item.id)} style={[styles.tab, tab === item.id && styles.tabOn]}><Text style={[styles.tabText, tab === item.id && styles.tabTextOn]}>{item.label}{item.id === "tasks" && workspace.openTaskCount ? ` · ${workspace.openTaskCount}` : ""}</Text></Pressable>)}</View></View> : null}

        <CaseMessagePanel key="public-replies" client={client} id={id} audience="conversation" visitorName={conversation.name} active={tab === "conversation"} compact={mobile} onFocusChange={setComposing} onChanged={refresh} />
        <CaseMessagePanel key="private-team-notes" client={client} id={id} audience="team" visitorName={conversation.name} active={tab === "team"} compact={mobile} onFocusChange={setComposing} onChanged={refresh} />
        <CaseTasks client={client} id={id} tasks={workspace.tasks} people={people} peopleError={peopleError} active={tab === "tasks"} onChanged={refresh} />
        <CaseActivity client={client} id={id} active={tab === "activity"} />
      </View>
      {columns ? <ScrollView style={styles.side} contentContainerStyle={styles.sideContent} keyboardShouldPersistTaps="handled">{details}</ScrollView> : null}
    </View>
    {!columns && detailsOpen ? <Modal visible transparent animationType="fade" onRequestClose={() => setDetailsOpen(false)}>
      <View style={styles.scrim}><View style={styles.dialog} accessibilityViewIsModal>
        <ScrollView contentContainerStyle={styles.dialogContent} keyboardShouldPersistTaps="handled"><Text accessibilityRole="header" style={styles.dialogTitle}>Case details</Text>{details}</ScrollView>
        <Button label="Done" accessibilityLabel="Close case details" kind="secondary" onPress={() => setDetailsOpen(false)} style={styles.closeDetails} />
      </View></View>
    </Modal> : null}
  </View></ConversationKeyboardView>;
}

/** The window width from which the case's details sit beside the conversation instead of behind Details. */
const COLUMNS_MIN_WIDTH = 1100;

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, minHeight: 0, backgroundColor: colors.background, width: "100%", maxWidth: 800, alignSelf: "center" },
  rootColumns: { maxWidth: 1120 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.lg, gap: space.md },
  columns: { flex: 1, minHeight: 0, flexDirection: "row" },
  main: { flex: 1, minWidth: 0, minHeight: 0 },
  // The same 320-point panel a channel's Details uses.
  side: { flexGrow: 0, flexShrink: 0, flexBasis: 320, width: 320, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line },
  sideContent: { paddingVertical: space.md },
  compactHeader: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingLeft: space.side, paddingTop: space.xs },
  compactCopy: { flex: 1, minWidth: 0 },
  compactSubject: { ...typography.bodyStrong, color: colors.ink },
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", padding: space.md, backgroundColor: colors.scrim },
  dialog: { width: "100%", maxWidth: 520, maxHeight: "90%", backgroundColor: colors.background, borderRadius: radius.lg },
  dialogContent: { paddingTop: space.md },
  dialogTitle: { ...typography.heading, color: colors.ink, paddingHorizontal: space.side, paddingBottom: space.xs },
  closeDetails: { margin: space.md },
  details: { paddingHorizontal: space.side, gap: space.md },
  block: { gap: space.xxs },
  personRow: { flexDirection: "row", alignItems: "center", gap: space.xs },
  personName: { ...typography.heading, color: colors.ink, flexShrink: 1 },
  subject: { ...typography.body, color: colors.ink },
  reference: { ...typography.caption, color: colors.muted },
  caption: { ...typography.caption, color: colors.muted },
  meta: { ...typography.meta, color: colors.muted },
  label: { ...typography.label, color: colors.muted },
  nextText: { ...typography.body, color: colors.ink },
  overdue: { color: colors.red },
  // A link's words line up with the text above it, not with a button's padding.
  edgeLink: { alignSelf: "flex-start", marginLeft: -space.md },
  status: { backgroundColor: colors.surface, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: space.xxs },
  openStatus: { backgroundColor: colors.blueSoft },
  statusText: { ...typography.captionStrong, color: colors.ink },
  // The same segmented tabs as Saved and a project, sized by their words so four fit a phone.
  tabsRow: { paddingHorizontal: space.side, paddingVertical: space.xs },
  tabs: { flexDirection: "row", backgroundColor: colors.surface, borderRadius: radius.pill, padding: 3, width: "100%", maxWidth: 520 },
  tab: { flexGrow: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, paddingHorizontal: space.xs },
  tabOn: { backgroundColor: colors.background, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  tabText: { ...typography.captionStrong, color: colors.muted },
  tabTextOn: { color: colors.ink },
  error: { ...typography.caption, color: colors.red },
}));
