import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Button, ButtonGroup, IconButton } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Avatar } from "../components/Messaging";
import { AppIcon } from "../components/AppIcon";
import { api, ServerError, type Conversation, type Person } from "../lib/server";
import { useLiveActions } from "../lib/live";
import { useSession } from "../lib/session";
import { landingHref, useFeatures } from "../lib/features";
import { radius, space, typography, useTheme, createThemedStyles, linkUnderline } from "../lib/theme";

export default function ChannelInfo() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ChannelDetails id={id} />;
}

/** Channel details: a page on phones, a panel beside the channel on wide screens. */
export function ChannelDetails({ id, panel = false, onClose }: { id: string; panel?: boolean; onClose?: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const { refresh } = useLiveActions();
  const landing = landingHref(useFeatures());
  const [conv, setConv] = useState<Conversation | null>(null);
  const [everyone, setEveryone] = useState<Person[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(() => {
    if (!account) return Promise.resolve();
    return Promise.all([api.conversation(account, id), api.people(account)])
      .then(([c, p]) => {
        setConv(c.conversation);
        setEveryone(p.people);
        setError(null);
      })
      .catch((e) => {
        setError(e instanceof ServerError ? e.message : "Couldn't load the channel");
      });
  }, [account, id]);
  useEffect(() => {
    load();
  }, [load]);

  if (!account || !conv) return <View style={[styles.root, styles.loading]}>{error ? <>
    <Text accessibilityRole="alert" style={styles.loadError}>{error}</Text>
    <Button label="Try again" kind="secondary" busy={retrying} onPress={() => { setRetrying(true); void load().finally(() => setRetrying(false)); }} />
  </> : <ActivityIndicator accessibilityLabel="Loading channel details" color={colors.blue} />}</View>;
  const memberIds = new Set((conv.members ?? []).map((m) => m.id));
  const notIn = everyone.filter((p) => !memberIds.has(p.id));

  const add = async (p: Person) => {
    if (addingId) return;
    setAddingId(p.id);
    setError(null);
    try {
      await api.addMembers(account, id, [p.id]);
      await load();
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't add this member. Try again.");
    } finally {
      setAddingId(null);
    }
  };
  const message = async (person: Person) => {
    if (opening || person.id === account.user.id) return;
    setOpening(person.id);
    setError(null);
    try {
      const conversation = await api.openDm(account, [person.id]);
      router.push({ pathname: "/c/[id]", params: { id: conversation.id, compose: "1" } });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't open the conversation. Try again");
    } finally {
      setOpening(null);
    }
  };
  const leave = async () => {
    if (leaving) return;
    setLeaving(true);
    setError(null);
    try {
      await api.leave(account, id);
      refresh();
      router.dismissTo(landing);
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't leave the channel. Try again.");
    } finally {
      setLeaving(false);
    }
  };

  return (
    <View testID={panel ? "details-panel" : undefined} style={[styles.root, panel && styles.panel]}>
    {panel ? <View style={styles.panelBar}>
      <Text accessibilityRole="header" style={styles.panelTitle}>Details</Text>
      {onClose ? <IconButton icon="close" label="Hide details" edge="end" onPress={onClose} /> : null}
    </View> : null}
    <ScrollView style={styles.root} contentContainerStyle={[styles.content, panel && styles.panelContent]} keyboardShouldPersistTaps="handled">
      <View style={styles.identity}>
        <View style={styles.channelIcon}><AppIcon name={conv.private ? "lock" : "hash"} size={23} color={colors.ink} /></View>
        <Text accessibilityRole="header" style={styles.title}>{conv.title}</Text>
      </View>
      <Text style={styles.sub}>
        {conv.archived ? "Archived · " : ""}{conv.private ? "Private channel" : "Public channel"} · {conv.memberCount} {conv.memberCount === 1 ? "member" : "members"}
      </Text>

      {error && !confirmingLeave ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}

      <View style={styles.sectionRow}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>{adding ? "Add members" : "Members"}</Text>
        {notIn.length || adding ? (
          <Button label={adding ? "Done" : "Add people"} compact kind="link" onPress={() => setAdding((a) => !a)} />
        ) : null}
      </View>
      {adding && !notIn.length ? <Text style={styles.addHelper}>Everyone is already a member</Text> : null}
      {adding
        ? notIn.map((p) => (
            <Pressable key={p.id} accessibilityRole="button" accessibilityLabel={`Add ${p.name}`} accessibilityState={{ disabled: !!addingId, busy: addingId === p.id }} disabled={!!addingId} onPress={() => add(p)} style={({ pressed }) => [styles.person, pressed && { backgroundColor: colors.surface }]}>
              <Avatar name={p.name} userId={p.id} size={32} />
              <Text style={styles.personName}>{p.name}</Text>
              {addingId === p.id ? <ActivityIndicator color={colors.blue} /> : <Text style={styles.link}>Add</Text>}
            </Pressable>
          ))
        : (conv.members ?? []).map((p) => (
            <Pressable
              key={p.id}
              accessibilityRole={p.id === account.user.id ? undefined : "button"}
              accessibilityLabel={`${p.name}${p.id === account.user.id ? ", you" : ""}`}
              accessibilityHint={p.id === account.user.id ? undefined : "Open direct message"}
              disabled={p.id === account.user.id || !!opening}
              onPress={() => void message(p)}
              style={({ pressed }) => [styles.person, pressed && { backgroundColor: colors.surface }]}
            >
              <Avatar name={p.name} userId={p.id} size={32} />
              <Text style={styles.personName}>
                {p.name}
                {p.id === account.user.id ? " (you)" : ""}
              </Text>
              {opening === p.id ? <ActivityIndicator color={colors.blue} /> : p.id !== account.user.id ? <AppIcon name="chat" size={17} color={colors.muted} /> : null}
            </Pressable>
          ))}

      {conv.name !== "general" ? <View style={styles.leaveSection}>
        <ButtonGroup><Button label="Leave channel" kind="danger" compact onPress={() => { setError(null); setConfirmingLeave(true); }} /></ButtonGroup>
      </View> : null}
    </ScrollView>
    <ConfirmDialog visible={confirmingLeave} title={`Leave #${conv.title}?`} description={conv.private ? "You'll need someone to add you back to this private channel." : "You can find and join it again from Home."} confirmLabel="Leave channel" onConfirm={() => void leave()} onCancel={() => setConfirmingLeave(false)} busy={leaving} error={error} />
    </View>
  );
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  // Beside the channel on wide screens: a fixed-width column with its own title bar.
  panel: { flex: 0, flexGrow: 0, flexShrink: 0, flexBasis: 320, width: 320, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line },
  panelBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 52, paddingHorizontal: space.side, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  panelTitle: { ...typography.bodyStrong, color: colors.ink },
  panelContent: { maxWidth: undefined, paddingTop: space.md },
  content: { padding: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 680, alignSelf: "center" },
  loading: { padding: space.lg, alignItems: "center", justifyContent: "center", gap: space.lg },
  loadError: { ...typography.body, color: colors.red, textAlign: "center" },
  identity: { flexDirection: "row", alignItems: "center", gap: space.sm },
  channelIcon: { width: 40, height: 40, borderRadius: radius.sm, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  title: { ...typography.title, color: colors.ink, flex: 1 },
  sub: { ...typography.caption, marginTop: space.xs, color: colors.muted },
  label: { ...typography.label, marginTop: space.lg, marginBottom: space.xs, color: colors.ink },
  helper: { ...typography.caption, color: colors.muted, marginBottom: space.sm },
  error: { ...typography.caption, marginTop: space.sm, color: colors.red },
  sectionRow: { marginTop: space.lg, marginBottom: space.xs, flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: space.xs },
  sectionTitle: { ...typography.label, color: colors.ink },
  addHelper: { ...typography.caption, color: colors.muted, marginBottom: space.sm },
  link: { ...typography.captionStrong, color: colors.blue, ...linkUnderline },
  person: { minHeight: 56, paddingVertical: space.xs, flexDirection: "row", alignItems: "center" },
  personName: { ...typography.body, flex: 1, minWidth: 0, marginLeft: space.sm, marginRight: space.xs, color: colors.ink },
  leaveSection: { marginTop: space.xl, paddingTop: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
}));
