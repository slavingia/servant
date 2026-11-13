import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { accountId } from "../lib/accounts-store";
import { useSession } from "../lib/session";
import { onBrandTint, radius, space, typography, createThemedStyles, useTheme } from "../lib/theme";
import { AppIcon } from "./AppIcon";
import { Button } from "./Button";

/** The same server menu in the desktop sidebar and the phone's You tab. */
export function ServerSwitcher({ sidebar = false }: { sidebar?: boolean }) {
  const { account, accounts, switchAccount, supportsMultipleServers } = useSession();
  const { colors } = useTheme();
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!account) return null;
  const color = sidebar ? colors.onBrand : colors.ink;
  const select = async (id: string) => {
    if (busy) return;
    setBusy(id); setError(null);
    try { await switchAccount(id); setOpen(false); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't switch servers. Try again."); }
    finally { setBusy(null); }
  };
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={`Switch server, ${account.serverName}`} accessibilityState={{ expanded: open }} aria-expanded={open} onPress={() => { setError(null); setOpen(true); }} style={({ pressed }) => [styles.trigger, pressed && { opacity: 0.75 }]}>
      <View style={[styles.mark, sidebar && { backgroundColor: onBrandTint.field }]}><Text style={[styles.initial, { color }]}>{account.serverName.slice(0, 1).toUpperCase() || "S"}</Text></View>
      <Text style={[styles.name, { color }]}>{account.serverName}</Text>
      <AppIcon name="chevronDown" size={16} color={color} />
    </Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => { if (!busy) setOpen(false); }}>
      <View style={styles.scrim}>
        <View style={styles.dialog} accessibilityViewIsModal>
          <Text accessibilityRole="header" style={styles.title}>Your servers</Text>
          <ScrollView style={styles.list}>
            {accounts.map(saved => {
              const id = accountId(saved);
              const selected = id === accountId(account);
              return <Pressable key={id} accessibilityRole="button" accessibilityLabel={`${saved.serverName}, ${saved.user.name}${selected ? ", current server" : ""}`} accessibilityState={{ selected, busy: busy === id, disabled: !!busy }} aria-current={selected ? "true" : undefined} disabled={!!busy} onPress={() => void select(id)} style={({ pressed }) => [styles.row, (selected || pressed) && { backgroundColor: colors.subtle }]}>
                <View style={styles.copy}><Text style={styles.serverName}>{saved.serverName}</Text><Text style={styles.person}>{saved.user.name}</Text></View>
                {selected ? <Text style={styles.current}>Current</Text> : busy === id ? <Text style={styles.person}>Opening…</Text> : <AppIcon name="chevronRight" size={16} color={colors.muted} />}
              </Pressable>;
            })}
          </ScrollView>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          {supportsMultipleServers ? <Button label="Join another server" kind="secondary" disabled={!!busy} onPress={() => { setOpen(false); router.push("/join-server"); }} /> : <Text style={styles.note}>Update the Servant Mac app to join more than one server.</Text>}
          <Text style={styles.note}>Switching servers leaves your current call.</Text>
          <Button label="Done" kind="link" disabled={!!busy} onPress={() => setOpen(false)} />
        </View>
      </View>
    </Modal>
  </>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  trigger: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm },
  mark: { width: 30, height: 30, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", backgroundColor: colors.subtle },
  initial: { ...typography.bodyStrong },
  name: { ...typography.bodyStrong, flex: 1 },
  scrim: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.lg, backgroundColor: colors.scrim },
  dialog: { width: "100%", maxWidth: 440, maxHeight: "90%", padding: space.lg, borderRadius: radius.lg, backgroundColor: colors.background },
  title: { ...typography.heading, color: colors.ink },
  list: { marginVertical: space.md, flexGrow: 0 },
  row: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, borderRadius: radius.sm },
  copy: { flex: 1 },
  serverName: { ...typography.bodyStrong, color: colors.ink },
  person: { ...typography.caption, color: colors.muted },
  current: { ...typography.captionStrong, color: colors.blue },
  error: { ...typography.caption, color: colors.red, marginBottom: space.sm },
  note: { ...typography.caption, color: colors.muted, marginTop: space.sm },
}));
