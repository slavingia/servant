import { useCallback, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { api, type Release } from "../../lib/hub";
import { Band, PageTitle } from "../../components/Band";
import Constants from "expo-constants";
import { useSession } from "../../lib/session";
import { colors } from "../../lib/theme";

function Row({ label, value, onPress }: { label: string; value?: string; onPress?: () => void }) {
  return (
    <Pressable accessibilityRole={onPress ? "button" : undefined} onPress={onPress} style={({ pressed }) => [styles.row, pressed && onPress && { backgroundColor: colors.surface }]}>
      <Text style={[styles.rowLabel, onPress && !value && { color: colors.blue }]}>{label}</Text>
      {value ? <Text style={styles.rowValue}>{value}</Text> : null}
    </Pressable>
  );
}

export default function Settings() {
  const { account, signOut } = useSession();
  const [release, setRelease] = useState<Release | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (account) api.latestRelease(account).then(setRelease).catch(() => undefined);
    }, [account]),
  );
  if (!account) return null;
  const owner = account.user.role === "owner";

  const leave = () => {
    const go = async () => {
      await signOut();
      router.replace("/welcome");
    };
    if (Platform.OS === "web") return void go();
    Alert.alert("Sign out of Servant?", "You'll need a new invite to come back", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: go },
    ]);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
    <Band />
    <ScrollView style={styles.root} contentContainerStyle={{ paddingBottom: 120 }}>
      <PageTitle>You</PageTitle>
      <View style={{ height: 20 }} />
      <Text style={styles.section}>Account</Text>
      <View style={styles.group}>
        <Row label="Name" value={account.user.name} />
        <Row label="Notifications" onPress={() => router.push("/notifications")} />
        <Row label="Hub" value={account.hubName} />
        <Row label="Access" value={owner ? "Owner" : "Member"} />
      </View>

      {release ? (
        <>
          <Text style={styles.section}>What's new</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Opens the notes and the thread to talk about them"
            onPress={() => router.push({ pathname: "/thread", params: { conv: release.conversationId, root: release.messageId, title: "#whats-new" } })}
            style={({ pressed }) => [styles.group, styles.notes, pressed && { backgroundColor: colors.surface }]}
          >
            <Text style={styles.notesTitle}>Build {release.build}</Text>
            <Text style={styles.notesText} numberOfLines={3}>
              {release.text.split("\n").slice(1).join("\n").trim()}
            </Text>
            <Text style={styles.notesLink}>Discuss</Text>
          </Pressable>
        </>
      ) : null}

      {owner ? (
        <>
          <Text style={styles.section}>People</Text>
          <View style={styles.group}>
            <Row label="Invite someone" onPress={() => router.push("/invite")} />
          </View>
        </>
      ) : null}

      <Pressable accessibilityRole="button" onPress={leave} style={styles.danger}>
        <Text style={styles.dangerText}>Sign out</Text>
      </Pressable>

      <Text style={styles.version}>Servant {Constants.expoConfig?.version ?? ""}</Text>
    </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  section: { marginHorizontal: 20, marginTop: 12, marginBottom: 8, fontSize: 13, fontWeight: "600", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5 },
  group: { backgroundColor: colors.white, marginHorizontal: 20, borderRadius: 12, overflow: "hidden", marginBottom: 16 },
  row: { minHeight: 52, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowLabel: { fontSize: 17, color: colors.ink },
  rowValue: { fontSize: 17, color: colors.muted, flexShrink: 1, marginLeft: 12, textAlign: "right" },
  danger: { marginTop: 8, alignSelf: "center", minHeight: 44, justifyContent: "center", paddingHorizontal: 20 },
  dangerText: { color: colors.red, fontSize: 17 },
  notes: { padding: 16 },
  notesTitle: { fontSize: 17, fontWeight: "600", color: colors.ink, marginBottom: 4 },
  notesText: { fontSize: 16, lineHeight: 22, color: colors.ink },
  notesLink: { marginTop: 10, color: colors.blue, fontSize: 17, fontWeight: "600" },
  version: { marginTop: 16, textAlign: "center", color: colors.muted, fontSize: 13 },
});
