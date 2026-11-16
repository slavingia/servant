import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { MediaGalleryProvider, useAttachmentContent, useMediaGallery } from "../components/MediaGallery";
import { AppIcon } from "../components/AppIcon";
import { Button } from "../components/Button";
import { request, ServerError } from "../lib/server";
import { useSession } from "../lib/session";
import { dayLabel } from "../lib/time-label";
import { formatFileSize, isPreviewImage, isPreviewVideo, mediaRoute, mergeMediaItems, readMediaPage, type MediaItem, type MediaScope } from "../lib/media";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

type Tab = "media" | "files";

// Every photo, video and file shared in a channel, DM or agent chat, newest first.
export default function FilesScreen() {
  const { kind, id, title } = useLocalSearchParams<{ kind?: string; id: string; title?: string }>();
  const scope: MediaScope = { kind: kind === "chat" ? "chat" : "conversation", id: String(id) };
  const { account } = useSession();
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!account) return;
    const controller = new AbortController();
    void (async () => {
      let collected: MediaItem[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      try {
        do {
          const response = await request(account, mediaRoute(scope, cursor), { signal: controller.signal });
          const page = readMediaPage(await response.json());
          if (controller.signal.aborted) return;
          collected = mergeMediaItems(collected, page.items);
          if (page.nextCursor !== null && seen.has(page.nextCursor)) throw new Error("Files did not advance");
          if (page.nextCursor !== null) seen.add(page.nextCursor);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        setItems(collected.reverse());
        setError(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof ServerError && [401, 403, 404].includes(e.status) ? "These files are unavailable." : "Couldn't load the files. Try again.");
      } finally {
        if (!controller.signal.aborted) setRefreshing(false);
      }
    })();
    return () => controller.abort();
    // scope is rebuilt each render from kind and id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, scope.kind, scope.id, attempt]);

  if (!account) return null;
  return <MediaGalleryProvider scope={scope} items={items ?? []}>
    <Stack.Screen options={{ title: title ? `Files · ${title}` : "Files" }} />
    <FilesBody items={items} error={error} refreshing={refreshing} onRefresh={() => { setRefreshing(true); setAttempt(a => a + 1); }} />
  </MediaGalleryProvider>;
}

function FilesBody({ items, error, refreshing, onRefresh }: { items: MediaItem[] | null; error: string | null; refreshing: boolean; onRefresh: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const media = useMemo(() => (items ?? []).filter(item => isPreviewImage(item) || isPreviewVideo(item)), [items]);
  const files = useMemo(() => (items ?? []).filter(item => !isPreviewImage(item) && !isPreviewVideo(item)), [items]);
  const [tab, setTab] = useState<Tab | null>(null);
  // Start on whichever has something in it.
  const shown: Tab = tab ?? (media.length || !files.length ? "media" : "files");
  const columns = width >= 900 ? 6 : width >= 600 ? 4 : 3;
  const contentWidth = Math.min(width, 960);
  const tile = Math.floor((contentWidth - space.side * 2 - (columns - 1) * 3) / columns);
  const refresh = <RefreshControl tintColor={colors.blue} refreshing={refreshing} onRefresh={onRefresh} />;

  if (items === null) return <View style={[styles.root, styles.center]}>
    {error ? <><Text accessibilityRole="alert" style={styles.error}>{error}</Text><Button label="Try again" kind="secondary" onPress={onRefresh} busy={refreshing} /></>
      : <ActivityIndicator accessibilityLabel="Loading files" color={colors.blue} />}
  </View>;

  const header = <View style={styles.header}>
    <View accessibilityRole="tablist" style={styles.tabs}>
      {([["media", `Photos & videos${media.length ? ` · ${media.length}` : ""}`], ["files", `Files${files.length ? ` · ${files.length}` : ""}`]] as const).map(([key, label]) =>
        <Pressable key={key} testID={`files-tab-${key}`} accessibilityRole="tab" accessibilityState={{ selected: shown === key }} aria-selected={shown === key} onPress={() => setTab(key)} style={[styles.tab, shown === key && styles.tabOn]}>
          <Text style={[styles.tabText, shown === key && styles.tabTextOn]}>{label}</Text>
        </Pressable>)}
    </View>
    {error ? <Text accessibilityRole="alert" style={styles.inlineError}>{error}</Text> : null}
  </View>;
  const empty = <View style={styles.empty}>
    <Text style={styles.emptyTitle}>{shown === "media" ? "No photos or videos yet" : "No files yet"}</Text>
  </View>;

  return shown === "media"
    ? <FlatList key={`media-${columns}`} style={styles.root} contentContainerStyle={styles.content} data={media} numColumns={columns} keyExtractor={item => item.id}
        columnWrapperStyle={columns > 1 ? styles.row : undefined} ListHeaderComponent={header} ListEmptyComponent={empty} refreshControl={refresh}
        renderItem={({ item }) => <MediaTile item={item} size={tile} />} />
    : <FlatList key="files" style={styles.root} contentContainerStyle={styles.content} data={files} keyExtractor={item => item.id}
        ListHeaderComponent={header} ListEmptyComponent={empty} refreshControl={refresh}
        renderItem={({ item }) => <FileRow item={item} />} />;
}

function MediaTile({ item, size }: { item: MediaItem; size: number }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const gallery = useMediaGallery();
  const video = isPreviewVideo(item);
  const content = useAttachmentContent(item, !video);
  return <Pressable accessibilityRole="button" accessibilityLabel={`${video ? "Video" : "Photo"} ${item.name} from ${item.sender.name}, ${shortDate(item.createdAt)}`}
    onPress={() => gallery?.open(item)} style={({ pressed }) => [styles.tile, { width: size, height: size }, pressed && styles.pressed]}>
    {content.uri ? <Image source={{ uri: content.uri }} resizeMode="cover" style={StyleSheet.absoluteFill} />
      : video ? <View style={styles.videoTile}><AppIcon name="play" size={22} color={colors.blueDark} /><Text numberOfLines={2} style={styles.videoName}>{item.name}</Text></View>
      : content.error ? <AppIcon name="image" size={22} color={colors.muted} /> : <ActivityIndicator color={colors.blue} />}
  </Pressable>;
}

function FileRow({ item }: { item: MediaItem }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const gallery = useMediaGallery();
  const type = item.name.includes(".") ? item.name.split(".").pop()!.toLowerCase().slice(0, 5) : "File";
  return <Pressable accessibilityRole="button" accessibilityLabel={`${item.name}, ${formatFileSize(item.size)}, from ${item.sender.name}, ${shortDate(item.createdAt)}`}
    onPress={() => gallery?.open(item)} style={({ pressed }) => [styles.file, pressed && { backgroundColor: colors.surface }]}>
    <View style={styles.fileIcon}><Text style={styles.fileType}>{type}</Text></View>
    <View style={styles.fileCopy}>
      <Text numberOfLines={2} style={styles.fileName}>{item.name}</Text>
      <Text style={styles.fileMeta}>{item.sender.name} · {shortDate(item.createdAt)} · {formatFileSize(item.size)}</Text>
    </View>
    <AppIcon name="chevronRight" size={18} color={colors.muted} />
  </Pressable>;
}

function shortDate(at: number) {
  if (!at) return "";
  const date = new Date(at);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return dayLabel(at);
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  center: { alignItems: "center", justifyContent: "center", gap: space.lg, padding: space.lg },
  content: { padding: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 960, alignSelf: "center" },
  header: { marginBottom: space.md },
  tabs: { flexDirection: "row", backgroundColor: colors.surface, borderRadius: radius.pill, padding: 3, width: "100%", maxWidth: 400, alignSelf: "center" },
  tab: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, paddingHorizontal: space.xs },
  tabOn: { backgroundColor: colors.background, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  tabText: { ...typography.captionStrong, color: colors.muted },
  tabTextOn: { color: colors.ink },
  row: { gap: 3, marginBottom: 3 },
  tile: { borderRadius: radius.sm, overflow: "hidden", backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  videoTile: { flex: 1, alignSelf: "stretch", alignItems: "center", justifyContent: "center", padding: space.xs, backgroundColor: colors.blueSoft },
  videoName: { ...typography.meta, color: colors.blueDark, textAlign: "center", marginTop: space.xxs },
  pressed: { opacity: 0.75 },
  file: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 64, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  fileIcon: { width: 44, height: 48, borderRadius: radius.sm, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center" },
  fileType: { ...typography.meta, fontWeight: "700", color: colors.blueDark },
  fileCopy: { flex: 1, minWidth: 0 },
  fileName: { ...typography.label, color: colors.ink },
  fileMeta: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  empty: { alignItems: "center", paddingVertical: space.xxl, gap: space.xs },
  emptyTitle: { ...typography.bodyStrong, color: colors.ink, marginTop: space.xs },
  error: { ...typography.body, color: colors.red, textAlign: "center" },
  inlineError: { ...typography.caption, color: colors.red, marginTop: space.sm },
}));
