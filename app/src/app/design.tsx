import { useCallback, useState } from "react";
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { AppIcon, type AppIconName } from "../components/AppIcon";
import { PageTitle } from "../components/Band";
import { Button } from "../components/Button";
import { DesignActionsSheet, type DesignAction } from "../components/DesignActionsSheet";
import { DesignReviewSheet } from "../components/DesignReviewSheet";
import { DesignThumbnail } from "../components/DesignThumbnail";
import { SkeletonRows } from "../components/Skeleton";
import { duplicateDesign } from "../lib/design-actions";
import { designChats, designCreationAccess, designPreviewPublished, designStatus, designTitle, type DesignCreationAccess } from "../lib/designs";
import { prototypePageUrl } from "../lib/prototype-adjustments";
import { api, ServerError, type Chat } from "../lib/server";
import { useSession } from "../lib/session";
import { shortTime as when } from "../lib/time-label";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

type Action = { id: string; label: string; detail: string; icon: AppIconName; run: () => void | Promise<void> };

/**
 * One design, from Design Studio: a picture of its published page and everything
 * this person can do with it. What's offered follows the server's answer about
 * whose design it is and whether it's shared, never the link that opened this.
 */
export default function DesignDetail() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const { account, setAccount } = useSession();
  const params = useLocalSearchParams<{ id?: string; title?: string }>();
  const id = String(params.id ?? "");
  const [design, setDesign] = useState<Chat | null | undefined>(undefined);
  const [own, setOwn] = useState(false);
  const [agentTier, setAgentTier] = useState<number | null | undefined>(undefined);
  const [access, setAccess] = useState<DesignCreationAccess | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [more, setMore] = useState(false);

  const load = useCallback(async () => {
    if (!account || !id) return;
    setLoadError(null);
    const [chats, projects] = await Promise.allSettled([api.orgChats(account, setAccount), api.projects(account)]);
    if (projects.status === "fulfilled") {
      const tier = projects.value.agentTier === undefined
        ? (projects.value.vibeCoder ? 2 : undefined)
        : Number.isInteger(projects.value.agentTier) ? projects.value.agentTier : null;
      setAgentTier(tier);
      setAccess(designCreationAccess(tier, projects.value.vibe));
      setOrigin(projects.value.prototypeOrigin ?? null);
    }
    if (chats.status === "fulfilled") {
      const found = designChats(chats.value.mine, chats.value.others).find(chat => chat.id === id) ?? null;
      setDesign(found);
      setOwn(chats.value.mine.some(chat => chat.id === id));
    } else {
      setLoadError(chats.reason instanceof ServerError ? chats.reason.message : "Couldn't load this design.");
      setDesign(current => current ?? null);
    }
  }, [account, setAccount, id]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  if (!account) return null;

  const title = design ? designTitle(design) : params.title || "Design";
  const header = <Stack.Screen options={{ title }} />;
  if (design === undefined) return <View style={styles.root}>{header}<SkeletonRows label="Loading the design" count={3} /></View>;
  if (!design) return <View style={styles.root}>{header}
    <View style={styles.missing}>
      <Text accessibilityRole="header" style={styles.missingTitle}>{loadError ? "Couldn't load this design" : "This design isn't available"}</Text>
      <Text accessibilityRole={loadError ? "alert" : undefined} style={styles.body}>{loadError ?? "It may have been archived by its author, or it isn't shared with you."}</Text>
      <Button label="Back to Design" kind="secondary" onPress={() => router.replace("/designs")} />
    </View>
  </View>;

  const published = designPreviewPublished(design);
  const status = designStatus(design);
  const page = published ? prototypePageUrl(design.previewUrl, origin) : null;
  const web = Platform.OS === "web";
  const author = design.author?.name ?? "its author";
  const privateForAdmin = !own && design.shared !== true;
  const run = async (actionId: string, work: () => void | Promise<void>) => {
    if (busy) return;
    setBusy(actionId);
    setActionError(null);
    try { await work(); }
    catch (e) { setActionError(e instanceof ServerError || e instanceof Error ? e.message : "That didn't work. Try again."); }
    finally { setBusy(null); }
  };
  const openChat = () => router.push({ pathname: "/chat/[id]", params: {
    id: design.id, title: design.title, studio: "1", ...(own ? {} : { readOnly: "1", author: design.author?.name ?? "" }),
  } });
  const viewPrototype = () => { if (!page) return; if (web) void Linking.openURL(page); else void WebBrowser.openBrowserAsync(page); };
  const actions: Action[] = [
    own
      ? { id: "chat", label: "Open design chat", detail: "Ask the agent for changes, or see what it built.", icon: "chat", run: openChat }
      : { id: "chat", label: "Read the design chat", detail: `See how ${author} built it. Only ${author} can ask the agent for changes.`, icon: "chat", run: openChat },
    ...(page ? [{ id: "view", label: "View prototype", detail: "Opens the live page in a new tab. Anyone with its link can open it.", icon: "eye" as const, run: viewPrototype }] : []),
    ...(page && web && (own || design.shared === true) ? [own
      ? { id: "adjust", label: "Adjust design", detail: "Change text, styles and layout on the preview, then add them to your design chat.", icon: "brush" as const, run: () => router.push({ pathname: "/adjust", params: { design: design.id } }) }
      : { id: "adjust", label: "Suggest adjustments", detail: `Change text, styles and layout on the preview, then send them to ${author}.`, icon: "brush" as const, run: () => router.push({ pathname: "/adjust", params: { design: design.id } }) }] : []),
    ...(published && (own || design.shared === true) ? [{ id: "share", label: "Share for review", detail: "Post it in a channel or direct message for feedback.", icon: "send" as const, run: () => setSharing(true) }] : []),
    ...(published ? [{ id: "versions", label: "Version history", detail: own ? "Compare or restore earlier versions." : "Look at earlier versions.", icon: "clock" as const, run: () => router.push({ pathname: "/versions", params: { chat: design.id } }) }] : []),
    ...(published && access?.canCreate ? [{ id: "duplicate", label: "Duplicate", detail: "Make your own copy to change.", icon: "copy" as const, run: async () => {
      const copy = await duplicateDesign(account, design, agentTier);
      router.push({ pathname: "/chat/[id]", params: { id: copy.id, title: copy.title, studio: "1" } });
    } }] : []),
    ...(agentTier === 4 && status === "Published" ? [{ id: "study", label: "Use in a study plan", detail: "Opens a study plan with this prototype.", icon: "research" as const, run: () => router.push({ pathname: "/research-new", params: { kind: "study", prototype: design.id } }) }] : []),
  ];
  const moreActions: DesignAction[] = own ? [design.archived
    ? { id: "unarchive", label: "Move back to designs", icon: "archive", run: async () => { await api.restoreChat(account, design.id); setMore(false); await load(); } }
    : { id: "archive", label: "Archive", icon: "archive", hint: "Hides it from your list. Its page and link keep working.", run: async () => { await api.archiveChat(account, design.id); setMore(false); router.replace("/designs"); } }] : [];

  // A picture of the page: the top of it at desktop width on wide screens, at phone width otherwise.
  const pictureWidth = wide ? Math.min(720, width - 360) : Math.min(width - 2 * space.side, 420);
  const pictureHeight = Math.round(pictureWidth * (wide ? 0.6 : 1.25));
  return <View style={styles.root}>
    {header}
    <ScrollView contentContainerStyle={styles.content}>
      <PageTitle description={[status, own ? "Yours" : `by ${author}`, `Updated ${when(design.updatedAt)}`, ...(privateForAdmin ? ["Private · visible to admins"] : [])].join(" · ")}>{title}</PageTitle>
      <View style={[styles.layout, wide && styles.layoutWide]}>
        <View style={styles.pictureColumn}>
          {page
            ? <DesignThumbnail url={design.previewUrl} origin={origin} width={pictureWidth} height={pictureHeight} pageWidth={wide ? 1280 : 390} />
            : <View style={[styles.placeholder, { width: pictureWidth, height: pictureHeight }]}>
              <AppIcon name="brush" size={28} color={colors.blueDark} />
              <Text style={styles.placeholderText}>{status === "Building"
                ? "The agent is building the first version. A picture of the page appears here as soon as it's published."
                : "No page yet. A picture appears here as soon as the agent publishes the first version."}</Text>
            </View>}
          <Text style={styles.caption}>{page ? (web ? "The top of the published page, as it looks now." : "Open the prototype to see the page.") : " "}</Text>
        </View>
        <View style={styles.actionsColumn}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>What you can do</Text>
          <View accessibilityRole="list" style={styles.actions}>
            {actions.map(action => <Pressable key={action.id} accessibilityRole="button" accessibilityLabel={action.label} accessibilityHint={action.detail}
              accessibilityState={{ busy: busy === action.id, disabled: !!busy }} disabled={!!busy} onPress={() => { void run(action.id, action.run); }}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
              <View style={styles.actionIcon}><AppIcon name={action.icon} size={18} color={colors.blueDark} /></View>
              <View style={styles.actionCopy}>
                <Text style={styles.actionTitle}>{busy === action.id ? `${action.label}…` : action.label}</Text>
                <Text style={styles.actionDetail}>{action.detail}</Text>
              </View>
              <AppIcon name="chevronRight" size={16} color={colors.muted} />
            </Pressable>)}
          </View>
          {own ? <Button label="Rename or archive" kind="link" compact onPress={() => setMore(true)} accessibilityHint="Rename this design, or archive it" /> : null}
          {actionError ? <Text accessibilityRole="alert" style={styles.error}>{actionError}</Text> : null}
        </View>
      </View>
    </ScrollView>
    {sharing ? <DesignReviewSheet design={design} onClose={() => setSharing(false)} /> : null}
    {more ? <DesignActionsSheet title={title} actions={moreActions} onClose={() => setMore(false)}
      onRename={async name => {
        try { await api.renameChat(account, design.id, name); } catch (e) { throw e instanceof ServerError ? new Error(e.message) : e; }
        setMore(false);
        await load();
      }} /> : null}
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: space.xxl },
  layout: { gap: space.lg, paddingHorizontal: space.side },
  layoutWide: { flexDirection: "row", alignItems: "flex-start" },
  pictureColumn: { gap: space.xs },
  placeholder: { alignItems: "center", justifyContent: "center", gap: space.sm, padding: space.lg, borderRadius: radius.md, backgroundColor: colors.blueSoft },
  placeholderText: { ...typography.body, color: colors.ink, textAlign: "center", maxWidth: 320 },
  caption: { ...typography.meta, color: colors.muted },
  actionsColumn: { flex: 1, minWidth: 0, gap: space.sm },
  sectionTitle: { ...typography.heading, color: colors.ink },
  actions: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  action: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 56, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  pressed: { backgroundColor: colors.surface },
  actionIcon: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.blueSoft },
  actionCopy: { flex: 1, minWidth: 0 },
  actionTitle: { ...typography.bodyStrong, color: colors.ink },
  actionDetail: { ...typography.caption, color: colors.muted },
  error: { ...typography.caption, color: colors.red },
  missing: { alignItems: "flex-start", gap: space.sm, padding: space.side },
  missingTitle: { ...typography.heading, color: colors.ink },
  body: { ...typography.body, color: colors.muted },
}));
