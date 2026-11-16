import { Redirect } from "expo-router";
import { ChannelList } from "../../components/ChannelList";
import { DesktopHome } from "../../components/DesktopHome";
import { landingHref, useFeature, useFeatures } from "../../lib/features";
import { useWideLayout } from "../../lib/layout";

export default function Channels() {
  const wide = useWideLayout();
  const features = useFeatures();
  // A server without channels has no Home tab (Deep work keeps it); a stale link here goes where the app lands.
  if (!useFeature("home")) return <Redirect href={landingHref(features)} />;
  // The wide layout shows the channel list in the sidebar instead.
  return wide ? <DesktopHome /> : <ChannelList />;
}
