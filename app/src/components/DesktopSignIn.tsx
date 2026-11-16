import { ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { ApproveFromPhone } from "./ApproveFromPhone";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "./Button";
import type { DesktopWorkspace } from "../lib/desktop";
import { useSession } from "../lib/session";
import { ALL_FEATURES, landingHref, normalizeFeatures } from "../lib/features";
import { createThemedStyles, space, typography } from "../lib/theme";
import { ProjectCredit } from "./ProjectCredit";

// The Mac app's first screen: already use Servant on your phone? Approve this
// Mac there. Otherwise paste a sign-in link or the team's invite.
export function DesktopSignIn({ workspace, onUseInvite, device = "Mac" }: { workspace: DesktopWorkspace; onUseInvite: () => void; device?: "Mac" | "Browser" }) {
  const styles = useStyles();
  const { setAccount } = useSession();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text accessibilityRole="header" style={styles.title}>{device === "Mac" ? "Sign in on your Mac" : "Sign in to Servant"}</Text>
        <ApproveFromPhone side key={`${workspace.server}:${workspace.serverKey}:${workspace.discovery}`} workspace={workspace} device={device}
          onSignedIn={account => { setAccount(account); router.replace(landingHref(account.features ? normalizeFeatures(account.features) : ALL_FEATURES)); }} />
        <Button label="Use sign-in link" kind="secondary" onPress={() => router.push("/sign-in")} style={styles.alt} />
        <Button label="Join with invite" kind="link" onPress={onUseInvite} />
      </ScrollView>
      <ProjectCredit />
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { width: "100%", maxWidth: 820, alignSelf: "center", paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.xxl, alignItems: "center" },
  title: { ...typography.display, color: colors.ink, textAlign: "center" },
  alt: { alignSelf: "center", width: "100%", maxWidth: 420, marginTop: space.sm },
}));
