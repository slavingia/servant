import { useEffect, useRef, useState } from "react";
import { useEvent } from "expo";
import { randomUUID } from "expo-crypto";
import { File, Paths } from "expo-file-system";
import { useVideoPlayer, VideoView } from "expo-video";
import { ActivityIndicator, AppState, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { Attachment } from "../lib/server";
import { formatFileSize } from "../lib/media";
import { radius, space, typography } from "../lib/theme";
import { useMediaGallery } from "./MediaGalleryContext";

// Decorative: hidden from screen readers. On the web only aria-hidden reaches the
// DOM (the native-only props become invalid attributes there).
const hiddenIcon = Platform.OS === "web" ? { "aria-hidden": true } as const : { accessible: false, accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" } as const;

function PlayMark({ size = 24 }: { size?: number }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" {...hiddenIcon}><Path d="M7 3.8a1 1 0 0 1 1.5-.86l13 8.2a1 1 0 0 1 0 1.72l-13 8.2A1 1 0 0 1 7 20.2Z" fill="#FFFFFF" /></Svg>;
}

/** Full clips are fetched only after a tap, never for every timeline preview. The
 * tap plays the clip right here in the message, with the player's own full screen button. */
export function VideoPreview({ file, tiled = false }: { file: Attachment; tiled?: boolean }) {
  const [inline, setInline] = useState(false);
  const [aspect, setAspect] = useState(16 / 9);
  if (inline) return <View style={[styles.preview, tiled ? styles.tile : [styles.single, { aspectRatio: aspect }]]}>
    <InlineVideo file={file} onSize={size => { if (!tiled) setAspect(Math.min(2.2, Math.max(0.75, size))); }} />
  </View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Play video ${file.name}`} accessibilityHint="Plays here in the conversation" onPress={() => setInline(true)}
    style={({ pressed }) => [styles.preview, tiled ? styles.tile : styles.single, pressed && styles.pressed]}>
    <View style={styles.videoLabel}><Text style={styles.videoLabelText}>Video</Text></View>
    <View style={styles.playCircle}><PlayMark size={28} /></View>
    <View style={styles.previewCopy}><Text numberOfLines={1} style={styles.previewName}>{file.name}</Text><Text style={styles.previewMeta}>{formatFileSize(file.size)}</Text></View>
  </Pressable>;
}

/** This local picker URI needs no download and never starts playing. */
export function DraftVideoPreview({ uri, name }: { uri: string; name: string }) {
  const player = useVideoPlayer(uri, instance => {
    instance.muted = true;
    instance.staysActiveInBackground = false;
    instance.allowsExternalPlayback = false;
  });
  return <View pointerEvents="none" style={styles.draft} accessibilityLabel={`Selected video ${name}`}>
    <VideoView player={player} nativeControls={false} allowsVideoFrameAnalysis={false} contentFit="cover" surfaceType="textureView" fullscreenOptions={{ enable: false }} allowsPictureInPicture={false} playsInline style={styles.video} />
    <View style={styles.draftPlay}><PlayMark size={17} /></View>
  </View>;
}

type LocalSource = { uri: string; dispose: () => void };

function temporaryVideo(data: string, mime: string): LocalSource {
  if (Platform.OS === "web") {
    const bytes = new Uint8Array(data.length * 3 / 4 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0));
    // Decode in bounded chunks instead of retaining a second full binary string.
    let offset = 0;
    for (let start = 0; start < data.length; start += 131072) {
      const part = atob(data.slice(start, start + 131072));
      for (let index = 0; index < part.length; index++) bytes[offset++] = part.charCodeAt(index);
    }
    const uri = URL.createObjectURL(new Blob([bytes], { type: mime }));
    return { uri, dispose: () => URL.revokeObjectURL(uri) };
  }
  const extension = mime === "video/webm" ? "webm" : mime === "video/quicktime" ? "mov" : "mp4";
  const file = new File(Paths.cache, `servant-video-${randomUUID()}.${extension}`);
  const dispose = () => { try { if (file.exists) file.delete(); } catch { /* The OS may already have cleared its cache. */ } };
  try { file.writeSync(data, { encoding: "base64" }); }
  catch (error) { dispose(); throw error; }
  return { uri: file.uri, dispose };
}

/** Downloads one clip into a private file/Blob that lives as long as the caller. */
function useLocalVideo(file: Attachment) {
  const gallery = useMediaGallery()!;
  const { id, name, mime, size } = file;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; uri?: string; error?: string } | null>(null);
  const key = `${id}:${attempt}`;
  const current = result?.key === key ? result : null;
  const { load, invalidate } = gallery;
  useEffect(() => {
    let active = true;
    let source: LocalSource | undefined;
    void load({ id, name, mime, size }).then(data => {
      if (!active) return;
      source = temporaryVideo(data, mime);
      // The player owns a private file/Blob now; do not retain its base64 too.
      invalidate(id);
      setResult({ key, uri: source.uri });
    }).catch(() => {
      if (active) setResult({ key, error: "Couldn't load this video." });
    });
    return () => { active = false; invalidate(id); source?.dispose(); };
  }, [id, name, mime, size, key, load, invalidate]);
  return { uri: current?.uri, error: current?.error, retry: () => setAttempt(value => value + 1) };
}

/** Only the current gallery page mounts this component and owns its private file. */
export function GalleryVideo({ file, autoPlay = false, paused = false }: { file: Attachment; autoPlay?: boolean; paused?: boolean }) {
  const { uri, error, retry } = useLocalVideo(file);
  if (error) return <VideoError text={error} onRetry={retry} />;
  return uri ? <Playback key={uri} uri={uri} name={file.name} autoPlay={autoPlay} paused={paused} onRetry={retry} />
    : <VideoLoading />;
}

function InlineVideo({ file, onSize }: { file: Attachment; onSize: (aspect: number) => void }) {
  const { uri, error, retry } = useLocalVideo(file);
  if (error) return <VideoError text={error} onRetry={retry} compact />;
  return uri ? <Playback key={uri} uri={uri} name={file.name} autoPlay paused={false} onRetry={retry} onSize={onSize} compact />
    : <VideoLoading compact />;
}

function VideoLoading({ compact = false }: { compact?: boolean }) {
  return <View style={styles.center}><ActivityIndicator accessibilityLabel="Loading video" color="#FFFFFF" size={compact ? "small" : "large"} />{compact ? null : <Text style={styles.note}>Loading video…</Text>}</View>;
}

// One clip plays at a time across the timeline.
let playingInline: { pause: () => void } | null = null;

function Playback({ uri, name, autoPlay, paused, onRetry, onSize, compact = false }: { uri: string; name: string; autoPlay: boolean; paused: boolean; onRetry: () => void; onSize?: (aspect: number) => void; compact?: boolean }) {
  const player = useVideoPlayer(uri, instance => {
    instance.staysActiveInBackground = false;
    instance.allowsExternalPlayback = false;
    instance.showNowPlayingNotification = false;
    instance.loop = false;
  });
  const { status } = useEvent(player, "statusChange", { status: player.status });
  const started = useRef(false);
  const sizeRef = useRef(onSize);
  useEffect(() => { sizeRef.current = onSize; }, [onSize]);
  useEffect(() => {
    const loaded = player.addListener("sourceLoad", ({ availableVideoTracks }) => {
      const { width = 0, height = 0 } = availableVideoTracks[0]?.size ?? {};
      if (width > 0 && height > 0) sizeRef.current?.(width / height);
    });
    const playing = player.addListener("playingChange", ({ isPlaying }) => {
      if (!isPlaying) return;
      if (playingInline && playingInline !== player) playingInline.pause();
      playingInline = player;
    });
    return () => { loaded.remove(); playing.remove(); if (playingInline === player) playingInline = null; };
  }, [player]);
  useEffect(() => {
    if (paused) player.pause();
    else if (autoPlay && !started.current && AppState.currentState === "active") {
      started.current = true;
      player.play();
    }
  }, [autoPlay, paused, player]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => { if (state !== "active") player.pause(); });
    const hidden = () => { if (document.hidden) player.pause(); };
    if (Platform.OS === "web") document.addEventListener("visibilitychange", hidden);
    return () => {
      subscription.remove();
      if (Platform.OS === "web") document.removeEventListener("visibilitychange", hidden);
      player.pause();
    };
  }, [player]);
  if (status === "error") return <VideoError text={compact ? "This video couldn't play here." : "This video couldn't play on your device. You can still save or share the original."} onRetry={onRetry} compact={compact} />;
  return <View style={[styles.player, compact && styles.inlinePlayer]}>
    <VideoView player={player} accessibilityLabel={`Video player for ${name}`} nativeControls contentFit="contain" surfaceType="textureView" fullscreenOptions={{ enable: compact }} allowsPictureInPicture={false} startsPictureInPictureAutomatically={false} playsInline style={styles.video} />
    {status === "loading" ? <View pointerEvents="none" style={styles.loading}><ActivityIndicator color="#FFFFFF" size="large" /></View> : null}
  </View>;
}

function VideoError({ text, onRetry, compact = false }: { text: string; onRetry: () => void; compact?: boolean }) {
  return <View style={styles.center}>{compact ? null : <Text style={styles.errorTitle}>Video unavailable</Text>}<Text style={styles.note}>{text}</Text><Pressable accessibilityRole="button" onPress={onRetry} style={styles.retry}><Text style={styles.retryText}>Retry video</Text></Pressable></View>;
}

const styles = StyleSheet.create({
  single: { width: "100%", maxWidth: 480, aspectRatio: 16 / 9 },
  tile: { width: "48%", flexGrow: 1, flexBasis: "48%", maxWidth: "50%", aspectRatio: 1 },
  preview: { backgroundColor: "#17354F", borderWidth: StyleSheet.hairlineWidth, borderColor: "#34536C", borderRadius: radius.lg, overflow: "hidden", alignItems: "center", justifyContent: "center", minHeight: 130 },
  pressed: { opacity: 0.8 },
  videoLabel: { position: "absolute", top: space.sm, left: space.sm, borderRadius: radius.sm, paddingHorizontal: space.xs, paddingVertical: 3, backgroundColor: "#FFFFFF1F" },
  videoLabelText: { ...typography.meta, fontWeight: "700", color: "#E4EDF5" },
  playCircle: { width: 58, height: 58, borderRadius: radius.pill, backgroundColor: "#FFFFFF22", borderWidth: 1, borderColor: "#FFFFFF44", alignItems: "center", justifyContent: "center", marginBottom: space.lg, paddingRight: 3 },
  previewCopy: { position: "absolute", left: space.sm, right: space.sm, bottom: space.sm, gap: 2 },
  previewName: { ...typography.captionStrong, color: "#FFFFFF" },
  previewMeta: { ...typography.meta, color: "#CAD9E6" },
  draft: { width: "100%", height: "100%", backgroundColor: "#17354F" },
  draftPlay: { position: "absolute", right: 5, bottom: 5, width: 28, height: 28, borderRadius: radius.pill, backgroundColor: "#0009", alignItems: "center", justifyContent: "center", paddingRight: 2 },
  player: { flex: 1, backgroundColor: "#101318" },
  inlinePlayer: { alignSelf: "stretch", width: "100%" },
  // Web's <video> keeps its intrinsic size under inset:0, so it needs an explicit 100%.
  video: { position: "absolute", top: 0, left: 0, width: "100%", height: "100%" },
  loading: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.lg, gap: space.sm },
  note: { ...typography.caption, color: "#BAC3CF", textAlign: "center" },
  errorTitle: { ...typography.heading, color: "#FFFFFF", textAlign: "center" },
  retry: { minHeight: 48, minWidth: 112, borderRadius: radius.md, backgroundColor: "#283442", alignItems: "center", justifyContent: "center", paddingHorizontal: space.md, marginTop: space.xs },
  retryText: { ...typography.captionStrong, color: "#FFFFFF" },
});
