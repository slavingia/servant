import { Slot } from "expo-router";
import { NativeTabs } from "expo-router/native-tabs";
import { Platform } from "react-native";
import { WebTabs } from "../../components/WebTabBar";
import { useWideLayout } from "../../lib/layout";
import { useLive } from "../../lib/live";
import { badgeText as badge } from "../../lib/agent-unread";
import { useTheme } from "../../lib/theme";

const Icon = NativeTabs.Trigger.Icon;

export default function TabsLayout() {
  const { unread } = useLive();
  const { colors } = useTheme();
  const wide = useWideLayout();
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
      <NativeTabs.Trigger name="channels">
        <Icon sf="house.fill" src={require("../../../assets/tab-icons/home.png")} />
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge hidden={!badge(unread.channels)}>{badge(unread.channels)}</NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="messages">
        <Icon sf="bubble.left.and.bubble.right.fill" src={require("../../../assets/tab-icons/messages.png")} />
        <NativeTabs.Trigger.Label>DMs</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge hidden={!badge(unread.messages)}>{badge(unread.messages)}</NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="agent">
        <Icon sf="sparkles" src={require("../../../assets/tab-icons/agent.png")} />
        <NativeTabs.Trigger.Label>Agent</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge hidden={!badge(unread.agent)}>{badge(unread.agent)}</NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="members">
        <Icon sf="person.2.fill" src={require("../../../assets/tab-icons/people.png")} />
        <NativeTabs.Trigger.Label>People</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="you">
        <Icon sf="person.crop.circle.fill" src={require("../../../assets/tab-icons/you.png")} />
        <NativeTabs.Trigger.Label>You</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
