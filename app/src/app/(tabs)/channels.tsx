import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Band, PageTitle } from "../../components/Band";
import { SwipeChannelRow } from "../../components/SwipeChannelRow";
import { api, HubError, type Conversation } from "../../lib/hub";
import { useLive } from "../../lib/live";
import { useSession } from "../../lib/session";
import { colors } from "../../lib/theme";

export default function Channels() {
  const { account } = useSession();
  const { conversations, error, refresh, connected } = useLive();
  const [refreshing, setRefreshing] = useState(false);
  const [archived, setArchived] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const busy = useRef(false);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const closeRow = useCallback(() => setOpenId(null), []);
  const act = async (c: Conversation, remove = false) => {
    if (!account || busy.current) return;
    busy.current = true;
    setBusyId(c.id);
    setActionError(null);
    try {
      if (remove) await api.deleteChannel(account, c.id);
      else if (c.archived) await api.restoreChannel(account, c.id);
      else await api.archiveChannel(account, c.id);
      setDeleting(null);
      setOpenId(null);
      await refresh();
    } catch (e) {
      setActionError(e instanceof HubError ? e.message : "Couldn't update the channel. Try again");
    } finally {
      busy.current = false;
      setBusyId(null);
    }
  };
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );
  if (!account) return null;
  const list = (conversations ?? []).filter((c) => c.kind === "channel" && !!c.archived === archived);
  return (
    <View style={styles.root}>
      <Band
        right={
          <Pressable accessibilityRole="button" onPress={() => router.push("/new-channel")} hitSlop={12}>
            <Text style={styles.bandLink}>New channel</Text>
          </Pressable>
        }
      />
      <FlatList
        data={list}
        onScrollBeginDrag={closeRow}
        extraData={{ openId, busyId }}
        keyExtractor={(c) => c.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await refresh();
              setRefreshing(false);
            }}
          />
        }
        ListHeaderComponent={
          <View style={{ marginBottom: 8 }}>
            <PageTitle>Channels</PageTitle>
            <View style={styles.filters}>
              {[false, true].map((value) => <Pressable key={String(value)} accessibilityRole="button" accessibilityState={{ selected: archived === value }} onPress={() => { setArchived(value); closeRow(); setActionError(null); }} style={[styles.filter, archived === value && styles.selected]}>
                <Text style={[styles.filterText, archived === value && styles.selectedText]}>{value ? "Archived" : "Active"}</Text>
              </Pressable>)}
            </View>
            {actionError ? <Text accessibilityRole="alert" style={styles.error}>{actionError}</Text> : null}
            {error && conversations ? <Text style={styles.error}>{error}</Text> : null}
            {!connected && conversations ? <Text style={styles.note}>Reconnecting…</Text> : null}
          </View>
        }
        ListEmptyComponent={
          conversations === null ? (
            error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator style={{ marginTop: 40 }} color={colors.blue} />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{archived ? "No archived channels" : "No channels yet"}</Text>
              <Text style={styles.emptyBody}>{archived ? "Channels you archive stay here until you restore them" : "Make one for a team or a topic"}</Text>
            </View>
          )
        }
        renderItem={({ item }) => <SwipeChannelRow c={item} open={openId === item.id} busy={busyId !== null}
          canDelete={item.name !== "general" && (account.user.role === "owner" || item.createdBy === account.user.id)}
          onOpen={() => setOpenId(item.id)} onClose={closeRow}
          onPress={() => router.push({ pathname: "/c/[id]", params: { id: item.id } })}
          onArchive={() => act(item)} onDelete={() => { setActionError(null); setDeleting(item); }} />}
        ListFooterComponent={(
          <Pressable accessibilityRole="button" onPress={() => router.push("/browse")} style={styles.footerLink}>
            <Text style={styles.footerText}>Browse channels</Text>
          </Pressable>
        )}
        contentContainerStyle={{ paddingBottom: 120 }}
      />
      <Modal visible={!!deleting} transparent animationType="fade" onRequestClose={() => { if (!busy.current) setDeleting(null); }}>
        <View style={styles.scrim}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.emptyTitle}>Delete #{deleting?.title}?</Text>
            <Text style={styles.dialogBody}>This permanently deletes the channel and all its messages for everyone. This can't be undone.</Text>
            {actionError ? <Text accessibilityRole="alert" style={styles.dialogError}>{actionError}</Text> : null}
            <View style={styles.dialogActions}>
              <Pressable disabled={busyId !== null} accessibilityRole="button" onPress={() => setDeleting(null)} style={styles.dialogButton}><Text style={styles.footerText}>Cancel</Text></Pressable>
              <Pressable disabled={busyId !== null} accessibilityRole="button" onPress={() => { if (deleting) void act(deleting, true); }} style={styles.dialogButton}><Text style={styles.deleteText}>{busyId ? "Deleting…" : "Delete channel"}</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: "row", marginHorizontal: 20, marginBottom: 8, gap: 8 },
  filter: { minHeight: 44, paddingHorizontal: 18, justifyContent: "center", borderRadius: 22, backgroundColor: colors.surface },
  selected: { backgroundColor: colors.blue },
  filterText: { color: colors.ink, fontSize: 16, fontWeight: "600" },
  selectedText: { color: colors.white },
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.4)" },
  dialog: { width: "100%", maxWidth: 440, backgroundColor: colors.white, borderRadius: 16, padding: 24 },
  dialogBody: { marginTop: 12, color: colors.ink, fontSize: 17, lineHeight: 24 },
  dialogActions: { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", marginTop: 20, gap: 16 },
  dialogButton: { minHeight: 48, justifyContent: "center" },
  deleteText: { color: colors.red, fontSize: 17, fontWeight: "600" },
  dialogError: { marginTop: 12, color: colors.red, fontSize: 15 },
  root: { flex: 1, backgroundColor: colors.white },
  bandLink: { color: colors.white, fontSize: 16, fontWeight: "600" },
  error: { marginTop: 8, marginHorizontal: 20, fontSize: 15, color: colors.red },
  note: { marginTop: 8, marginHorizontal: 20, fontSize: 15, color: colors.muted },
  empty: { marginTop: 48, alignItems: "center", paddingHorizontal: 20 },
  emptyTitle: { fontSize: 20, fontWeight: "600", color: colors.ink },
  emptyBody: { marginTop: 6, fontSize: 16, color: colors.muted, textAlign: "center" },
  footerLink: { minHeight: 52, paddingHorizontal: 20, justifyContent: "center" },
  footerText: { color: colors.blue, fontSize: 17, fontWeight: "600" },
});
