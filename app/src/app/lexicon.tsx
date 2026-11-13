import { Redirect } from "expo-router";

// Text shortcuts moved into the wiki as its Abbreviations page. Old links and bookmarks land there.
export default function LexiconScreen() {
  return <Redirect href={{ pathname: "/wiki", params: { page: "abbreviations" } }} />;
}
