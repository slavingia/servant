import { Platform } from "react-native";
import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider } from "../lib/session";
import { NotificationsProvider } from "../lib/notifications";
import { LiveProvider } from "../lib/live";
import { colors } from "../lib/theme";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <LiveProvider>
        <NotificationsProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.navy },
            headerTintColor: colors.white,
            headerTitleAlign: "center",
            headerTitleStyle: { fontWeight: "600" },
            headerBackButtonDisplayMode: "minimal",
            contentStyle: { backgroundColor: colors.white },
            // iOS 26+ wraps the back chevron in a light glass circle, which reads light blue on
            // the navy band. Draw it as a plain white chevron instead.
            ...(Platform.OS === "ios"
              ? {
                  unstable_headerLeftItems: ({ canGoBack }: { canGoBack?: boolean }) =>
                    canGoBack
                      ? [
                          {
                            type: "button" as const,
                            label: "Back",
                            icon: { type: "sfSymbol" as const, name: "chevron.left" as const },
                            tintColor: colors.white,
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
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="welcome" options={{ headerShown: false }} />
          <Stack.Screen name="pair" options={{ title: "Joining", headerBackVisible: false }} />
          <Stack.Screen name="scan" options={{ title: "Scan invite" }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false, title: "Back" }} />
          <Stack.Screen name="c/[id]" options={{ title: "" }} />
          <Stack.Screen name="thread" options={{ title: "Thread" }} />
          <Stack.Screen name="new-channel" options={{ title: "New channel" }} />
          <Stack.Screen name="new-message" options={{ title: "New message" }} />
          <Stack.Screen name="browse" options={{ title: "Browse channels" }} />
          <Stack.Screen name="channel-info" options={{ title: "Details" }} />
          <Stack.Screen name="chat/[id]" options={{ title: "" }} />
          <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
          <Stack.Screen name="invite" options={{ title: "Invite someone" }} />
        </Stack>
        </NotificationsProvider>
        </LiveProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
