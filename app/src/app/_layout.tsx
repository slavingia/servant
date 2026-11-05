import { Platform, Text, View } from "react-native";
import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider as NavigationThemeProvider, usePathname } from "expo-router";
import { useMemo } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider, useSession } from "../lib/session";
import { NotificationsProvider } from "../lib/notifications";
import { LiveProvider } from "../lib/live";
import { IncomingCall } from "../components/IncomingCall";
import { PhotoProvider } from "../lib/photos";
import { FeedbackPrompt } from "../components/FeedbackPrompt";
import { AppChrome } from "../components/AppChrome";
import { Button } from "../components/Button";
import { ThemeProvider, useTheme, typography } from "../lib/theme";
import { validServerKey } from "../lib/tunnel-crypto";
import { useWideLayout } from "../lib/layout";
import { WideBack } from "../components/WideBack";

export default function RootLayout() {
  return (
    <ThemeProvider>
    <SafeAreaProvider>
      <SessionProvider>
        <SessionNavigation />
      </SessionProvider>
    </SafeAreaProvider>
    </ThemeProvider>
  );
}

function SessionNavigation() {
  const { ready, account, loadError, retryLoad } = useSession();
  const { colors, scheme } = useTheme();
  const pathname = usePathname();
  const wide = useWideLayout();
  // Sidebar destinations replace each other, so they have nothing to go back to.
  const sidebarScreen = wide ? { headerBackVisible: false, headerLeft: () => null } : {};
  // Pages below a sidebar destination always get Back at the top left.
  const childScreen = wide ? { headerBackVisible: false, headerLeft: () => <WideBack /> } : {};
  const navigationTheme = useMemo(() => ({
    ...(scheme === "dark" ? DarkTheme : DefaultTheme),
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
  // Wait for the saved account before mounting any invite screen.
  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.navy }} />
    );
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
    <PhotoProvider>
    <LiveProvider>
    <NotificationsProvider>
    <FeedbackPrompt>
    <StatusBar style={paired || pathname === "/welcome" || scheme === "dark" ? "light" : "dark"} />
    <AppChrome enabled={paired}>
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.ink,
        headerTitleAlign: "left",
        headerShadowVisible: true,
        headerTitleStyle: wide ? { fontSize: 16, fontWeight: "700" } : { fontSize: typography.bodyStrong.fontSize, fontWeight: typography.bodyStrong.fontWeight },
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
      <Stack.Screen name="scan" options={{ title: "Scan QR code" }} />
      <Stack.Screen name="link-computer" options={{ title: "Link a computer" }} />
      <Stack.Screen name="link-device" options={{ title: "Link a computer" }} />
      <Stack.Protected guard={!paired} redirectTo="/channels">
        <Stack.Screen name="welcome" options={{ headerShown: false, animation: "none" }} />
        <Stack.Screen name="pair" options={{ title: "Joining", headerBackVisible: false }} />
      </Stack.Protected>
      <Stack.Protected guard={paired} redirectTo="/welcome">
        <Stack.Screen name="(tabs)" options={{ headerShown: false, title: "Back", animation: "none" }} />
        <Stack.Screen name="c/[id]" options={{ title: "", ...sidebarScreen }} />
        <Stack.Screen name="thread" options={{ title: "Thread", ...childScreen }} />
        <Stack.Screen name="meeting/[id]" options={{ headerShown: false, presentation: "fullScreenModal", gestureEnabled: false }} />
        <Stack.Screen name="new-channel" options={{ title: "New channel", ...sidebarScreen }} />
        <Stack.Screen name="new-message" options={{ title: "New message", ...sidebarScreen }} />
        <Stack.Screen name="browse" options={{ headerShown: false }} />
        <Stack.Screen name="archived-channels" options={{ title: "Archived", ...sidebarScreen }} />
        <Stack.Screen name="channel-info" options={{ title: "Details", ...childScreen }} />
        <Stack.Screen name="files" options={{ title: "Files", ...childScreen }} />
        <Stack.Screen name="project" options={{ title: "Project", ...childScreen }} />
        <Stack.Screen name="chat/[id]" options={{ title: "", ...childScreen }} />
        <Stack.Screen name="feedback" options={{ title: "Feedback", ...childScreen }} />
        <Stack.Screen name="notifications" options={{ title: "Notifications", ...childScreen }} />
        <Stack.Screen name="leaderboard" options={{ title: "Shame board", ...childScreen }} />
        <Stack.Screen name="invite" options={{ title: "Invite someone", ...childScreen }} />
      </Stack.Protected>
    </Stack>
    {paired ? <IncomingCall /> : null}
    </AppChrome>
    </FeedbackPrompt>
    </NotificationsProvider>
    </LiveProvider>
    </PhotoProvider>
    </NavigationThemeProvider>
  );
}
