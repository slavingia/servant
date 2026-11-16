import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { radius, space, typography, createThemedStyles } from "../lib/theme";

// Feedback is one place with two views: the surveys people answer, and the responses they left. It was two
// entries in the sidebar ("Surveys" and "Feedback queue"). Switching keeps the survey that is open and does not
// stack a screen, so Back leaves Feedback.
export const FEEDBACK_VIEWS = [
  { id: "surveys", label: "Surveys", path: "/surveys" },
  { id: "responses", label: "Responses", path: "/queue" },
] as const;
export type FeedbackView = (typeof FEEDBACK_VIEWS)[number]["id"];

export function FeedbackTabs({ current, survey, disabled }: { current: FeedbackView; survey?: string; disabled?: boolean }) {
  const styles = useStyles();
  return (
    <View accessibilityRole="tablist" accessibilityLabel="Feedback" style={styles.tabs}>
      {FEEDBACK_VIEWS.map(view => {
        const on = view.id === current;
        return (
          <Pressable key={view.id} testID={`feedback-tab-${view.id}`} accessibilityRole="tab" accessibilityState={{ selected: on, disabled }} aria-selected={on} disabled={disabled}
            onPress={() => { if (!on) router.replace({ pathname: view.path, params: survey ? { survey } : {} }); }} style={[styles.tab, on && styles.tabOn]}>
            <Text style={[styles.tabText, on && styles.tabTextOn]}>{view.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  tabs: { flexDirection: "row", gap: space.xxs, padding: space.xxs, borderRadius: radius.pill, backgroundColor: colors.surface, width: "100%", maxWidth: 400 },
  tab: { flex: 1, minWidth: 0, minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: space.xs, borderRadius: radius.pill },
  tabOn: { backgroundColor: colors.background },
  tabText: { ...typography.label, color: colors.muted },
  tabTextOn: { color: colors.ink },
}));
