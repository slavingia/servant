import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { AppIcon, type AppIconName } from "./AppIcon";
import { linkUnderline, radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

// The one button. Four kinds, one size (48 points, or 44 when compact), and IconButton for an icon alone:
//   primary    filled blue: the one main action of a screen, form or dialog
//   secondary  grey outline: every other action
//   danger     red outline: anything that deletes, removes, leaves or signs out
//   link       words only, underlined on the web: navigation and quiet actions such as Cancel
type Props = {
  label: string;
  /** What a screen reader says when the visible words alone are not enough ("Join" next to two rows). */
  accessibilityLabel?: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "link" | "danger";
  busy?: boolean;
  disabled?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function Button({ label, accessibilityLabel, onPress, kind = "primary", busy, disabled, compact, style, testID }: Props) {
  const styles = useStyles();
  const { colors } = useTheme();
  const off = disabled || busy;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={!!off}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [styles.base, styles[kind], compact && styles.compact, off && (kind === "primary" && !busy ? styles.primaryOff : styles.off), pressed && !off && styles.pressed, style]}
    >
      {busy ? (
        <ActivityIndicator color={kind === "primary" ? colors.onPrimary : kind === "danger" ? colors.red : colors.blue} />
      ) : (
        <Text style={[styles.label, styles[`${kind}Label`], off && kind === "primary" && styles.primaryOffLabel]}>{label}</Text>
      )}
    </Pressable>
  );
}

/** The square an icon alone is pressed in. Hit slop does nothing in a browser or the Mac app, so the size is real. */
export const ICON_TARGET = 44;

type IconProps = {
  icon: AppIconName;
  /** What a screen reader says: the action ("Hide details"), not the picture. */
  label: string;
  onPress: () => void;
  size?: number;
  color?: string;
  disabled?: boolean;
  /** Line the picture up with the edge of the content beside it; the square then overhangs that edge. */
  edge?: "start" | "end";
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** An icon alone, in a 44-point square of its own: close, remove, more. Words are better when there is room. */
export function IconButton({ icon, label, onPress, size = 18, color, disabled, edge, style, testID }: IconProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const overhang = -(ICON_TARGET - size) / 2;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={!!disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.icon, edge === "start" && { marginLeft: overhang }, edge === "end" && { marginRight: overhang }, disabled && styles.off, pressed && styles.pressed, style]}
    >
      <AppIcon name={icon} size={size} color={color ?? colors.muted} />
    </Pressable>
  );
}

/** Buttons side by side at their own width, wrapping when they do not fit. `end` for dialogs and sheets. */
export function ButtonGroup({ children, align = "start", style }: { children: ReactNode; align?: "start" | "end" | "between"; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles();
  return <View style={[styles.group, align === "end" && styles.groupEnd, align === "between" && styles.groupBetween, style]}>{children}</View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  base: { minHeight: 48, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", paddingHorizontal: space.md, paddingVertical: space.sm },
  compact: { minHeight: 44, paddingHorizontal: space.md, paddingVertical: space.xs },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.borderStrong },
  danger: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.red },
  link: { minHeight: 44, backgroundColor: "transparent" },
  icon: { width: ICON_TARGET, height: ICON_TARGET, flexShrink: 0, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  off: { opacity: 0.5 },
  primaryOff: { backgroundColor: colors.line },
  primaryOffLabel: { color: colors.muted },
  pressed: { opacity: 0.85 },
  label: { ...typography.bodyStrong, textAlign: "center" },
  primaryLabel: { color: colors.onPrimary },
  secondaryLabel: { color: colors.ink },
  linkLabel: { color: colors.blue, ...linkUnderline },
  dangerLabel: { color: colors.red },
  group: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs },
  groupEnd: { justifyContent: "flex-end" },
  groupBetween: { justifyContent: "space-between" },
}));
