import { Redirect } from "expo-router";

// Keep existing links working now that discovery lives in the channel list.
export default function Browse() {
  return <Redirect href="/channels" />;
}
