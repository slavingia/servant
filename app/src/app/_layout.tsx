import { preloadScreens } from "../lib/preload-screens";
import { GestureRoot } from "../components/GestureRoot";
import { Platform, Text, View } from "react-native";
import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider as NavigationThemeProvider, usePathname } from "expo-router";
import { useEffect, useLayoutEffect, useMemo } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider, useSession } from "../lib/session";
import { NotificationsProvider } from "../lib/notifications";
import { LiveProvider } from "../lib/live";
import { PhotoProvider } from "../lib/photos";
import { AppChrome } from "../components/AppChrome";
import { Button } from "../components/Button";
import { headerTitleType, navigationFonts, typography, useTheme } from "../lib/theme";
import { accountId } from "../lib/accounts-store";
import { validServerKey } from "../lib/tunnel-crypto";
import { useWideLayout } from "../lib/layout";
import { landingHref, useFeatures } from "../lib/features";
import { WideBack } from "../components/WideBack";
import { SessionExpiryGate } from "../components/SessionExpiryGate";
import { ShareGate } from "../components/ShareGate";
import { LaunchScreen } from "../components/LaunchScreen";
import { useApplyUpdates } from "../lib/ota";
import { useAppFonts } from "../lib/use-app-fonts";
import { useFirstScreens } from "../lib/use-first-screens";
import { removeLaunchPage } from "../lib/launch-page";

export default function RootLayout() {
  useApplyUpdates();
  useAppFonts();
  return (
    <GestureRoot>
      <SafeAreaProvider>
        <SessionProvider>
          <SessionNavigation />
        </SessionProvider>
      </SafeAreaProvider>
    </GestureRoot>
  );
}

function SessionNavigation() {
  const { ready, account, loadError, retryLoad } = useSession();
  const { colors, scheme } = useTheme();
  // The page's own drawing of the app's shape stays until this, the app's first frame (lib/launch-page.ts).
  useLayoutEffect(removeLaunchPage, []);
  const pathname = usePathname();
  const wide = useWideLayout();
  // Sidebar destinations replace each other, so they have nothing to go back to.
  const sidebarScreen = wide ? { headerBackVisible: false, headerLeft: () => null } : {};
  // Pages below a sidebar destination always get Back at the top left.
  const childScreen = wide ? { headerBackVisible: false, headerLeft: () => <WideBack /> } : {};
  const navigationTheme = useMemo(() => ({
    ...(scheme === "dark" ? DarkTheme : DefaultTheme),
    fonts: navigationFonts,
    colors: {
      ...(scheme === "dark" ? DarkTheme.colors : DefaultTheme.colors),
      primary: colors.blue,
      background: colors.background,
      card: colors.background,
      text: colors.ink,
      border: colors.line,
      notification: colors.primary,
    },
  }), [colors, scheme]);
  const paired = !!account && validServerKey(account.serverKey);
  // In a browser, load every screen's code ahead of its first use (lib/preload-order.ts).
  useEffect(() => { if (paired) preloadScreens(); }, [paired]);
  const landing = landingHref(useFeatures());
  // In a browser the first screen's code is fetched: the launch screen stays until it is in, so opening the app
  // never shows an empty page between its shape and its first screen (lib/first-screens.ts).
  const firstScreensIn = useFirstScreens(ready, paired, pathname, landing);
  // Wait for the saved account before mounting any invite screen.
  if (!ready) {
    return <LaunchScreen />;
  }
  if (loadError) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text accessibilityRole="alert" style={{ ...typography.body, color: colors.ink, textAlign: "center", maxWidth: 400 }}>{loadError}</Text>
        <Button label="Try again" onPress={retryLoad} style={{ marginTop: 24, minWidth: 200 }} />
      </View>
    );
  }
  return (
    <NavigationThemeProvider value={navigationTheme}>
    <NotificationsProvider>
    <PhotoProvider key={account ? `${accountId(account)}:${account.token}:${account.user.id}` : "signed-out"}>
    <LiveProvider>
    {/* The lists start loading behind the launch screen, so the first screen can open with them. */}
    {!firstScreensIn ? <LaunchScreen /> : <>
    <StatusBar style={paired && account?.banner?.message ? "dark" : (paired && wide) || pathname === "/welcome" || scheme === "dark" ? "light" : "dark"} />
    <AppChrome enabled={paired}>
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.ink,
        headerTitleAlign: "left",
        headerShadowVisible: true,
        headerTitleStyle: headerTitleType(wide),
        headerBackButtonDisplayMode: "minimal",
        contentStyle: { backgroundColor: colors.background },
        // Keep the compact conversation toolbar free of extra glass button fills.
        ...(Platform.OS === "ios"
          ? {
              unstable_headerLeftItems: ({ canGoBack }: { canGoBack?: boolean }) =>
                canGoBack
                  ? [
                      {
                        type: "button" as const,
                        label: "Back",
                        icon: { type: "sfSymbol" as const, name: "chevron.left" as const },
                        tintColor: colors.ink,
                        hidesSharedBackground: true,
                        accessibilityLabel: "Back",
                        onPress: () => router.back(),
                      },
                    ]
                  : [],
            }
          : {}),
      }}
    >
      {/* Startup redirects should reveal the landing screen in place. */}
      <Stack.Screen name="index" options={{ headerShown: false, animation: "none" }} />
      <Stack.Screen name="join-server" options={{ title: "Join another server" }} />
      <Stack.Screen name="sign-in" options={{ title: "Sign in" }} />
      <Stack.Screen name="pair" options={{ title: "Joining", headerBackVisible: false }} />
      <Stack.Screen name="scan" options={{ title: "Scan QR code" }} />
      <Stack.Screen name="link-computer" options={{ title: "Link a computer" }} />
      <Stack.Screen name="link-device" options={{ title: "Link a computer" }} />
      <Stack.Protected guard={!paired} redirectTo={landing}>
        <Stack.Screen name="welcome" options={{ headerShown: false, animation: "none" }} />
      </Stack.Protected>
      <Stack.Protected guard={paired} redirectTo="/welcome">
        <Stack.Screen name="(tabs)" options={{ headerShown: false, title: "Back", animation: "none" }} />
        {/* The session ended: confirm it's you, then back to where you were. No way around it, no sign-out. */}
        <Stack.Screen name="reverify" options={{ title: "Confirm it's you", headerBackVisible: false, headerLeft: () => null, gestureEnabled: false }} />
        <Stack.Screen name="c/[id]" options={{ title: "", ...sidebarScreen }} />
        <Stack.Screen name="thread" options={{ title: "Thread", ...childScreen }} />
        <Stack.Screen name="new-channel" options={{ title: "New channel", ...sidebarScreen }} />
        <Stack.Screen name="new-message" options={{ title: "New message", ...sidebarScreen }} />
        <Stack.Screen name="inbox" options={{ title: "Cases", ...sidebarScreen }} />
        <Stack.Screen name="inbox/[id]" options={{ title: "Conversation", ...childScreen }} />
        <Stack.Screen name="browse" options={{ headerShown: false }} />
        <Stack.Screen name="archived-channels" options={{ title: "Archived", ...sidebarScreen }} />
        <Stack.Screen name="channel-info" options={{ title: "Details", ...childScreen }} />
        <Stack.Screen name="files" options={{ title: "Files", ...childScreen }} />
        <Stack.Screen name="project" options={{ title: "Project", ...childScreen }} />
        <Stack.Screen name="chat/[id]" options={{ title: "", ...childScreen }} />
        {/* Where a share from another app lands (share.tsx); the share waits natively through sign-in. */}
        <Stack.Screen name="share" options={{ title: "Send to agent", ...childScreen }} />
        <Stack.Screen name="feedback" options={{ title: "Send feedback", ...childScreen }} />
        <Stack.Screen name="queue" options={{ title: "Feedback", ...sidebarScreen }} />
        <Stack.Screen name="saved" options={{ title: "Saved", ...sidebarScreen }} />
        <Stack.Screen name="todos" options={{ title: "To-dos", ...sidebarScreen }} />
        <Stack.Screen name="wiki" options={{ title: "Wiki", ...sidebarScreen }} />
        {/* Where Text shortcuts used to be; it redirects to the wiki's Abbreviations page. */}
        <Stack.Screen name="lexicon" options={{ title: "Wiki", ...sidebarScreen }} />
        <Stack.Screen name="notifications" options={{ title: "Notifications", ...childScreen }} />
        <Stack.Screen name="code/[id]" options={{ title: "Enter code", ...childScreen }} />
        <Stack.Screen name="code/index" options={{ title: "Code from Messages", ...childScreen }} />
        <Stack.Screen name="entitlements" options={{ title: "Entitlements", ...childScreen }} />
        <Stack.Screen name="leaderboard" options={{ title: "Agent usage", ...childScreen }} />
        <Stack.Screen name="invite" options={{ title: "Invite someone", ...childScreen }} />
        <Stack.Screen name="recordings/index" options={{ title: "Recordings", ...sidebarScreen }} />
        <Stack.Screen name="recordings/[id]" options={{ title: "Recording", ...childScreen }} />
      </Stack.Protected>
    </Stack>
    {paired ? <SessionExpiryGate /> : null}
    {paired ? <ShareGate /> : null}
    </AppChrome>
    </>}
    </LiveProvider>
    </PhotoProvider>
    </NotificationsProvider>
    </NavigationThemeProvider>
  );
}
