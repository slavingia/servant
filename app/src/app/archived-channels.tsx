import { Redirect } from "expo-router";
import { ChannelList } from "../components/ChannelList";
import { anyTalk, landingHref, useFeatures } from "../lib/features";

export default function ArchivedChannels() {
  const features = useFeatures();
  // Nothing to archive on a server with neither channels nor direct messages.
  if (!anyTalk(features)) return <Redirect href={landingHref(features)} />;
  return <ChannelList archived />;
}
