import { Redirect } from "expo-router";

// Old links: Recordings is now Notetaker.
export default function OldRecordings() {
  return <Redirect href="/notetaker" />;
}
