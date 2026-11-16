import { Pressable, StyleSheet, Text, View } from "react-native";
import { TabList, TabSlot, TabTrigger, Tabs, type TabTriggerSlotProps } from "expo-router/ui";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppIcon, type AppIconName } from "./AppIcon";
import { useLiveUnread } from "../lib/live";
import { TAB_HREF, tabsFor, useFeatures, type TabName } from "../lib/features";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

// Phone-width web: a bottom tab bar with the same icons and colors as the native tabs.
// The server's features (features.ts) decide which tabs show and in what order.
const TABS: Record<TabName, { label: string; icon: AppIconName; badge?: "channels" | "messages" | "agent" }> = {
  channels: { label: "Home", icon: "home", badge: "channels" },
  messages: { label: "Chats", icon: "chat", badge: "messages" },
  agent: { label: "Agent", icon: "sparkles", badge: "agent" },
  members: { label: "People", icon: "people" },
  you: { label: "You", icon: "user" },
};

type ButtonProps = TabTriggerSlotProps & { label: string; icon: AppIconName; count?: number };

// expo-router types the slot ref as View-the-component; the Pressable takes it fine.
function TabButton({ label, icon, count, isFocused, ref, ...props }: ButtonProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const color = isFocused ? colors.blue : colors.muted;
  const badge = count && count > 0 ? (count > 99 ? "99+" : String(count)) : null;
  return <Pressable ref={ref as React.Ref<never>} {...props} accessibilityRole="tab" accessibilityState={{ selected: !!isFocused }} aria-selected={!!isFocused}
    accessibilityLabel={badge ? `${label}, ${badge} unread` : label} style={({ pressed }) => [styles.tab, pressed && { opacity: 0.7 }]}>
    <View>
      <AppIcon name={icon} size={24} color={color} strokeWidth={isFocused ? 2.2 : 1.8} />
      {badge ? <View style={styles.badge}><Text style={styles.badgeText}>{badge}</Text></View> : null}
    </View>
    <Text style={[styles.label, { color }, isFocused && styles.labelActive]} numberOfLines={1}>{label}</Text>
  </Pressable>;
}

export function WebTabs() {
  const styles = useStyles();
  const unread = useLiveUnread();
  const insets = useSafeAreaInsets();
  const tabs = tabsFor(useFeatures());
  return <Tabs style={styles.root}>
    <TabSlot style={styles.slot} />
    <TabList accessibilityRole="tablist" style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space.xs) }]}>
      {tabs.map(name => <TabTrigger key={name} name={name} href={TAB_HREF[name]} asChild>
        <TabButton label={TABS[name].label} icon={TABS[name].icon} count={TABS[name].badge ? unread[TABS[name].badge] : undefined} />
      </TabTrigger>)}
    </TabList>
  </Tabs>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  slot: { flex: 1 },
  bar: { flexDirection: "row", justifyContent: "space-around", alignItems: "stretch", paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, backgroundColor: colors.background },
  tab: { flex: 1, minHeight: 48, alignItems: "center", justifyContent: "center", gap: 2, cursor: "pointer" },
  label: { ...typography.meta },
  labelActive: { fontWeight: "600" },
  badge: { position: "absolute", top: -4, left: 14, minWidth: 24, height: 24, borderRadius: radius.pill, paddingHorizontal: space.xs, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  badgeText: { ...typography.captionStrong, color: colors.onPrimary },
}));
