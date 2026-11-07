import { ActivityIndicator, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

type Props = {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "link" | "danger";
  busy?: boolean;
  disabled?: boolean;
  compact?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
};

export function Button({ label, onPress, kind = "primary", busy, disabled, compact, accessibilityHint, style }: Props) {
  const styles = useStyles();
  const { colors } = useTheme();
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
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

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  base: { minHeight: 48, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", paddingHorizontal: space.md, paddingVertical: space.sm },
  compact: { minHeight: 44, paddingHorizontal: space.md, paddingVertical: space.xs },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.borderStrong },
  link: { minHeight: 44, backgroundColor: "transparent" },
  danger: { minHeight: 44, backgroundColor: "transparent" },
  off: { opacity: 0.5 },
  primaryOff: { backgroundColor: colors.line },
  primaryOffLabel: { color: colors.muted },
  pressed: { opacity: 0.85 },
  label: { ...typography.bodyStrong, textAlign: "center" },
  primaryLabel: { color: colors.onPrimary },
  secondaryLabel: { color: colors.ink },
  linkLabel: { color: colors.blue },
  dangerLabel: { color: colors.red },
}));
