import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, type PressableStateCallbackType } from "react-native";
import { router } from "expo-router";
import { useSession } from "../lib/session";
import { ServerError } from "../lib/server";
import { DEEP_WORK_HINT, MISSED_TITLE, missedDetail, missedLabel, type MissedCall } from "../lib/deep-work";
import { statusTime } from "../lib/message-status";
import { onBrandTint, radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { AppIcon } from "./AppIcon";
import { Avatar } from "./Messaging";
import { Button } from "./Button";
import { SwitchPicture } from "./Toggle";

const hovered = (state: PressableStateCallbackType) => (state as PressableStateCallbackType & { hovered?: boolean }).hovered || state.pressed;

// Your Deep work switch (deep-work.ts): in the sidebar just above your name, and under Preferences on the
// You tab on a phone. Flipping it is instant; the server is told and your other devices follow. Switching
// it off shows, once, the calls and meeting invites that didn't ring while it was on.
// The whole row is the switch (role, label and state live on it); the track and thumb are its picture.
// State goes through aria-* props: native maps them to accessibilityState, and the web keeps only those.
export function DeepWorkSwitch({ onNavy = false }: { onNavy?: boolean }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { deepWork, setDeepWork } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missed, setMissed] = useState<MissedCall[]>([]);
  const flip = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const list = await setDeepWork(!deepWork);
      if (list.length) setMissed(list);
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't change that. Check your connection and try again.");
    } finally { setBusy(false); }
  };
  const join = (m: MissedCall) => { setMissed([]); router.push({ pathname: "/meeting/[id]", params: { id: m.id } }); };
  const ink = onNavy ? colors.onBrand : colors.ink;
  const quiet = onNavy ? onBrandTint.muted : colors.muted;
  return (
    <View style={onNavy ? styles.navyBlock : styles.block}>
      <Pressable testID="deep-work-switch" accessibilityRole="switch" accessibilityLabel="Deep work" accessibilityHint={DEEP_WORK_HINT}
        aria-checked={deepWork} aria-busy={busy} aria-disabled={busy} disabled={busy} onPress={() => void flip()}
        style={state => [onNavy ? styles.navyRow : styles.row, onNavy && hovered(state) && styles.navyHovered, !onNavy && state.pressed && { backgroundColor: colors.subtle }]}>
        {onNavy ? <View style={styles.icon}><AppIcon name="moon" size={16} color={deepWork ? ink : quiet} /></View> : null}
        <View style={styles.copy}>
          <Text style={[onNavy ? styles.navyLabel : styles.label, { color: ink }, deepWork && styles.on]}>Deep work</Text>
        </View>
        <SwitchPicture on={deepWork} offColor={onNavy ? onBrandTint.track : undefined} />
      </Pressable>
      {error ? <Text accessibilityRole="alert" style={[styles.error, { color: onNavy ? colors.onBrand : colors.red }]}>{error}</Text> : null}
      <Modal visible={missed.length > 0} transparent animationType="fade" onRequestClose={() => setMissed([])}>
        <View style={styles.scrim}>
          <View style={styles.card} accessibilityViewIsModal>
            <Text accessibilityRole="header" style={styles.cardTitle}>{MISSED_TITLE}</Text>
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {missed.map(m => <View key={m.id} style={styles.missedRow}>
                <Avatar name={m.by.name} userId={m.by.id || undefined} size={34} />
                <View style={styles.copy}>
                  <Text style={styles.missedText}>{missedLabel(m)}</Text>
                  <Text style={styles.missedTime}>{missedDetail(m, statusTime(m.startedAt))}</Text>
                </View>
                {m.live ? <Button label="Join" accessibilityLabel={m.place ? `Join the meeting in ${m.place}` : `Join the call with ${m.by.name}`} compact onPress={() => join(m)} /> : null}
              </View>)}
            </ScrollView>
            <Button label="Done" kind="secondary" onPress={() => setMissed([])} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  block: {},
  // Sits between the sidebar's list and your name, on the same navy.
  navyBlock: { paddingTop: space.xxs },
  row: { minHeight: 56, paddingHorizontal: space.md, paddingVertical: space.sm, flexDirection: "row", alignItems: "center", gap: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  navyRow: { minHeight: 36, marginHorizontal: space.xs, paddingHorizontal: space.xs, flexDirection: "row", alignItems: "center", gap: space.xs, borderRadius: radius.md },
  navyHovered: { backgroundColor: onBrandTint.hover },
  icon: { width: 20, alignItems: "center", justifyContent: "center" },
  copy: { flex: 1, minWidth: 0 },
  label: { ...typography.body },
  navyLabel: { ...typography.body },
  on: { fontWeight: "600" },
  error: { ...typography.caption, marginHorizontal: space.md, marginBottom: space.xs },
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", padding: space.lg, backgroundColor: colors.scrim },
  card: { width: "100%", maxWidth: 440, maxHeight: "100%", backgroundColor: colors.background, borderRadius: radius.lg, padding: space.lg, gap: space.md },
  cardTitle: { ...typography.heading, color: colors.ink },
  list: { flexShrink: 1 },
  listContent: { gap: space.sm },
  missedRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  missedText: { ...typography.body, color: colors.ink },
  missedTime: { ...typography.caption, color: colors.muted, marginTop: 2 },
}));
