import { Platform, Text, type TextProps } from "react-native";
import { UITextView } from "@bsky.app/react-native-uitextview";

// Text you can select part of, like a web page: touch and hold a word, then drag the handles.
// On iOS React Native's Text only copies the whole block, so this uses a native UITextView there.
// Android's selectable Text already has handles, and the web selects text anyway.
export function SelectableText(props: TextProps) {
  if (Platform.OS === "ios") return <UITextView {...props} selectable uiTextView />;
  return <Text {...props} selectable />;
}
