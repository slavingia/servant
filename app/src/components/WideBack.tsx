import { StyleSheet } from "react-native";
import { router, useGlobalSearchParams, usePathname, type Href } from "expo-router";
import { space, createThemedStyles, useTheme } from "../lib/theme";
import { IconButton } from "./Button";
import { landingHref, useFeatures, type Features } from "../lib/features";

// Where Back lands when there's no history, e.g. after a reload or a deep link.
function parentOf(pathname: string, params: { id?: string; conv?: string; kind?: string }, features: Features): Href {
  if (pathname === "/thread" && params.conv) return { pathname: "/c/[id]", params: { id: params.conv } };
  if (pathname === "/channel-info" && params.id) return { pathname: "/c/[id]", params: { id: params.id } };
  if (pathname === "/files" && params.id) return params.kind === "chat" ? { pathname: "/chat/[id]", params: { id: params.id } } : { pathname: "/c/[id]", params: { id: params.id } };
  if (pathname.startsWith("/chat/")) return "/agent";
  if (pathname === "/invite") return "/members";
  if (pathname === "/notifications" || pathname === "/leaderboard" || pathname === "/entitlements" || pathname === "/connections" || pathname === "/feedback") return "/you";
  return landingHref(features);
}

/** Top-left Back for wide-layout pages that sit below a sidebar destination. */
export function WideBack() {
  const styles = useStyles();
  const { colors } = useTheme();
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ id?: string; conv?: string; kind?: string }>();
  const features = useFeatures();
  const back = () => router.canGoBack() ? router.back() : router.replace(parentOf(pathname, params, features));
  // A chevron alone, like the phone header: the word was redundant.
  return <IconButton icon="back" label="Back" size={22} color={colors.blue} onPress={back} style={styles.button} />;
}

const useStyles = createThemedStyles(() => StyleSheet.create({
  button: { marginLeft: space.xs },
}));
