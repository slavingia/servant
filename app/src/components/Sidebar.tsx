import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type PressableStateCallbackType } from "react-native";
import { router, usePathname, type Href } from "expo-router";
import { type Conversation } from "../lib/server";
import { isDesktop } from "../lib/desktop";
import { useLive } from "../lib/live";
import { useSession } from "../lib/session";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { AppIcon, type AppIconName } from "./AppIcon";
import { Avatar } from "./Messaging";
import { Omnibar } from "./Omnibar";

export const SIDEBAR_WIDTH = 264;

// Top-level destinations live in tabs; everything else is pushed on the stack.
const TAB_PATHS = ["/channels", "/messages", "/agent", "/members", "/you"];

// Sidebar links swap the main pane rather than build a back stack.
function go(pathname: string, href: Href) {
  const target = typeof href === "string" ? href : href.pathname;
  if (TAB_PATHS.includes(target)) router.dismissTo(href);
  else if (TAB_PATHS.includes(pathname) || pathname === "/") router.push(href);
  else router.replace(href);
}

const hovered = (state: PressableStateCallbackType) => (state as PressableStateCallbackType & { hovered?: boolean }).hovered || state.pressed;

// Electron drag regions; buttons inside one must opt back out to stay clickable.
const drag = { dataSet: { servantDrag: "on" } } as object;

export function Sidebar() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const { conversations, unread, connected } = useLive();
  const pathname = usePathname();
  const [channelsOpen, setChannelsOpen] = useState(true);
  const [dmsOpen, setDmsOpen] = useState(true);
  if (!account) return null;

  const active = (conversations ?? []).filter(c => !c.archived);
  const channels = active.filter(c => c.kind === "channel").sort((a, b) => a.title.localeCompare(b.title));
  const dms = active.filter(c => c.kind === "dm").sort((a, b) => b.updatedAt - a.updatedAt);
  const archivedCount = (conversations ?? []).filter(c => c.archived).length;
  const open = (c: Conversation) => go(pathname, { pathname: "/c/[id]", params: { id: c.id } });

  return (
    <View style={styles.root}>
      {isDesktop() ? <View {...drag} style={styles.titlebar} /> : null}
      <View style={[styles.workspace, !isDesktop() && styles.workspaceBrowser]}>
        <View style={styles.workspaceMark}><Text style={styles.workspaceInitial}>{account.serverName.slice(0, 1).toUpperCase() || "S"}</Text></View>
        <Text accessibilityRole="header" numberOfLines={1} style={styles.workspaceName}>{account.serverName}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="New message" onPress={() => go(pathname, "/new-message")} style={state => [styles.iconButton, hovered(state) && styles.hovered]}>
          <AppIcon name="compose" size={18} color={colors.ink} />
        </Pressable>
      </View>
      <View style={styles.search}><Omnibar variant="sidebar" /></View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <NavItem icon="home" label="Home" selected={pathname === "/channels" || pathname === "/"} onPress={() => go(pathname, "/channels")} />
        <NavItem icon="sparkles" label="Agent" selected={pathname === "/agent" || pathname.startsWith("/chat/")} onPress={() => go(pathname, "/agent")} />
        <NavItem icon="chat" label="Direct messages" count={unread.messages} selected={pathname === "/messages"} onPress={() => go(pathname, "/messages")} />
        <NavItem icon="people" label="People" selected={pathname === "/members"} onPress={() => go(pathname, "/members")} />

        <Section title="Channels" open={channelsOpen} onToggle={() => setChannelsOpen(v => !v)} addLabel="Create a channel" onAdd={() => go(pathname, "/new-channel")}>
          {channels.map(c => <ConversationItem key={c.id} c={c} selected={pathname === `/c/${c.id}`} onPress={() => open(c)} />)}
          <NavItem quiet icon="plus" label="Browse channels" selected={pathname === "/browse"} onPress={() => go(pathname, "/browse")} />
          {archivedCount ? <NavItem quiet icon="archive" label="Archived" count={archivedCount} countMuted selected={pathname === "/archived-channels"} onPress={() => go(pathname, "/archived-channels")} /> : null}
        </Section>

        <Section title="Direct messages" open={dmsOpen} onToggle={() => setDmsOpen(v => !v)} addLabel="New direct message" onAdd={() => go(pathname, "/new-message")}>
          {dms.map(c => <ConversationItem key={c.id} c={c} selected={pathname === `/c/${c.id}`} onPress={() => open(c)} />)}
          {!dms.length ? <NavItem quiet icon="plus" label="New message" onPress={() => go(pathname, "/new-message")} /> : null}
        </Section>
      </ScrollView>
      <Pressable accessibilityRole="button" accessibilityLabel={`${account.user.name}, your profile and settings`} onPress={() => go(pathname, "/you")}
        style={state => [styles.footer, (hovered(state) || pathname === "/you") && styles.hovered]}>
        <View>
          <Avatar name={account.user.name} size={30} />
          <View style={[styles.status, { backgroundColor: connected ? colors.green : colors.borderStrong }]} />
        </View>
        <View style={styles.footerCopy}>
          <Text numberOfLines={1} style={styles.footerName}>{account.user.name}</Text>
          <Text numberOfLines={1} style={styles.footerRole}>{connected ? (account.user.role === "owner" ? "Owner" : "Member") : "Reconnecting…"}</Text>
        </View>
      </Pressable>
    </View>
  );
}

function Section({ title, open, onToggle, addLabel, onAdd, children }: { title: string; open: boolean; onToggle: () => void; addLabel: string; onAdd: () => void; children: ReactNode }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }} onPress={onToggle} style={state => [styles.sectionToggle, hovered(state) && styles.hovered]}>
          <AppIcon name={open ? "chevronDown" : "chevronRight"} size={12} strokeWidth={2.2} color={colors.muted} />
          <Text style={styles.sectionTitle}>{title}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={addLabel} onPress={onAdd} style={state => [styles.sectionAdd, hovered(state) && styles.hovered]}>
          <AppIcon name="plus" size={14} color={colors.muted} />
        </Pressable>
      </View>
      {open ? children : null}
    </View>
  );
}

function NavItem({ icon, label, selected = false, quiet = false, count = 0, countMuted = false, onPress }: { icon: AppIconName; label: string; selected?: boolean; quiet?: boolean; count?: number; countMuted?: boolean; onPress: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={count ? `${label}, ${count}` : label} accessibilityState={{ selected }} onPress={onPress}
      style={state => [styles.item, hovered(state) && styles.hovered, selected && styles.selected]}>
      <View style={styles.itemIcon}><AppIcon name={icon} size={16} color={selected ? colors.ink : colors.muted} /></View>
      <Text numberOfLines={1} style={[styles.itemLabel, quiet && styles.quietLabel, selected && styles.selectedLabel]}>{label}</Text>
      {count ? <Text style={[styles.badge, countMuted && styles.mutedBadge]}>{count > 99 ? "99+" : count}</Text> : null}
    </Pressable>
  );
}

function ConversationItem({ c, selected, onPress }: { c: Conversation; selected: boolean; onPress: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { presence } = useLive();
  const { account } = useSession();
  const bold = c.unread > 0;
  const peer = c.kind === "dm" ? c.members?.find(person => !person.agent && person.id !== account?.user.id && (presence[person.id]?.online ?? person.online)) : undefined;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${c.kind === "channel" ? "#" : ""}${c.title}${bold ? `, ${c.unread} unread` : ""}`} accessibilityState={{ selected }} onPress={onPress}
      style={state => [styles.item, hovered(state) && styles.hovered, selected && styles.selected]}>
      <View style={styles.itemIcon}>
        {c.kind === "dm" ? <View>
          <Avatar name={c.title} size={18} />
          {peer ? <View style={[styles.dmStatus, { backgroundColor: colors.green }]} /> : null}
        </View> : <AppIcon name={c.private ? "lock" : "hash"} size={15} color={selected || bold ? colors.ink : colors.muted} />}
      </View>
      <Text numberOfLines={1} style={[styles.itemLabel, bold && styles.unreadLabel, selected && styles.selectedLabel]}>{c.title}</Text>
      {bold ? <Text style={styles.badge}>{c.unread > 99 ? "99+" : c.unread}</Text> : null}
    </Pressable>
  );
}

const useStyles = createThemedStyles(({ colors, scheme }) => StyleSheet.create({
  root: { width: SIDEBAR_WIDTH, flexShrink: 0, backgroundColor: scheme === "dark" ? "#0D1116" : colors.surface, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.line },
  // Clears the inset macOS traffic lights and doubles as the window drag handle.
  titlebar: { height: 38 },
  workspace: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingLeft: space.sm, paddingRight: space.xs, paddingBottom: space.xs },
  workspaceBrowser: { paddingTop: space.sm },
  workspaceMark: { width: 26, height: 26, borderRadius: radius.sm, backgroundColor: colors.navy, alignItems: "center", justifyContent: "center" },
  workspaceInitial: { ...typography.captionStrong, color: colors.onBrand },
  workspaceName: { ...typography.bodyStrong, color: colors.ink, flex: 1, minWidth: 0 },
  iconButton: { width: 32, height: 32, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  search: { paddingHorizontal: space.sm, paddingBottom: space.sm },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: space.xs, paddingBottom: space.md },
  item: { minHeight: 32, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.xs, borderRadius: radius.md },
  hovered: { backgroundColor: colors.subtle },
  selected: { backgroundColor: scheme === "dark" ? colors.subtle : "#E4E8EE" },
  itemIcon: { width: 20, alignItems: "center", justifyContent: "center" },
  itemLabel: { fontSize: 14, lineHeight: 20, color: colors.ink, flex: 1, minWidth: 0 },
  quietLabel: { color: colors.muted },
  unreadLabel: { fontWeight: "700" },
  selectedLabel: { fontWeight: "600" },
  badge: { ...typography.meta, fontWeight: "600", color: colors.onPrimary, backgroundColor: colors.primary, minWidth: 20, paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.pill, textAlign: "center", overflow: "hidden" },
  mutedBadge: { color: colors.muted, backgroundColor: "transparent" },
  dmStatus: { position: "absolute", right: -2, bottom: -2, width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: scheme === "dark" ? "#0D1116" : colors.surface },
  section: { marginTop: space.md },
  sectionHeader: { flexDirection: "row", alignItems: "center", marginBottom: 2 },
  sectionToggle: { flex: 1, minHeight: 26, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: space.xs, borderRadius: radius.sm },
  sectionTitle: { ...typography.meta, fontWeight: "600", color: colors.muted },
  sectionAdd: { width: 26, height: 26, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  footer: { flexDirection: "row", alignItems: "center", gap: space.sm, margin: space.xs, padding: space.xs, borderRadius: radius.md },
  status: { position: "absolute", right: -1, bottom: -1, width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: scheme === "dark" ? "#0D1116" : colors.surface },
  footerCopy: { flex: 1, minWidth: 0 },
  footerName: { ...typography.captionStrong, color: colors.ink },
  footerRole: { ...typography.meta, color: colors.muted },
}));
