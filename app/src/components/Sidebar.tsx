import { useEffect, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type PressableStateCallbackType } from "react-native";
import { router, useGlobalSearchParams, usePathname, type Href } from "expo-router";
import { api, type Conversation } from "../lib/server";
import * as Clipboard from "expo-clipboard";
import { isDesktop } from "../lib/desktop";
import { useLiveActions, useLiveList, useLivePresence, useLiveUnread } from "../lib/live";
import { groupPresenceDot } from "../lib/message-status";
import { refreshProjects, useProjects } from "../lib/projects-store";
import { sortChannels, withPositions } from "../lib/channel-sort";
import { useChannelSort } from "../lib/channel-sort-store";
import { useSession } from "../lib/session";
import { openingConversation } from "../lib/conversation-cache";
import { destinationGroups, placeIsOpen } from "../lib/destinations";
import { useFeatures } from "../lib/features";
import { useSessionExpiry } from "../lib/session-expiry";
import { onBrandTint, radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { AppIcon, type AppIconName } from "./AppIcon";
import { Avatar, dmPeer } from "./Messaging";
import { NewProjectDialog } from "./NewProjectDialog";
import { DeepWorkSwitch } from "./DeepWorkSwitch";
import { PresenceDot } from "./Presence";
import { ServerSwitcher } from "./ServerSwitcher";
import { Omnibar } from "./Omnibar";
import { EmailNudge } from "./EmailNudge";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";
import { SidebarRowsSkeleton } from "./HomeSkeleton";

export const SIDEBAR_WIDTH = 264;

// The wide layout's sidebar sits on the same navy as the phone's header bar.
// Inside it, text and icons use on-navy tones; the main pane is a rounded white
// card beside it (AppChrome).
function useSidebarColors() {
  const { colors } = useTheme();
  return { ...colors, ink: colors.onBrand, muted: onBrandTint.muted, borderStrong: onBrandTint.border };
}

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
  const colors = useSidebarColors();
  const { account, deepWork } = useSession();
  const { conversations, error, connected } = useLiveList();
  const unread = useLiveUnread();
  const { expired: sessionExpired } = useSessionExpiry();
  // "Reconnecting…" is for a connection that was up and dropped. While the app is opening it has not connected
  // yet, and saying so flashed under the name on every launch; Home's own line waits for the list the same way.
  const here = connected || (conversations === null && !error && !sessionExpired);
  const { sort, pending } = useChannelSort();
  const pathname = usePathname();
  // Thread, details and files belong to a channel or DM; keep it highlighted.
  const params = useGlobalSearchParams<{ id?: string; conv?: string; kind?: string }>();
  const parentId = pathname === "/thread" ? params.conv : pathname === "/channel-info" || (pathname === "/files" && params.kind === "conversation") ? params.id : undefined;
  const isOpen = (c: Conversation) => pathname === `/c/${c.id}` || parentId === c.id;
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [channelsOpen, setChannelsOpen] = useState(true);
  const [dmsOpen, setDmsOpen] = useState(true);
  const [naming, setNaming] = useState(false);
  // Projects change rarely: re-read the list as you move around rather than on a timer.
  const projects = useProjects();
  // What this server uses (features.ts): sections and entries for the rest never render.
  const features = useFeatures();
  useEffect(() => { if (account) void refreshProjects(account); }, [pathname, account]);
  const viewer = { features, owner: account?.user.role === "owner" };
  const counts: Record<string, number> = { home: unread.channels, agent: unread.agent, messages: unread.messages };
  if (!account) return null;

  const active = (conversations ?? []).filter(c => !c.archived);
  const channels = sortChannels(withPositions(active.filter(c => c.kind === "channel"), pending), sort);
  const dms = active.filter(c => c.kind === "dm").sort((a, b) => b.updatedAt - a.updatedAt);
  const archivedCount = (conversations ?? []).filter(c => c.archived).length;
  // Opening a channel or DM from the sidebar puts the cursor in its message box, ready to type.
  const open = (c: Conversation) => { if (account) openingConversation(account, c.id); go(pathname, { pathname: "/c/[id]", params: { id: c.id, compose: "1" } }); };

  return (
    <View style={styles.root}>
      {isDesktop() ? <View {...drag} style={styles.titlebar} /> : null}
      <View style={[styles.workspace, !isDesktop() && styles.workspaceBrowser]}>
        <ServerSwitcher sidebar />
        {features.directMessages ? <Pressable accessibilityRole="button" accessibilityLabel="New message" onPress={() => go(pathname, "/new-message")} style={state => [styles.iconButton, hovered(state) && styles.hovered]}>
          <AppIcon name="compose" size={18} color={colors.ink} />
        </Pressable> : null}
      </View>
      <View style={styles.search}><Omnibar variant="sidebar" /></View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <EmailNudge compact />
        {/* Every place comes from the one list (destinations.ts), in its order; the three groups are named for a screen reader and drawn as one list. */}
        {destinationGroups("sidebar", viewer).map(entry => <View key={entry.group} role="group" aria-label={entry.title}>
          {entry.places.map(place => <NavItem key={place.id} icon={place.icon as AppIconName} label={place.label} count={counts[place.id] ?? 0}
            selected={placeIsOpen(place, pathname, params.kind, features)} onPress={() => go(pathname, place.path as Href)} />)}
        </View>)}

        <Section title="Projects" open={projectsOpen} onToggle={() => setProjectsOpen(v => !v)} addLabel="New project" onAdd={() => setNaming(true)}>
          {(projects?.list ?? []).map(p => <NavItem key={p.id} icon="project" label={p.name} selected={pathname === "/project" && params.id === p.id} onPress={() => go(pathname, { pathname: "/project", params: { id: p.id } })} />)}
          {projects && !projects.list.length ? <NavItem quiet icon="plus" label="New project" onPress={() => setNaming(true)} /> : null}
        </Section>

        {features.channels ? <Section title="Channels" open={channelsOpen} onToggle={() => setChannelsOpen(v => !v)} addLabel="Create a channel" onAdd={() => go(pathname, "/new-channel")}>
          {/* Until the list arrives, the rows the launch screen drew (HomeSkeleton.tsx) hold their places. */}
          {conversations === null && !error ? <SidebarRowsSkeleton label="Loading channels" /> : channels.map(c => <ConversationItem key={c.id} c={c} selected={isOpen(c)} onPress={() => open(c)} />)}
          <NavItem quiet icon="plus" label="Browse channels" selected={pathname === "/browse"} onPress={() => go(pathname, "/browse")} />
          {archivedCount ? <NavItem quiet icon="archive" label="Archived" count={archivedCount} countMuted selected={pathname === "/archived-channels"} onPress={() => go(pathname, "/archived-channels")} /> : null}
        </Section> : null}

        {features.directMessages ? <Section title="Chats" open={dmsOpen} onToggle={() => setDmsOpen(v => !v)} addLabel="New message" onAdd={() => go(pathname, "/new-message")}>
          {conversations === null && !error ? <SidebarRowsSkeleton label="Loading chats" count={2} /> : dms.map(c => <ConversationItem key={c.id} c={c} selected={isOpen(c)} onPress={() => open(c)} />)}
          {!dms.length && (conversations !== null || error) ? <NavItem quiet icon="plus" label="New message" onPress={() => go(pathname, "/new-message")} /> : null}
          {!features.channels && archivedCount ? <NavItem quiet icon="archive" label="Archived" count={archivedCount} countMuted selected={pathname === "/archived-channels"} onPress={() => go(pathname, "/archived-channels")} /> : null}
        </Section> : null}
      </ScrollView>
      {/* Your Deep work switch (deep-work.ts), just above your name. */}
      <DeepWorkSwitch onNavy />
      <Pressable accessibilityRole="button" accessibilityLabel={`${account.user.name}${connected && deepWork ? ", Deep work" : ""}, your profile and settings`} onPress={() => go(pathname, "/you")}
        style={state => [styles.footer, (hovered(state) || ["/you", "/notifications", "/feedback", "/leaderboard", "/entitlements", "/connections"].includes(pathname)) && styles.hovered]}>
        <View>
          <Avatar name={account.user.name} userId={account.user.id} size={30} />
          {/* Your own badge: the moon while you're in deep work (deep-work.ts), so the quiet you chose is what you see too. */}
          <PresenceDot status={!here ? "off" : deepWork ? "deepWork" : "online"} size={10} ring={colors.navy} disc={colors.navy} glyph={colors.muted} offColor={colors.borderStrong} style={styles.status} />
        </View>
        <View style={styles.footerCopy}>
          <Text style={styles.footerName}>{account.user.name}</Text>
          <Text style={styles.footerRole}>{here ? deepWork ? "Deep work" : account.user.role === "owner" ? "Owner" : "Member" : sessionExpired ? "Session ended" : "Reconnecting…"}</Text>
        </View>
      </Pressable>
      <NewProjectDialog visible={naming} onClose={() => setNaming(false)} onCreated={id => go(pathname, { pathname: "/project", params: { id } })} />
    </View>
  );
}

function Section({ title, open, onToggle, addLabel, onAdd, children }: { title: string; open: boolean; onToggle: () => void; addLabel: string; onAdd: () => void; children: ReactNode }) {
  const styles = useStyles();
  const colors = useSidebarColors();
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }} aria-expanded={open} onPress={onToggle} style={state => [styles.sectionToggle, hovered(state) && styles.hovered]}>
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
  const colors = useSidebarColors();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={count ? `${label}, ${count}` : label} accessibilityState={{ selected }} aria-current={selected ? "page" : undefined} onPress={onPress}
      style={state => [styles.item, hovered(state) && styles.hovered, selected && styles.selected]}>
      <View style={styles.itemIcon}><AppIcon name={icon} size={16} color={selected ? colors.ink : colors.muted} /></View>
      <Text style={[styles.itemLabel, quiet && styles.quietLabel, selected && styles.selectedLabel]}>{label}</Text>
      {count ? <Text style={[styles.badge, countMuted && styles.mutedBadge]}>{count > 99 ? "99+" : count}</Text> : null}
    </Pressable>
  );
}

function ConversationItem({ c, selected, onPress }: { c: Conversation; selected: boolean; onPress: () => void }) {
  const styles = useStyles();
  const colors = useSidebarColors();
  const { presence } = useLivePresence();
  const { refresh } = useLiveActions();
  const { account } = useSession();
  const bold = c.unread > 0 && !c.muted;
  // The other people in a direct message: a green dot when one is available, the moon when one is in deep work (deep-work.ts).
  const peers = c.kind === "dm" ? (c.members ?? []).filter(person => !person.agent && person.id !== account?.user.id) : [];
  const dot = groupPresenceDot(peers.map(person => presence[person.id] ?? person));
  const context = useContextMenu();
  // Right-click on a computer: what you'd otherwise open the conversation to do.
  const contextItems = (): ContextMenuItem[] => {
    const web = typeof window !== "undefined" && /^https?:$/.test(window.location?.protocol ?? "");
    return [
      { label: "Open", onPress: onPress },
      ...(bold && account ? [{ label: "Mark as read", onPress: () => { void api.markRead(account, c.id); } }] : []),
      ...(account ? [{ label: c.muted ? "Unmute" : "Mute", onPress: () => { void api.muteConversation(account, c.id, !c.muted).then(() => refresh()); } }] : []),
      ...(c.kind === "channel" ? [{ label: "Channel details", onPress: () => router.push({ pathname: "/channel-info", params: { id: c.id } }) }] : []),
      { label: "Files", onPress: () => router.push({ pathname: "/files", params: { kind: "conversation", id: c.id, title: c.title } }) },
      ...(web ? [{ separator: true as const }, { label: "Copy link", onPress: () => { void Clipboard.setStringAsync(`${window.location.origin}/c/${c.id}`); } }] : []),
    ];
  };
  return (
    <>
    <Pressable {...context.bind(contextItems)} accessibilityRole="button" accessibilityLabel={`${c.kind === "channel" ? "#" : ""}${c.title}${dot === "deepWork" ? ", Deep work" : ""}${c.muted ? ", muted" : ""}${bold ? `, ${c.unread} unread` : ""}`} accessibilityState={{ selected }} aria-current={selected ? "page" : undefined} onPress={onPress}
      style={state => [styles.item, (hovered(state) || context.open) && styles.hovered, selected && styles.selected]}>
      <View style={styles.itemIcon}>
        {c.kind === "dm" ? <View>
          <Avatar name={c.title} agent={c.agentDm} userId={dmPeer(c, account?.user.id)} size={18} onBrand />
          <PresenceDot status={dot} size={8} ring={colors.navy} disc={colors.navy} glyph={colors.muted} />
        </View> : <AppIcon name={c.private ? "lock" : "hash"} size={15} color={selected || bold ? colors.ink : colors.muted} />}
      </View>
      <Text style={[styles.itemLabel, bold && styles.unreadLabel, selected && styles.selectedLabel, c.muted && !selected && { opacity: 0.55 }]}>{c.title}</Text>
      {c.muted ? <AppIcon name="bellOff" size={14} color={colors.muted} /> : null}
      {bold ? <Text style={styles.badge}>{c.unread > 99 ? "99+" : c.unread}</Text> : null}
    </Pressable>
    {context.menu}
    </>
  );
}

const useStyles = createThemedStyles(({ colors: theme }) => { const colors = { ...theme, ink: theme.onBrand, muted: onBrandTint.muted, subtle: onBrandTint.hover }; const sidebarBackground = theme.navy; return StyleSheet.create({
  root: { width: SIDEBAR_WIDTH, flexShrink: 0, backgroundColor: sidebarBackground },
  // Clears the inset macOS traffic lights and doubles as the window drag handle.
  titlebar: { height: 38 },
  workspace: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingLeft: space.sm, paddingRight: space.xs, paddingBottom: space.xs },
  workspaceBrowser: { paddingTop: space.sm },
  workspaceMark: { width: 26, height: 26, borderRadius: radius.sm, backgroundColor: theme.onBrand, alignItems: "center", justifyContent: "center" },
  workspaceInitial: { ...typography.captionStrong, color: theme.navy },
  workspaceName: { ...typography.bodyStrong, color: colors.ink, flex: 1, minWidth: 0 },
  iconButton: { width: 32, height: 32, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  search: { paddingHorizontal: space.sm, paddingBottom: space.sm },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: space.xs, paddingBottom: space.md },
  item: { minHeight: 32, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.xs, borderRadius: radius.md },
  hovered: { backgroundColor: colors.subtle },
  selected: { backgroundColor: onBrandTint.selected },
  itemIcon: { width: 20, alignItems: "center", justifyContent: "center" },
  itemLabel: { ...typography.body, color: colors.ink, flex: 1, minWidth: 0 },
  quietLabel: { color: colors.muted },
  unreadLabel: { fontWeight: "700" },
  selectedLabel: { fontWeight: "600" },
  badge: { ...typography.captionStrong, color: theme.navy, backgroundColor: theme.onBrand, minWidth: 24, paddingHorizontal: space.xs, paddingVertical: space.xxs, borderRadius: radius.pill, textAlign: "center", overflow: "hidden" },
  mutedBadge: { color: colors.muted, backgroundColor: "transparent" },
  section: { marginTop: space.md },
  sectionHeader: { flexDirection: "row", alignItems: "center", marginBottom: 2 },
  sectionToggle: { flex: 1, minHeight: 26, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: space.xs, borderRadius: radius.sm },
  sectionTitle: { ...typography.label, color: colors.muted },
  sectionAdd: { width: 26, height: 26, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  footer: { flexDirection: "row", alignItems: "center", gap: space.sm, margin: space.xs, padding: space.xs, borderRadius: radius.md },
  status: { right: -1, bottom: -1 },
  footerCopy: { flex: 1, minWidth: 0 },
  footerName: { ...typography.captionStrong, color: colors.ink },
  footerRole: { ...typography.meta, color: colors.muted },
}); });
