import { Platform, Pressable, StyleSheet, Switch, View } from "react-native";
import { radius, useTheme, createThemedStyles } from "../lib/theme";

// The one switch. It sits at the end of a row whose words say what it turns on; `label` is those words for a
// screen reader. A phone draws its own switch. A browser and the Mac app draw the track and thumb below inside
// a 44-point target: the switch a browser draws is 40 by 20, and hit slop does nothing there.
type Props = {
  label: string;
  hint?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  /** The track when off, for surfaces that are always dark (a call). */
  offColor?: string;
  testID?: string;
};

export const SWITCH_TARGET = 44;

export function Toggle({ label, hint, value, onValueChange, disabled, offColor, testID }: Props) {
  const styles = useStyles();
  const { colors } = useTheme();
  if (Platform.OS !== "web") {
    return <Switch testID={testID} accessibilityLabel={label} accessibilityHint={hint} value={value} disabled={disabled} onValueChange={onValueChange}
      trackColor={{ true: colors.primary, false: offColor ?? colors.borderStrong }} thumbColor={colors.white} />;
  }
  // Enter flips a pressable of any role; Space is added because it is the key a checkbox answers to.
  const space = { onKeyDown: (event: { key?: string; nativeEvent?: { key?: string }; preventDefault?: () => void }) => {
    if ((event.key ?? event.nativeEvent?.key) !== " " || disabled) return;
    event.preventDefault?.();
    onValueChange(!value);
  } } as object;
  return (
    <Pressable testID={testID} accessibilityRole="switch" accessibilityLabel={label} accessibilityHint={hint} aria-checked={value} aria-disabled={!!disabled}
      disabled={!!disabled} onPress={() => onValueChange(!value)} {...space} style={[styles.target, disabled && styles.off]}>
      <SwitchPicture on={value} offColor={offColor} />
    </Pressable>
  );
}

/** The track and thumb alone, for a row that is itself the switch (Deep work). */
export function SwitchPicture({ on, offColor }: { on: boolean; offColor?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={[styles.track, { backgroundColor: on ? colors.primary : offColor ?? colors.borderStrong, alignItems: on ? "flex-end" : "flex-start" }]}>
      <View style={styles.thumb} />
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  target: { minWidth: SWITCH_TARGET, minHeight: SWITCH_TARGET, flexShrink: 0, alignItems: "flex-end", justifyContent: "center" },
  off: { opacity: 0.5 },
  track: { width: 44, height: 26, borderRadius: radius.pill, padding: 2, justifyContent: "center" },
  thumb: { width: 22, height: 22, borderRadius: radius.pill, backgroundColor: colors.white },
}));
