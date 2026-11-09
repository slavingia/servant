import { useCallback } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type PressableStateCallbackType } from "react-native";
import { router, useFocusEffect, type Href } from "expo-router";
import { useLive } from "../lib/live";
import { useSession } from "../lib/session";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { AppIcon, type AppIconName } from "./AppIcon";
import { ConversationRow } from "./Messaging";

const hovered = (state: PressableStateCallbackType) => (state as PressableStateCallbackType & { hovered?: boolean }).hovered || state.pressed;

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

// The sidebar already lists every conversation, so Home starts something new.
export function DesktopHome() {
  const styles = useStyles();
  const { account } = useSession();
  const { conversations, refresh } = useLive();
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));
  if (!account) return null;
  const recent = (conversations ?? []).filter(c => !c.archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  const firstName = account.user.name.split(/\s+/)[0] ?? account.user.name;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.column}>
        <Text accessibilityRole="header" style={styles.title}>{greeting()}, {firstName}</Text>
        <Text style={styles.subtitle}>What do you want to get done in {account.serverName}?</Text>
        <View style={styles.actions}>
          <Action icon="sparkles" title="Ask the agent" detail="Start a private chat" href="/agent" />
          <Action icon="research" title="Research Studio" detail="Plan studies and review evidence" href="/research" />
          <Action icon="compose" title="New message" detail="Write to a teammate" href="/new-message" />
          <Action icon="hash" title="Browse channels" detail="Find a conversation" href="/browse" />
        </View>
        {recent.length ? <>
          <Text style={styles.sectionTitle}>Recent</Text>
          <View style={styles.card}>
            {recent.map(c => <ConversationRow key={c.id} c={c} onPress={() => router.push({ pathname: "/c/[id]", params: { id: c.id } })} />)}
          </View>
        </> : null}
      </View>
    </ScrollView>
  );
}

function Action({ icon, title, detail, href }: { icon: AppIconName; title: string; detail: string; href: Href }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityHint={detail} onPress={() => router.push(href)} style={state => [styles.action, hovered(state) && styles.actionHovered]}>
      <View style={styles.actionIcon}><AppIcon name={icon} size={18} color={colors.blue} /></View>
      <Text style={styles.actionTitle}>{title}</Text>
      <Text style={styles.actionDetail}>{detail}</Text>
    </Pressable>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: space.lg, paddingTop: 72, paddingBottom: space.xxl, alignItems: "center" },
  column: { width: "100%", maxWidth: 680 },
  title: { ...typography.display, color: colors.ink },
  subtitle: { ...typography.body, color: colors.muted, marginTop: space.xs },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.lg },
  action: { flexGrow: 1, flexBasis: 180, padding: space.md, gap: 2, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.background },
  actionHovered: { backgroundColor: colors.surface, borderColor: colors.borderStrong },
  actionIcon: { width: 32, height: 32, borderRadius: radius.md, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center", marginBottom: space.xs },
  actionTitle: { ...typography.bodyStrong, color: colors.ink },
  actionDetail: { ...typography.caption, color: colors.muted },
  sectionTitle: { ...typography.label, color: colors.muted, marginTop: space.xl, marginBottom: space.xs },
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: "hidden" },
}));
