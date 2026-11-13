import { Platform, Pressable, type PressableProps } from "react-native";

type Props = Omit<PressableProps, "accessibilityRole" | "role" | "onPress"> & { onPress: () => void };

// React Native Web's Pressable handles Enter for a radio, but Space only for a button.
// Keep each choice's existing native behavior and add the missing web keyboard action.
export function Radio({ onPress, disabled, ...props }: Props) {
  const keyboard = Platform.OS === "web" ? { onKeyDown: (event: { key?: string; nativeEvent?: { key?: string }; repeat?: boolean; preventDefault: () => void; stopPropagation: () => void }) => {
    const key = event.key ?? event.nativeEvent?.key;
    if (disabled || (key !== " " && key !== "Spacebar")) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) onPress();
  } } : {};
  return <Pressable {...props} accessibilityRole="radio" aria-checked={props["aria-checked"]} disabled={disabled} onPress={onPress} {...keyboard} />;
}
