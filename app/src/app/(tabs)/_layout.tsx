import type { ComponentProps } from "react";
import { Slot } from "expo-router";
import { NativeTabs } from "expo-router/native-tabs";
import { Platform } from "react-native";
import { WebTabs } from "../../components/WebTabBar";
import { useWideLayout } from "../../lib/layout";
import { useLive } from "../../lib/live";
import { badgeText as badge } from "../../lib/agent-unread";
import { tabsFor, useFeatures, type TabName } from "../../lib/features";
import { useTheme } from "../../lib/theme";

const Icon = NativeTabs.Trigger.Icon;
type SfIcon = Extract<ComponentProps<typeof Icon>, { sf?: unknown }>["sf"];

// One entry per tab; the server's features (features.ts) decide which show and in what order.
const TABS: Record<TabName, { sf: SfIcon; src: number; label: string; badge?: "channels" | "messages" | "agent" }> = {
  channels: { sf: "house.fill", src: require("../../../assets/tab-icons/home.png"), label: "Home", badge: "channels" },
  messages: { sf: "bubble.left.and.bubble.right.fill", src: require("../../../assets/tab-icons/messages.png"), label: "Chats", badge: "messages" },
  agent: { sf: "sparkles", src: require("../../../assets/tab-icons/agent.png"), label: "Agent", badge: "agent" },
  members: { sf: "person.2.fill", src: require("../../../assets/tab-icons/people.png"), label: "People" },
  you: { sf: "person.crop.circle.fill", src: require("../../../assets/tab-icons/you.png"), label: "You" },
};

export default function TabsLayout() {
  const { unread } = useLive();
  const { colors } = useTheme();
  const wide = useWideLayout();
  const tabs = tabsFor(useFeatures());
  // The sidebar is the tab bar in the wide layout.
  if (wide) return <Slot />;
  // On web the native tab bar renders as a pill at the top; use a real bottom bar instead.
  if (Platform.OS === "web") return <WebTabs />;
  return (
    <NativeTabs
      tintColor={colors.blue}
      backgroundColor={colors.background}
      iconColor={{ default: colors.muted, selected: colors.blue }}
      labelStyle={{ default: { color: colors.muted }, selected: { color: colors.blue } }}
      badgeBackgroundColor={colors.primary}
      badgeTextColor={colors.onPrimary}
      minimizeBehavior="never"
    >
      {tabs.map(name => {
        const tab = TABS[name];
        const count = tab.badge ? badge(unread[tab.badge]) : "";
        return (
          <NativeTabs.Trigger key={name} name={name}>
            <Icon sf={tab.sf} src={tab.src} />
            <NativeTabs.Trigger.Label>{tab.label}</NativeTabs.Trigger.Label>
            {tab.badge ? <NativeTabs.Trigger.Badge hidden={!count}>{count}</NativeTabs.Trigger.Badge> : null}
          </NativeTabs.Trigger>
        );
      })}
    </NativeTabs>
  );
}
