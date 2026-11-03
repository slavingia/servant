import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { ActivityIndicator, Animated, FlatList, Image, Keyboard, Modal, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { request, ServerError, type Account, type Attachment } from "../lib/server";
import { useSession } from "../lib/session";
import { createMediaCache, formatFileSize, isPreviewImage, isPreviewVideo, MAX_FILE_BYTES, MAX_VIDEO_BYTES, mediaRoute, mergeMediaItems, readMediaPage, type MediaItem, type MediaScope } from "../lib/media";
import { radius, space, typography } from "../lib/theme";
import { canStartGalleryDismiss, shouldDismissGallery } from "../lib/gallery-gestures";
import { AppIcon } from "./AppIcon";
import { GalleryVideo } from "./VideoMedia";
import { GalleryContext, useMediaGallery } from "./MediaGalleryContext";
export { useMediaGallery } from "./MediaGalleryContext";

export function MediaGalleryProvider({ scope, items, children }: { scope?: MediaScope; items: MediaItem[]; children: ReactNode }) {
  const { account } = useSession();
  if (!account) return <>{children}</>;
  // A change of account, encryption pin, or conversation discards all private
  // content and pending requests, including an open modal.
  return <ScopedGallery key={`${account.serverUrl}:${account.token}:${account.serverKey ?? ""}:${scope?.kind ?? "local"}:${scope?.id ?? ""}`} account={account} scope={scope} items={items}>
    {children}
  </ScopedGallery>;
}

function ScopedGallery({ account, scope, items, children }: { account: Account; scope?: MediaScope; items: MediaItem[]; children: ReactNode }) {
  const [opened, setOpened] = useState<Attachment | null>(null);
  const [cache] = useState(() => createMediaCache(async (file, signal) => {
    const response = await request(account, `/v1/attachments/${encodeURIComponent(file.id)}`, { signal });
    const value = await response.json();
    const maxBytes = isPreviewImage(file) ? MAX_FILE_BYTES : MAX_VIDEO_BYTES;
    if (typeof value.data !== "string" || value.data.length > Math.ceil(maxBytes / 3) * 4 || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw new Error("Attachment content is unavailable");
    return value.data;
  }));
  useEffect(() => () => cache.dispose(), [cache]);
  const open = useCallback((file: Attachment) => { Keyboard.dismiss(); setOpened(file); }, []);
  const close = useCallback(() => setOpened(null), []);
  const context = useMemo(() => ({ open, load: cache.load, invalidate: cache.invalidate }), [cache, open]);
  return <GalleryContext.Provider value={context}>
    {children}
    {opened ? <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={close}>
      <SafeAreaProvider>
        <GalleryContent account={account} scope={scope} seeds={items} opened={opened} onClose={close} />
      </SafeAreaProvider>
    </Modal> : null}
  </GalleryContext.Provider>;
}

export function useAttachmentContent(file: Attachment, enabled = true) {
  const { id, name, mime, size } = file;
  const gallery = useMediaGallery();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: string; error?: string } | null>(null);
  const key = `${id}:${attempt}`;
  const current = result?.key === key ? result : null;
  const load = gallery?.load;
  useEffect(() => {
    if (!enabled || !load) return;
    let active = true;
    load({ id, name, mime, size }).then(data => { if (active) setResult({ key, data }); }, () => { if (active) setResult({ key, error: "Couldn't load this attachment." }); });
    return () => { active = false; };
  }, [enabled, id, name, mime, size, key, load]);
  const retry = useCallback(() => { gallery?.invalidate(id); setAttempt(value => value + 1); }, [id, gallery]);
  return { data: current?.data, uri: current?.data ? `data:${mime};base64,${current.data}` : undefined, error: current?.error, loading: enabled && !!load && !current, retry };
}

/** Native files are temporary, and the browser receives a local Blob URL only. */
export async function shareAttachment(file: Attachment, data: string) {
  const filename = file.name.replace(/[/\\\u0000-\u001f]/g, "_").slice(0, 180) || "attachment";
  if (Platform.OS === "web") {
    const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
    const link = document.createElement("a");
    link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return;
  }
  if (!await Sharing.isAvailableAsync()) throw new Error("Sharing is unavailable on this device");
  const local = new File(Paths.cache, `${Date.now()}-${filename}`);
  try {
    // SDK 58 made File.write async. Without the await, the share sheet looked
    // for a file that wasn't written yet and failed for every attachment.
    await local.write(data, { encoding: "base64" });
    await Sharing.shareAsync(local.uri, { mimeType: file.mime, dialogTitle: file.name });
  } finally { if (local.exists) local.delete(); }
}

type GalleryResult = { attempt: number; items: MediaItem[]; complete: boolean; error?: string; denied?: boolean };

function GalleryContent({ account, scope, seeds, opened, onClose }: { account: Account; scope?: MediaScope; seeds: MediaItem[]; opened: Attachment; onClose: () => void }) {
  const scopeId = scope?.id;
  const scopeKind = scope?.kind;
  const window = useWindowDimensions();
  const [viewport, setViewport] = useState({ width: window.width, height: Math.max(1, window.height - 220) });
  const [activeId, setActiveId] = useState(opened.id);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<GalleryResult>({ attempt: 0, items: [], complete: !scope });
  const [zoomed, setZoomed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [shareError, setShareError] = useState("");
  const [dismissOffset] = useState(() => new Animated.Value(0));
  const dismissCancelled = useRef(false);
  const list = useRef<FlatList<MediaItem>>(null);
  const closeButton = useRef<ComponentRef<typeof View>>(null);
  const mounted = useRef(true);
  const gallery = useMediaGallery()!;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const page = result.attempt === attempt ? result : { attempt, items: [], complete: !scope };
  const loading = !page.complete && !page.error;
  useEffect(() => {
    if (!scopeId || !scopeKind) return;
    const controller = new AbortController();
    let collected: MediaItem[] = [];
    void (async () => {
      let cursor: string | undefined;
      const seen = new Set<string>();
      try {
        do {
          const response = await request(account, mediaRoute({ id: scopeId, kind: scopeKind }, cursor), { signal: controller.signal });
          const next = readMediaPage(await response.json());
          if (controller.signal.aborted) return;
          collected = mergeMediaItems(collected, next.items);
          if (next.nextCursor !== null && seen.has(next.nextCursor)) throw new Error("Gallery pagination did not advance");
          if (next.nextCursor !== null) seen.add(next.nextCursor);
          setResult({ attempt, items: collected, complete: next.nextCursor === null });
          cursor = next.nextCursor ?? undefined;
        } while (cursor);
      } catch (error) {
        if (controller.signal.aborted) return;
        const denied = error instanceof ServerError && [401, 403, 404].includes(error.status);
        setResult({ attempt, items: collected, complete: false, denied, error: denied ? "This conversation's files are unavailable." : "Couldn't load the full conversation." });
      }
    })();
    return () => controller.abort();
  }, [account, attempt, scopeId, scopeKind]);

  const fallback = useMemo<MediaItem>(() => ({ ...opened, messageId: "", sender: { id: "", name: "" }, createdAt: 0 }), [opened]);
  const items = useMemo(() => page.denied ? [] : scope && page.complete ? page.items : mergeMediaItems([fallback], seeds, page.items), [fallback, page.complete, page.denied, page.items, scope, seeds]);
  const index = Math.max(0, items.findIndex(item => item.id === activeId));
  const selected = items[index];
  const selectedId = selected?.id;
  // Older metadata may arrive before the tapped image. Keep its ID selected,
  // not its former array index, so pages can never jump the visible content.
  useLayoutEffect(() => {
    if (items.length) list.current?.scrollToOffset({ offset: viewport.width * index, animated: false });
  }, [index, items.length, selectedId, viewport.width]);

  const move = useCallback((delta: number) => {
    const next = items[index + delta];
    if (!next) return;
    setZoomed(false); setShareError(""); setActiveId(next.id);
  }, [index, items]);
  const settlePage = useCallback((offset: number) => {
    const next = items[Math.min(items.length - 1, Math.max(0, Math.round(offset / viewport.width)))];
    setDragging(false);
    if (next) { setActiveId(next.id); setShareError(""); setZoomed(false); }
  }, [items, viewport.width]);
  const restorePage = useCallback(() => {
    setDragging(false);
    list.current?.scrollToOffset({ offset: viewport.width * index, animated: false });
  }, [index, viewport.width]);
  const dismissGesture = useMemo(() => {
    const reset = () => {
      restorePage();
      setDismissing(false);
      Animated.spring(dismissOffset, { toValue: 0, speed: 24, bounciness: 0, useNativeDriver: true }).start();
    };
    // create only registers these callbacks; refs are read during gestures.
    // eslint-disable-next-line react-hooks/refs
    return PanResponder.create({
      // Leave taps, horizontal paging, video controls and pinch gestures alone.
      // Capture only after a single finger has committed to a downward drag.
      onStartShouldSetPanResponderCapture: (_, gesture) => {
        dismissCancelled.current = gesture.numberActiveTouches !== 1;
        return false;
      },
      onMoveShouldSetPanResponderCapture: (_, gesture) => !dismissCancelled.current && !zoomed && !sharing && canStartGalleryDismiss(gesture),
      onPanResponderStart: (_, gesture) => { if (gesture.numberActiveTouches > 1) dismissCancelled.current = true; },
      onPanResponderGrant: () => {
        dismissOffset.stopAnimation();
        restorePage();
        setDismissing(true);
      },
      onPanResponderMove: (_, gesture) => {
        if (gesture.numberActiveTouches !== 1) dismissCancelled.current = true;
        if (!dismissCancelled.current) dismissOffset.setValue(Math.max(0, gesture.dy));
      },
      onPanResponderRelease: (_, gesture) => {
        if (!dismissCancelled.current && shouldDismissGallery(gesture, viewport.height)) onClose();
        else reset();
      },
      onPanResponderTerminate: reset,
      onPanResponderTerminationRequest: () => true,
    });
  }, [dismissOffset, onClose, restorePage, sharing, viewport.height, zoomed]);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    closeButton.current?.focus();
  }, []);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
      if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [move, onClose]);
  const share = async () => {
    if (!selected || sharing) return;
    setSharing(true); setShareError("");
    try { await shareAttachment(selected, await gallery.load(selected)); }
    catch { if (mounted.current) setShareError("Couldn't open this file. Try again."); }
    finally { if (mounted.current) setSharing(false); }
  };

  const date = selected?.createdAt ? new Date(selected.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  // Native padding uses the modal's own safe area, not AppChrome's consumed
  // top inset. It also updates without waiting for a JS inset/layout roundtrip.
  return <SafeAreaView accessibilityViewIsModal onAccessibilityEscape={onClose} style={styles.root}>
    <StatusBar style="light" />
    <View style={styles.header}>
      <Pressable ref={closeButton} testID="gallery-close" accessibilityRole="button" accessibilityLabel="Close gallery" onPress={onClose} hitSlop={4} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}><AppIcon name="close" color="#FFFFFF" size={23} /></Pressable>
      <View style={styles.headerCopy}>
        <Text style={styles.counter} accessibilityLiveRegion="polite">{selected ? `${index + 1} of ${items.length}${page.complete ? "" : " loaded"}` : "Conversation files"}</Text>
        <Text style={styles.galleryLabel}>Shared in this conversation</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={Platform.OS === "web" ? "Download attachment" : "Share attachment"} accessibilityState={{ disabled: sharing || !selected, busy: sharing }} disabled={sharing || !selected} onPress={() => void share()} style={styles.shareButton}>
        {sharing ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.actionText}>{Platform.OS === "web" ? "Save" : "Share"}</Text>}
      </Pressable>
    </View>
    {loading ? <View style={styles.notice}><ActivityIndicator size="small" color="#C5CFDB" /><Text style={styles.note}>Loading conversation files…</Text></View> : null}
    {page.error ? <View style={styles.notice}><Text accessibilityRole="alert" style={styles.note}>{page.error}</Text><Pressable accessibilityRole="button" onPress={() => setAttempt(value => value + 1)} style={styles.retry}><Text style={styles.actionText}>Retry</Text></Pressable></View> : null}
    <View style={styles.viewport} onLayout={event => {
      const { width, height } = event.nativeEvent.layout;
      if (width > 0 && height > 0 && (width !== viewport.width || height !== viewport.height)) setViewport({ width, height });
    }}>
      <Animated.View {...dismissGesture.panHandlers} style={[styles.gestureSurface, {
        transform: [{ translateY: dismissOffset }],
        opacity: dismissOffset.interpolate({ inputRange: [0, Math.max(1, viewport.height)], outputRange: [1, 0.35], extrapolate: "clamp" }),
      }]}>
      {items.length ? <FlatList ref={list} data={items} horizontal pagingEnabled scrollEnabled={!zoomed && !dismissing} showsHorizontalScrollIndicator={false} directionalLockEnabled
        accessibilityLabel="Conversation attachment gallery" initialScrollIndex={index} initialNumToRender={1} maxToRenderPerBatch={3} windowSize={3} removeClippedSubviews={false}
        keyExtractor={item => item.id} getItemLayout={(_, itemIndex) => ({ length: viewport.width, offset: viewport.width * itemIndex, index: itemIndex })}
        extraData={{ index, viewport, dragging, dismissing, sharing }} onScrollBeginDrag={() => setDragging(true)} onScrollEndDrag={event => {
          // A slow drag can finish without a momentum event.
          if (!event.nativeEvent.velocity?.x) settlePage(event.nativeEvent.contentOffset.x);
        }} onMomentumScrollEnd={event => settlePage(event.nativeEvent.contentOffset.x)}
        renderItem={({ item, index: itemIndex }) => <GalleryPage item={item} width={viewport.width} height={viewport.height} active={itemIndex === index} nearby={Math.abs(itemIndex - index) <= 1} playingAllowed={itemIndex === index && !dragging} autoPlay={item.id === opened.id} zoomMode={itemIndex === index && zoomed} onZoomChange={setZoomed} onOpenFile={() => void share()} busy={sharing} />}
      /> : <View style={styles.center}><Text style={styles.emptyTitle}>Attachment unavailable</Text><Text style={styles.note}>It may have been removed from this conversation.</Text></View>}
      </Animated.View>
    </View>
    {shareError ? <Text accessibilityRole="alert" style={styles.shareError}>{shareError}</Text> : null}
    <View style={styles.footer}>
      <View style={styles.caption}>
        {selected ? <><Text numberOfLines={1} style={styles.filename}>{selected.name}</Text>
          <Text numberOfLines={1} style={styles.note}>{[selected.sender.name, date, formatFileSize(selected.size)].filter(Boolean).join(" · ")}</Text>
          {selected.text ? <Text numberOfLines={2} style={styles.messageCaption}>{selected.text.replace(/\s+/g, " ")}</Text> : null}</> : null}
      </View>
      <View style={styles.navigation}>
        <Pressable accessibilityRole="button" accessibilityLabel="Previous attachment" accessibilityState={{ disabled: index === 0 || !items.length }} disabled={index === 0 || !items.length} onPress={() => move(-1)} style={[styles.navButton, index === 0 && styles.disabled]}><AppIcon name="chevronRight" color="#FFFFFF" size={20} /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Next attachment" accessibilityState={{ disabled: index >= items.length - 1 }} disabled={index >= items.length - 1} onPress={() => move(1)} style={[styles.navButton, styles.nextButton, index >= items.length - 1 && styles.disabled]}><AppIcon name="chevronRight" color="#FFFFFF" size={20} /></Pressable>
      </View>
    </View>
  </SafeAreaView>;
}

function GalleryPage({ item, width, height, active, nearby, playingAllowed, autoPlay, zoomMode, onZoomChange, onOpenFile, busy }: { item: MediaItem; width: number; height: number; active: boolean; nearby: boolean; playingAllowed: boolean; autoPlay: boolean; zoomMode: boolean; onZoomChange: (value: boolean) => void; onOpenFile: () => void; busy: boolean }) {
  const image = isPreviewImage(item);
  const video = isPreviewVideo(item);
  const content = useAttachmentContent(item, image && nearby);
  const [decodeError, setDecodeError] = useState(false);
  const retry = () => { setDecodeError(false); content.retry(); };
  return <View style={{ width, height }} accessibilityElementsHidden={!active} importantForAccessibility={active ? "auto" : "no-hide-descendants"}>
    {video ? playingAllowed ? <GalleryVideo key={item.id} file={item} autoPlay={autoPlay} paused={busy} /> : <View style={styles.center}><Text style={styles.note}>Video</Text></View>
      : image ? content.error || decodeError ? <View style={styles.center}><Text style={styles.emptyTitle}>Image unavailable</Text><Text style={styles.note}>Try loading the image again.</Text><Pressable accessibilityRole="button" onPress={retry} style={styles.fileAction}><Text style={styles.actionText}>Retry image</Text></Pressable></View>
      : content.uri ? <View style={styles.zoom}>
        {zoomMode ? <ScrollView style={styles.zoom} contentContainerStyle={{ width, height }} maximumZoomScale={4} minimumZoomScale={1} centerContent bounces={false} bouncesZoom={false} showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false}>
          <Image source={{ uri: content.uri }} resizeMode="contain" accessibilityLabel={item.name} style={{ width, height }} onError={() => setDecodeError(true)} />
        </ScrollView> : <Image source={{ uri: content.uri }} resizeMode="contain" accessibilityLabel={item.name} style={{ width, height }} onError={() => setDecodeError(true)} />}
        {Platform.OS === "ios" && active ? <Pressable accessibilityRole="button" accessibilityLabel={zoomMode ? "Fit image and return to swipe browsing" : "Zoom image"} onPress={() => onZoomChange(!zoomMode)} style={styles.zoomButton}><Text style={styles.actionText}>{zoomMode ? "Fit" : "Zoom"}</Text></Pressable> : null}
      </View> : <View style={styles.center}><ActivityIndicator size="large" color="#FFFFFF" /><Text style={styles.note}>Loading image…</Text></View>
      : <View style={styles.center}><View style={styles.fileSymbol}><AppIcon name="paperclip" color="#C5CFDB" size={42} /></View><Text numberOfLines={3} style={styles.emptyTitle}>{item.name}</Text><Text style={styles.note}>{item.mime} · {formatFileSize(item.size)}</Text><Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={onOpenFile} style={styles.fileAction}><Text style={styles.actionText}>{busy ? "Opening…" : "Open file"}</Text></Pressable></View>}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#101318" },
  header: { minHeight: 64, paddingHorizontal: space.sm, paddingVertical: space.xs, flexDirection: "row", alignItems: "center", gap: space.xs, zIndex: 1 },
  iconButton: { width: 48, height: 48, borderRadius: radius.pill, backgroundColor: "#283442", alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.65 },
  headerCopy: { flex: 1, alignItems: "center" },
  counter: { ...typography.bodyStrong, color: "#FFFFFF" },
  galleryLabel: { ...typography.meta, color: "#BAC3CF", marginTop: 1 },
  shareButton: { minWidth: 56, minHeight: 48, alignItems: "center", justifyContent: "center", paddingHorizontal: space.xs },
  actionText: { ...typography.captionStrong, color: "#FFFFFF" },
  notice: { paddingHorizontal: space.side, flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: space.xs, minHeight: 36 },
  note: { ...typography.caption, color: "#BAC3CF", textAlign: "center", flexShrink: 1 },
  retry: { minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: space.xs },
  viewport: { flex: 1, minHeight: 0, overflow: "hidden" },
  gestureSurface: { flex: 1 },
  zoom: { flex: 1 },
  zoomButton: { position: "absolute", top: space.sm, right: space.side, minHeight: 44, minWidth: 60, paddingHorizontal: space.sm, borderRadius: radius.pill, backgroundColor: "#202630DD", alignItems: "center", justifyContent: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.lg, gap: space.sm },
  emptyTitle: { ...typography.heading, color: "#FFFFFF", textAlign: "center" },
  fileSymbol: { width: 88, height: 88, borderRadius: radius.lg, backgroundColor: "#202630", alignItems: "center", justifyContent: "center", marginBottom: space.xs },
  fileAction: { minHeight: 48, minWidth: 112, borderRadius: radius.md, backgroundColor: "#283442", alignItems: "center", justifyContent: "center", paddingHorizontal: space.md, marginTop: space.xs },
  footer: { paddingHorizontal: space.side, paddingTop: space.sm, paddingBottom: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#2D343E" },
  caption: { gap: space.xxs, alignItems: "center" },
  filename: { ...typography.bodyStrong, color: "#FFFFFF", textAlign: "center" },
  messageCaption: { ...typography.caption, color: "#E0E5EC", textAlign: "center", marginTop: space.xxs },
  navigation: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.xs, gap: space.xs },
  navButton: { minHeight: 48, minWidth: 48, borderRadius: radius.pill, backgroundColor: "#202630", alignItems: "center", justifyContent: "center", transform: [{ rotate: "180deg" }] },
  nextButton: { transform: [{ rotate: "0deg" }] },
  disabled: { opacity: 0.3 },
  shareError: { ...typography.caption, color: "#FFC2C8", padding: space.sm, textAlign: "center" },
});
