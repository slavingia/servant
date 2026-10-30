import { ActivityIndicator, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import { colors } from "../lib/theme";

type Props = {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "link" | "danger";
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function Button({ label, onPress, kind = "primary", busy, disabled, style }: Props) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [styles.base, styles[kind], off && styles.off, pressed && !off && styles.pressed, style]}
    >
      {busy ? (
        <ActivityIndicator color={kind === "primary" ? colors.white : colors.blue} />
      ) : (
        <Text style={[styles.label, styles[`${kind}Label`]]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: 50, borderRadius: 12, alignItems: "center", justifyContent: "center", paddingHorizontal: 20 },
  primary: { backgroundColor: colors.blue },
  secondary: { backgroundColor: colors.white, borderWidth: 1.5, borderColor: colors.blue },
  link: { minHeight: 44, backgroundColor: "transparent" },
  danger: { minHeight: 44, backgroundColor: "transparent" },
  off: { opacity: 0.5 },
  pressed: { opacity: 0.85 },
  label: { fontSize: 17, fontWeight: "600" },
  primaryLabel: { color: colors.white },
  secondaryLabel: { color: colors.blue },
  linkLabel: { color: colors.blue },
  dangerLabel: { color: colors.red },
});
