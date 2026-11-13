import { Platform, useWindowDimensions } from "react-native";

// Browser and Mac windows at least this wide get the sidebar layout.
// The Mac window's minimum width (760) always qualifies.
export const WIDE_LAYOUT_MIN_WIDTH = 720;

export function useWideLayout() {
  const { width } = useWindowDimensions();
  return Platform.OS === "web" && width >= WIDE_LAYOUT_MIN_WIDTH;
}
