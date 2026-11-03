import { Pressable, StyleSheet, Text, View } from "react-native";
import { TabList, TabSlot, TabTrigger, Tabs, type TabTriggerSlotProps } from "expo-router/ui";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppIcon, type AppIconName } from "./AppIcon";
import { useLive } from "../lib/live";
import { space, typography, useTheme, createThemedStyles } from "../lib/theme";

// Phone-width web: a bottom tab bar with the same icons and colors as the native tabs.
const TABS: { name: string; href: "/channels" | "/messages" | "/agent" | "/members" | "/you"; label: string; icon: AppIconName; badge?: "channels" | "messages" }[] = [
  { name: "channels", href: "/channels", label: "Home", icon: "home", badge: "channels" },
  { name: "messages", href: "/messages", label: "DMs", icon: "chat", badge: "messages" },
  { name: "agent", href: "/agent", label: "Agent", icon: "sparkles" },
  { name: "members", href: "/members", label: "People", icon: "people" },
  { name: "you", href: "/you", label: "You", icon: "user" },
];

type ButtonProps = TabTriggerSlotProps & { label: string; icon: AppIconName; count?: number };

// expo-router types the slot ref as View-the-component; the Pressable takes it fine.
function TabButton({ label, icon, count, isFocused, ref, ...props }: ButtonProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const color = isFocused ? colors.blue : colors.muted;
  const badge = count && count > 0 ? (count > 99 ? "99+" : String(count)) : null;
  return <Pressable ref={ref as React.Ref<never>} {...props} accessibilityRole="tab" accessibilityState={{ selected: !!isFocused }}
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
  const { unread } = useLive();
  const insets = useSafeAreaInsets();
  return <Tabs style={styles.root}>
    <TabSlot style={styles.slot} />
    <TabList style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space.xs) }]}>
      {TABS.map(tab => <TabTrigger key={tab.name} name={tab.name} href={tab.href} asChild>
        <TabButton label={tab.label} icon={tab.icon} count={tab.badge ? unread[tab.badge] : undefined} />
      </TabTrigger>)}
    </TabList>
  </Tabs>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  slot: { flex: 1 },
  bar: { flexDirection: "row", justifyContent: "space-around", alignItems: "stretch", paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, backgroundColor: colors.background },
  tab: { flex: 1, minHeight: 48, alignItems: "center", justifyContent: "center", gap: 2, cursor: "pointer" },
  label: { ...typography.meta, fontSize: 11 },
  labelActive: { fontWeight: "600" },
  badge: { position: "absolute", top: -4, left: 14, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  badgeText: { fontSize: 11, lineHeight: 14, fontWeight: "700", color: colors.onPrimary },
}));
