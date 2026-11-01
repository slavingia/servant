import { useCallback, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { api, type Release } from "../../lib/server";
import { PageTitle } from "../../components/Band";
import { Avatar } from "../../components/Messaging";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { AppIcon } from "../../components/AppIcon";
import Constants from "expo-constants";
import { useSession } from "../../lib/session";
import { feedbackGestureHint } from "../../lib/feedback-trigger";
import { createThemedStyles, useTheme, radius, space, typography } from "../../lib/theme";

function Row({ label, value, onPress }: { label: string; value?: string; onPress?: () => void }) {
  const { colors } = useTheme();
  const styles = useStyles();
  const content = <>
      <Text style={styles.rowLabel}>{label}</Text>
      {value ? <Text style={styles.rowValue}>{value}</Text> : null}
      {onPress ? <AppIcon name="chevronRight" size={16} color={colors.muted} /> : null}
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
  const { colors } = useTheme();
  const styles = useStyles();
  const [release, setRelease] = useState<Release | null>(null);
  const feedbackHint = feedbackGestureHint(Platform.OS, Platform.Version);
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
      <PageTitle>You</PageTitle>
      <View style={styles.profile}>
        <Avatar name={account.user.name} size={48} />
        <View style={styles.profileCopy}>
          <Text style={styles.profileName}>{account.user.name}</Text>
          <Text style={styles.profileRole}>{account.serverName} · {owner ? "Workspace owner" : "Member"}</Text>
        </View>
      </View>
      <Text accessibilityRole="header" style={styles.section}>Preferences</Text>
      <View style={styles.group}>
        <Row label="Notifications" onPress={() => router.push("/notifications")} />
      </View>

      <Text accessibilityRole="header" style={styles.section}>Workspace</Text>
      <View style={styles.group}>
        <Row label="People" onPress={() => router.push("/members")} />
        {owner ? <Row label="Invite people" onPress={() => router.push("/invite")} /> : null}
        <Row label="Archived" onPress={() => router.push("/archived-channels")} />
      </View>

      <Text accessibilityRole="header" style={styles.section}>Help & updates</Text>
      <View style={styles.group}>
        <Row label="Send feedback" onPress={() => router.push("/feedback")} />
      </View>
      {feedbackHint ? <Text style={styles.hint}>{feedbackHint}</Text> : null}
      {release ? (
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Opens the notes and the thread to talk about them"
            onPress={() => router.push({ pathname: "/thread", params: { conv: release.conversationId, root: release.messageId, title: "#whats-new" } })}
            style={({ pressed }) => [styles.group, styles.notes, pressed && { backgroundColor: colors.surface }]}
          >
            <View style={styles.notesHeader}><Text style={styles.notesTitle}>What's new</Text><Text style={styles.build}>Build {release.build}</Text></View>
            <Text style={styles.notesText} numberOfLines={3}>
              {release.text.split("\n").slice(1).join("\n").trim()}
            </Text>
            <Text style={styles.notesLink}>Read release notes</Text>
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

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  hint: { ...typography.caption, color: colors.muted, marginTop: space.xs, marginHorizontal: space.xs },
  root: { flex: 1, backgroundColor: colors.surface },
  content: { paddingBottom: space.xl },
  profile: { marginHorizontal: space.side, marginBottom: space.lg, paddingVertical: space.sm, flexDirection: "row", alignItems: "center", gap: space.sm },
  profileCopy: { flex: 1, minWidth: 0 },
  profileName: { ...typography.heading, color: colors.ink },
  profileRole: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  section: { ...typography.label, marginHorizontal: space.side, marginTop: space.sm, marginBottom: space.xs, color: colors.muted },
  group: { backgroundColor: colors.background, marginHorizontal: space.side, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: "hidden", marginBottom: space.md },
  row: { minHeight: 48, paddingHorizontal: space.md, paddingVertical: space.sm, flexDirection: "row", alignItems: "center", gap: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowLabel: { ...typography.body, color: colors.ink, flex: 1 },
  rowValue: { ...typography.body, color: colors.muted, flex: 1, textAlign: "right" },
  danger: { marginHorizontal: space.side, marginTop: space.xs, minHeight: 48, justifyContent: "center", paddingHorizontal: space.md, backgroundColor: colors.background, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  dangerText: { ...typography.bodyStrong, color: colors.red },
  notes: { padding: space.md },
  notesHeader: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.xs, marginBottom: space.xs },
  notesTitle: { ...typography.bodyStrong, color: colors.ink },
  build: { ...typography.caption, color: colors.muted, marginLeft: "auto" },
  notesText: { ...typography.caption, color: colors.muted },
  notesLink: { ...typography.captionStrong, marginTop: space.sm, color: colors.blue },
  version: { ...typography.caption, marginTop: space.md, textAlign: "center", color: colors.muted },
}));
