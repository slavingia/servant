import { useLayoutEffect, useRef, type ComponentRef } from "react";
import { Platform, TextInput, useWindowDimensions, type TextInputProps } from "react-native";

/**
 * A multi-line text box that grows with its text, from `minHeight` up to
 * `maxShare` of the window, so long drafted text can be read without
 * scrolling inside a small box. Browsers don't grow a textarea by themselves.
 */
export function GrowingTextInput({ minHeight = 96, maxShare = 0.6, style, value, ...props }: TextInputProps & { minHeight?: number; maxShare?: number }) {
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const screen = useWindowDimensions();
  const max = Math.max(minHeight, Math.round(screen.height * maxShare));
  useLayoutEffect(() => {
    if (Platform.OS !== "web") return;
    const node = input.current as unknown as { style?: { height: string }; scrollHeight?: number } | null;
    if (!node?.style || typeof node.scrollHeight !== "number") return;
    node.style.height = "auto";
    node.style.height = `${Math.min(Math.max(node.scrollHeight + 2, minHeight), max)}px`;
  }, [value, max, minHeight, screen.width]);
  return <TextInput ref={input} multiline textAlignVertical="top" value={value} style={[style, { minHeight, maxHeight: max }]} {...props} />;
}
