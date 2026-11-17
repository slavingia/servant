import { useState } from "react";
import { Pressable, StyleSheet, Text, View, type PressableStateCallbackType } from "react-native";
import { useSession } from "../lib/session";
import { ServerError } from "../lib/server";
import { DEEP_WORK_HINT } from "../lib/deep-work";
import { onBrandTint, radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { AppIcon } from "./AppIcon";
import { SwitchPicture } from "./Toggle";

const hovered = (state: PressableStateCallbackType) => (state as PressableStateCallbackType & { hovered?: boolean }).hovered || state.pressed;

// Your Deep work switch (deep-work.ts): in the sidebar just above your name, and under Preferences on the
// You tab on a phone. Flipping it is instant; the server is told and your other devices follow.
// The whole row is the switch (role, label and state live on it); the track and thumb are its picture.
// State goes through aria-* props: native maps them to accessibilityState, and the web keeps only those.
export function DeepWorkSwitch({ onNavy = false }: { onNavy?: boolean }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { deepWork, setDeepWork } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flip = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setDeepWork(!deepWork);
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't change that. Check your connection and try again.");
    } finally { setBusy(false); }
  };
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
}));
