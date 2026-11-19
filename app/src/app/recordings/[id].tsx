import { Redirect, useLocalSearchParams } from "expo-router";

// Old links to one recording open the same notes under Notetaker.
export default function OldRecording() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={{ pathname: "/notetaker/[id]", params: { id: String(id ?? "") } }} />;
}
