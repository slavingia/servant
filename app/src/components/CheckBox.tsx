import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { radius, useTheme, createThemedStyles } from "../lib/theme";
import { AppIcon } from "./AppIcon";

// The picture of a checkbox. The row it sits in is the control: the role, the label and the state live there, so
// this is hidden from a screen reader. One size and one boundary everywhere a box is ticked.
//   choice  filled with the primary color: one of the things you picked
//   done    pale green with a dark green tick: a to-do or a saved task that is finished
type Props = { on: boolean; tone?: "choice" | "done"; busy?: boolean; style?: StyleProp<ViewStyle> };

export function CheckBox({ on, tone = "choice", busy = false, style }: Props) {
  const styles = useStyles();
  const { colors } = useTheme();
  const done = tone === "done";
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.box, on && (done ? styles.done : styles.on), style]}>
      {busy ? <ActivityIndicator size="small" color={on && !done ? colors.onPrimary : colors.blue} />
        : on ? <AppIcon name="check" size={16} strokeWidth={2.6} color={done ? colors.greenDark : colors.onPrimary} /> : null}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  box: { width: 24, height: 24, flexShrink: 0, borderRadius: radius.sm, borderWidth: 2, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  on: { backgroundColor: colors.primary, borderColor: colors.primary },
  done: { backgroundColor: colors.greenSoft, borderColor: colors.green },
}));
