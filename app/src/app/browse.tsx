import { Redirect } from "expo-router";
import { landingHref, useFeatures } from "../lib/features";

// Keep existing links working now that discovery lives in the channel list.
export default function Browse() {
  return <Redirect href={landingHref(useFeatures())} />;
}
