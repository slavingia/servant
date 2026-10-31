import { NativeTabs } from "expo-router/native-tabs";
import { useLive } from "../../lib/live";
import { colors } from "../../lib/theme";

const Icon = NativeTabs.Trigger.Icon;

export default function TabsLayout() {
  const { unread } = useLive();
  const badge = (n: number) => (n > 0 ? String(n > 99 ? "99+" : n) : undefined);
  return (
    <NativeTabs tintColor={colors.blue} minimizeBehavior="never">
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
