import { useCallback } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type PressableStateCallbackType } from "react-native";
import { router, useFocusEffect, type Href } from "expo-router";
import { useLiveActions, useLiveList } from "../lib/live";
import { useSession } from "../lib/session";
import { useFeatures } from "../lib/features";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { AppIcon, type AppIconName } from "./AppIcon";
import { ConversationRow } from "./Messaging";

const hovered = (state: PressableStateCallbackType) => (state as PressableStateCallbackType & { hovered?: boolean }).hovered || state.pressed;

// The sidebar already lists every conversation, so Home starts something new.
export function DesktopHome() {
  const styles = useStyles();
  const { account } = useSession();
  const { conversations } = useLiveList();
  const { refresh } = useLiveActions();
  const features = useFeatures();
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));
  if (!account) return null;
  const recent = (conversations ?? []).filter(c => !c.archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.column}>
        <Text accessibilityRole="header" style={styles.title}>{account.serverName}</Text>
        <View style={styles.actions}>
          <Action icon="sparkles" title="Ask the agent" detail="Start a private chat" href="/agent" />
          {features.directMessages ? <Action icon="compose" title="New message" detail="Write to a teammate" href="/new-message" /> : null}
          {features.channels ? <Action icon="hash" title="Browse channels" detail="Find a conversation" href="/browse" /> : null}
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
    </Pressable>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: space.lg, paddingTop: space.xxl, paddingBottom: space.xxl, alignItems: "center" },
  column: { width: "100%", maxWidth: 680 },
  title: { ...typography.display, color: colors.ink },
  // One row shared equally, so the third never drops to a row of its own; a long title wraps inside its card.
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.lg },
  action: { flex: 1, minWidth: 0, padding: space.md, gap: space.xxs, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.background },
  actionHovered: { backgroundColor: colors.surface, borderColor: colors.borderStrong },
  actionIcon: { width: 32, height: 32, borderRadius: radius.md, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center", marginBottom: space.xs },
  actionTitle: { ...typography.bodyStrong, color: colors.ink },
  sectionTitle: { ...typography.label, color: colors.muted, marginTop: space.xl, marginBottom: space.xs },
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: "hidden" },
}));
