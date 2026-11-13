import { Pressable, StyleSheet, Text } from "react-native";
import { AppIcon, type AppIconName } from "./AppIcon";
import { radius, space, typography, useTheme } from "../lib/theme";

// The call screens share one dark palette, whatever the app's theme.
export const CALL_DARK = "#0B1220";
export const CALL_PANEL = "#1B2433";
export const CALL_CONTROL = "#243045";
export const CALL_MUTED_TEXT = "#C9D3E0";
export const CALL_RED = "#D11242";

type Base = { label: string; onPress: () => void; active?: boolean; disabled?: boolean; accessibilityLabel?: string };

/** A big call control, icon over a short label: Mute, Camera and Leave. `danger` is the red Leave. */
export function CallControl({ label, icon, onPress, active, danger, disabled, accessibilityLabel }: Base & { icon: AppIconName; danger?: boolean }) {
  const ink = active ? CALL_DARK : "#FFFFFF";
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ selected: !!active, disabled: !!disabled }} aria-pressed={active} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.control, active && styles.controlActive, danger && styles.controlDanger, disabled && styles.off, pressed && styles.pressed]}>
      <AppIcon name={icon} size={22} color={ink} />
      <Text style={[styles.controlText, { color: ink }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

/** A quieter control, small icon and label in a pill: Share screen, Research, People. */
export function CallChip({ label, icon, onPress, active, disabled, accessibilityLabel }: Base & { icon: AppIconName }) {
  const ink = active ? CALL_DARK : CALL_MUTED_TEXT;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ selected: !!active, disabled: !!disabled }} aria-pressed={active} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.chip, active && styles.controlActive, disabled && styles.off, pressed && styles.pressed]}>
      <AppIcon name={icon} size={16} color={ink} />
      <Text style={[styles.chipText, { color: ink }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

/** Text only, full tap height but visually small: Cancel on the pre-call screen, End for all on a call. */
export function CallTextButton({ label, onPress, danger, disabled, accessibilityLabel }: Omit<Base, "active"> & { danger?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.text, disabled && styles.off, pressed && styles.pressed]}>
      <Text style={[styles.textLabel, danger && styles.textDanger]}>{label}</Text>
    </Pressable>
  );
}

/** The one full-width primary: Join call before a call, Back to the conversation after it. */
export function CallPrimaryButton({ label, onPress, disabled, accessibilityLabel }: Omit<Base, "active">) {
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.primary, { backgroundColor: colors.primary }, disabled && styles.off, pressed && styles.pressed]}>
      <Text style={[styles.primaryText, { color: colors.onPrimary }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  control: { flex: 1, minHeight: 60, paddingHorizontal: space.xs, paddingVertical: space.xs, borderRadius: radius.lg, alignItems: "center", justifyContent: "center", gap: 4, backgroundColor: CALL_CONTROL },
  controlActive: { backgroundColor: "#FFFFFF" },
  controlDanger: { backgroundColor: CALL_RED },
  controlText: { ...typography.label },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, paddingHorizontal: space.sm, borderRadius: radius.pill, backgroundColor: CALL_PANEL },
  chipText: { ...typography.label },
  text: { minHeight: 48, paddingHorizontal: space.lg, alignItems: "center", justifyContent: "center", alignSelf: "center" },
  textLabel: { ...typography.label, color: CALL_MUTED_TEXT },
  textDanger: { color: "#FFB4C0" },
  primary: { minHeight: 52, paddingHorizontal: space.md, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
  primaryText: { ...typography.bodyStrong },
  off: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
});
