import { NativeTabs } from "expo-router/native-tabs";
import { useLive } from "../../lib/live";
import { colors } from "../../lib/theme";

const Icon = NativeTabs.Trigger.Icon;

export default function TabsLayout() {
  const { unread } = useLive();
  const badge = (n: number) => (n > 0 ? String(n > 99 ? "99+" : n) : undefined);
  return (
    <NativeTabs tintColor={colors.blue} minimizeBehavior="never">
      <NativeTabs.Trigger name="members">
        <Icon sf={{ default: "person.2", selected: "person.2.fill" }} md="groups" />
        <NativeTabs.Trigger.Label>Members</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="channels">
        <Icon sf={{ default: "number", selected: "number" }} md="tag" />
        <NativeTabs.Trigger.Label>Channels</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge hidden={!badge(unread.channels)}>{badge(unread.channels)}</NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="messages">
        <Icon sf={{ default: "bubble.left.and.bubble.right", selected: "bubble.left.and.bubble.right.fill" }} md="forum" />
        <NativeTabs.Trigger.Label>Messages</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge hidden={!badge(unread.messages)}>{badge(unread.messages)}</NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="agent">
        <Icon sf={{ default: "sparkles", selected: "sparkles" }} md="auto_awesome" />
        <NativeTabs.Trigger.Label>Agent</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="you">
        <Icon sf={{ default: "person.crop.circle", selected: "person.crop.circle.fill" }} md="account_circle" />
        <NativeTabs.Trigger.Label>You</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
