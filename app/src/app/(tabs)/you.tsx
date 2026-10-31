import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { api, type Release } from "../../lib/server";
import { PageTitle } from "../../components/Band";
import { Avatar } from "../../components/Messaging";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import Constants from "expo-constants";
import { useSession } from "../../lib/session";
import { colors, radius, space, typography } from "../../lib/theme";

function Row({ label, value, onPress }: { label: string; value?: string; onPress?: () => void }) {
  const content = <>
      <Text style={styles.rowLabel}>{label}</Text>
      {value ? <Text style={styles.rowValue}>{value}</Text> : null}
      {onPress ? <Text accessibilityElementsHidden importantForAccessibility="no" style={styles.chevron}>›</Text> : null}
    </>;
  if (!onPress) return <View style={styles.row}>{content}</View>;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}>
      {content}
    </Pressable>
  );
}

export default function Settings() {
  const { account, signOut } = useSession();
  const [release, setRelease] = useState<Release | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (account) api.latestRelease(account).then(setRelease).catch(() => undefined);
    }, [account]),
  );
  if (!account) return null;
  const owner = account.user.role === "owner";

  const leave = async () => {
    if (leaving) return;
    setLeaving(true);
    setError(null);
    try {
      await signOut();
      router.replace("/welcome");
    } catch {
      setError("Couldn't sign out. Try again.");
    } finally {
      setLeaving(false);
    }
  };

  return (
    <View style={styles.root}>
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <PageTitle description="Your account and preferences.">You</PageTitle>
      <View style={styles.profile}>
        <Avatar name={account.user.name} size={48} />
        <View style={styles.profileCopy}>
          <Text style={styles.profileName}>{account.user.name}</Text>
          <Text style={styles.profileRole}>{owner ? "Owner" : "Member"}</Text>
        </View>
      </View>
      <Text accessibilityRole="header" style={styles.section}>Preferences</Text>
      <View style={styles.group}>
        <Row label="Notifications" onPress={() => router.push("/notifications")} />
      </View>

      <Text accessibilityRole="header" style={styles.section}>Workspace</Text>
      <View style={styles.group}>
        <Row label="Server" value={account.serverName} />
      </View>

      <Text accessibilityRole="header" style={styles.section}>Help & updates</Text>
      <View style={styles.group}>
        <Row label="Send feedback" onPress={() => router.push("/feedback")} />
      </View>
      {release ? (
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Opens the notes and the thread to talk about them"
            onPress={() => router.push({ pathname: "/thread", params: { conv: release.conversationId, root: release.messageId, title: "#whats-new" } })}
            style={({ pressed }) => [styles.group, styles.notes, pressed && { backgroundColor: colors.surface }]}
          >
            <Text style={styles.notesTitle}>What's new</Text>
            <Text style={styles.build}>Build {release.build}</Text>
            <Text style={styles.notesText} numberOfLines={3}>
              {release.text.split("\n").slice(1).join("\n").trim()}
            </Text>
            <Text style={styles.notesLink}>Read updates & discuss</Text>
          </Pressable>
      ) : null}

      <Pressable accessibilityRole="button" onPress={() => { setError(null); setConfirming(true); }} style={styles.danger}>
        <Text style={styles.dangerText}>Sign out</Text>
      </Pressable>

      <Text style={styles.version}>Servant {Constants.expoConfig?.version ?? ""}</Text>
    </ScrollView>
    <ConfirmDialog visible={confirming} title="Sign out of Servant?" description="You'll need a new invite to sign in again." confirmLabel="Sign out" onConfirm={() => void leave()} onCancel={() => setConfirming(false)} busy={leaving} error={error} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  content: { paddingBottom: 120 },
  profile: { marginHorizontal: space.side, marginBottom: space.lg, padding: space.md, borderRadius: radius.lg, backgroundColor: colors.white, flexDirection: "row", alignItems: "center", gap: space.md },
  profileCopy: { flex: 1, minWidth: 0 },
  profileName: { ...typography.heading, color: colors.ink },
  profileRole: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  section: { ...typography.label, marginHorizontal: space.side, marginTop: space.xs, marginBottom: space.xs, color: colors.muted },
  group: { backgroundColor: colors.white, marginHorizontal: space.side, borderRadius: radius.md, overflow: "hidden", marginBottom: space.md },
  row: { minHeight: 56, paddingHorizontal: space.md, paddingVertical: space.md, flexDirection: "row", alignItems: "center", gap: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowLabel: { ...typography.body, color: colors.ink, flexShrink: 1 },
  rowValue: { ...typography.body, color: colors.muted, flex: 1, textAlign: "right" },
  chevron: { ...typography.heading, color: colors.muted, marginLeft: "auto" },
  danger: { marginTop: space.md, alignSelf: "center", minHeight: 48, justifyContent: "center", paddingHorizontal: space.side },
  dangerText: { ...typography.bodyStrong, color: colors.red },
  notes: { padding: space.md },
  notesTitle: { ...typography.bodyStrong, color: colors.ink },
  build: { ...typography.caption, color: colors.muted, marginTop: space.xxs, marginBottom: space.sm },
  notesText: { ...typography.body, color: colors.ink },
  notesLink: { ...typography.bodyStrong, marginTop: space.md, color: colors.blue },
  version: { ...typography.caption, marginTop: space.md, textAlign: "center", color: colors.muted },
});
