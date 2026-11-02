import { ChannelList } from "../../components/ChannelList";
import { DesktopHome } from "../../components/DesktopHome";
import { useWideLayout } from "../../lib/layout";

export default function Channels() {
  // The wide layout shows the channel list in the sidebar instead.
  return useWideLayout() ? <DesktopHome /> : <ChannelList />;
}
