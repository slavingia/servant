import { useCallback, useState } from "react";
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { BallRefreshControl } from "../components/BallRefreshControl";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ConnectionCard } from "../components/ConnectionCard";
import { api, ServerError } from "../lib/server";
import { useSession } from "../lib/session";
import { NO_AGENT_LINE, RESTRICTED_LINE, standingLine, timesLine, type ConnectionsPage } from "../lib/connections";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

// Connections (docs/connections.md): your own logins for the tools your agent works with, so it acts as you, with
// only your access. Each tool shows whether it is connected, the last four characters, when it was saved and last
// used. A saved value is never shown again, here or anywhere, to you or to an owner.
type Tool = ConnectionsPage["tools"][number];

export default function ConnectionsScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const [page, setPage] = useState<ConnectionsPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  // When the list was last read: the dates beside each tool are written against it.
  const [loadedAt, setLoadedAt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // The tool whose form is open, and the one about to be removed.
  const [connecting, setConnecting] = useState<Tool | null>(null);
  const [removing, setRemoving] = useState<Tool | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!account) return;
    try { setPage(await api.connections(account)); setLoadedAt(Date.now()); setError(null); }
    catch (e) { setError(e instanceof ServerError ? e.message : "Couldn't load your connections. Pull down to try again"); }
  }, [account]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  if (!account) return null;

  const replace = (tool: Tool) => setPage(p => p && { ...p, tools: p.tools.map(t => t.id === tool.id ? tool : t) });
  const remove = async () => {
    if (!removing || removeBusy) return;
    setRemoveBusy(true); setRemoveError(null);
    try { replace((await api.removeConnection(account, removing.id)).tool); setRemoving(null); }
    catch (e) { setRemoveError(e instanceof ServerError ? e.message : `Couldn't remove your ${removing.name} token. Try again`); }
    finally { setRemoveBusy(false); }
  };
  const full = page?.agent === "full";

  return <View style={styles.root}>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
      refreshControl={<BallRefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); try { await load(); } finally { setRefreshing(false); } }} />}>
      <Text style={styles.intro}>Your own logins for the tools your agent works with, so it acts as you, with only your access. A saved token is kept out of chat and is never shown again, to you or to anyone else.</Text>
      {page && !full ? <Text testID="connections-restricted" style={styles.note}>{page.agent === "none" ? NO_AGENT_LINE : RESTRICTED_LINE}</Text> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {!page && !error ? <ActivityIndicator color={colors.blue} style={styles.spinner} /> : null}
      {page ? <View style={styles.list}>
        {page.tools.map(tool => <View key={tool.id} testID={`connection-${tool.id}`} style={styles.row}>
          <Text style={styles.name}>{tool.name}</Text>
          <Text testID={`connection-${tool.id}-status`} style={[styles.status, tool.mine && styles.connected]}>{standingLine(tool.mine)}</Text>
          {tool.mine ? <Text style={styles.meta}>{timesLine(tool.mine, loadedAt)}</Text> : null}
          {full || tool.mine ? <View style={styles.actions}>
            {full ? <Button testID={`connection-${tool.id}-connect`} label={tool.mine ? "Replace" : "Connect"} accessibilityLabel={tool.mine ? `Replace your ${tool.name} token` : `Connect ${tool.name}`} kind="secondary" compact onPress={() => setConnecting(tool)} /> : null}
            {tool.mine ? <Button testID={`connection-${tool.id}-remove`} label="Remove" accessibilityLabel={`Remove your ${tool.name} token`} kind="danger" compact onPress={() => { setRemoveError(null); setRemoving(tool); }} /> : null}
          </View> : null}
        </View>)}
      </View> : null}
    </ScrollView>

    <Modal visible={!!connecting} transparent animationType="fade" onRequestClose={() => setConnecting(null)}>
      <View style={styles.scrim}>
        {connecting ? <View accessibilityViewIsModal style={styles.dialog}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <ConnectionCard bare tool={connecting} state="form" dismissLabel="Cancel" onDismiss={() => setConnecting(null)}
              onSaved={mine => { replace({ ...connecting, mine }); setConnecting(null); }} />
          </ScrollView>
        </View> : null}
      </View>
    </Modal>

    <ConfirmDialog visible={!!removing} title={removing ? `Remove your ${removing.name} token?` : ""}
      description="Your agent stops using it from its next reply. The token itself still works wherever else you use it; revoke it where you made it if you no longer need it."
      confirmLabel="Remove" busy={removeBusy} error={removeError} onCancel={() => { setRemoving(null); setRemoveError(null); }} onConfirm={() => void remove()} />
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 720, alignSelf: "center" },
  intro: { ...typography.body, color: colors.muted, marginBottom: space.sm },
  note: { ...typography.body, color: colors.ink, marginBottom: space.sm },
  error: { ...typography.caption, color: colors.red, marginBottom: space.sm },
  spinner: { marginVertical: space.lg },
  list: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  row: { paddingVertical: space.sm, gap: space.xxs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  name: { ...typography.bodyStrong, color: colors.ink },
  status: { ...typography.body, color: colors.muted },
  connected: { color: colors.ink },
  meta: { ...typography.caption, color: colors.muted },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.xs },
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", padding: space.lg, backgroundColor: colors.scrim },
  dialog: { width: "100%", maxWidth: 440, maxHeight: "100%", padding: space.lg, backgroundColor: colors.background, borderRadius: radius.lg },
}));
