import { NativeTabs } from "expo-router/native-tabs";
import { useLive } from "../../lib/live";
import { colors } from "../../lib/theme";

// Text-only tabs: the words are clear, so no icons.
export default function TabsLayout() {
  const { unread } = useLive();
  const badge = (n: number) => (n > 0 ? String(n > 99 ? "99+" : n) : undefined);
  return (
    <NativeTabs tintColor={colors.blue} labelStyle={{ fontSize: 15, fontWeight: "600" }} minimizeBehavior="never">
      <NativeTabs.Trigger name="channels">
        <NativeTabs.Trigger.Label>Channels</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge hidden={!badge(unread.channels)}>{badge(unread.channels)}</NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="messages">
        <NativeTabs.Trigger.Label>Messages</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge hidden={!badge(unread.messages)}>{badge(unread.messages)}</NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="agent">
        <NativeTabs.Trigger.Label>Agent</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="you">
        <NativeTabs.Trigger.Label>You</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
