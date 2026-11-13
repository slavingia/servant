import { createElement, type ReactNode } from "react";
import { Alert, Platform, Text } from "react-native";
import { abbreviationParts } from "../lib/abbreviation-marks";
import type { GlossaryEntry } from "../lib/abbreviations";

// A known abbreviation, like Wikipedia's <abbr>: the words stay as written, with a dotted underline.
// In a browser, hovering shows what it stands for. A phone has no hover, so a tap shows it.
export function Abbr({ text, title }: { text: string; title: string }) {
  if (Platform.OS === "web") {
    return createElement("abbr", { title, style: { textDecorationLine: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 2, cursor: "help" } }, text);
  }
  const [term, ...rest] = title.split(": ");
  return (
    <Text accessibilityHint={title} onPress={() => Alert.alert(term!, rest.join(": "))}
      style={{ textDecorationLine: "underline", textDecorationStyle: "dotted" }}>{text}</Text>
  );
}

/** Plain message text with its known abbreviations marked. */
export function withAbbreviations(text: string, entries: readonly GlossaryEntry[]): ReactNode {
  if (!entries.length) return text;
  const parts = abbreviationParts(text, entries);
  if (parts.length === 1 && !parts[0]!.title) return text;
  return parts.map((part, i) => part.title ? <Abbr key={i} text={part.text} title={part.title} /> : part.text);
}
