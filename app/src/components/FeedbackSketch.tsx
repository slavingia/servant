import { useState, type ComponentRef, useRef } from "react";
import { ActivityIndicator, Image, KeyboardAvoidingView, Modal, PanResponder, Platform, Pressable, StatusBar, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from "react-native";
import Svg, { Path } from "react-native-svg";
import { captureRef } from "react-native-view-shot";
import Constants from "expo-constants";
import { nativeBuildVersion } from "expo-application";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSession } from "../lib/session";
import { api } from "../lib/server";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { pathFor, strokeWidthFor, toFraction, type Point } from "../lib/sketch-geometry";

export type Shot = { uri: string; width: number; height: number; screen: string; via: string };

const INK = "#E5173F";

// The screenshot taken the moment feedback starts, shown back to you to circle
// what's wrong. Sends the marked-up image straight to the agent.
//
// Marks are kept as fractions of the picture, not pixels. The picture changes size while you work (the
// keyboard opens for the note and the area shrinks), and fractions keep every mark on the same part of the screen.
const DEFAULT_NOTE = "Fix";
export function FeedbackSketch({ shot, onClose }: { shot: Shot | null; onClose: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { account } = useSession();
  const [paths, setPaths] = useState<Point[][]>([]);
  const [live, setLive] = useState<Point[]>([]);
  const [text, setText] = useState(DEFAULT_NOTE);
  // How big the picture is drawn right now: state to redraw the marks, and a plain object the touch handlers
  // (created once) can read.
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [measure] = useState({ width: 0, height: 0 });
  const onCanvasLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width === size.width && height === size.height) return;
    Object.assign(measure, { width, height });
    setSize({ width, height });
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canvas = useRef<ComponentRef<typeof View>>(null);
  const [stroke] = useState<{ points: Point[] }>({ points: [] });
  const requestId = useRef("");

  const [pan] = useState(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      const { locationX: x, locationY: y } = e.nativeEvent;
      stroke.points = [toFraction(x, y, measure.width, measure.height)];
      setLive(stroke.points);
    },
    onPanResponderMove: (e) => {
      const { locationX: x, locationY: y } = e.nativeEvent;
      stroke.points = [...stroke.points, toFraction(x, y, measure.width, measure.height)];
      setLive(stroke.points);
    },
    onPanResponderRelease: () => {
      const done = stroke.points;
      stroke.points = [];
      setLive([]);
      if (done.length) setPaths((p) => [...p, done]);
    },
  }));

  if (!shot) return null;
  const close = () => { setPaths([]); setLive([]); setText(DEFAULT_NOTE); setError(""); onClose(); };
  // The note is required. It starts as "Fix"; clearing it leaves nothing to send.
  const note = text.trim();
  const send = async () => {
    if (busy || !account || !note) return;
    setBusy(true); setError("");
    try {
      const data = await captureRef(canvas, { format: "jpg", quality: 0.8, result: "base64" });
      await api.sendFeedback(account, {
        text: note,
        requestId: (requestId.current ||= `${Date.now()}-${Math.random().toString(36).slice(2)}`),
        context: { screen: shot.screen, platform: Platform.OS, version: Constants.expoConfig?.version || "", build: nativeBuildVersion || "development", via: shot.via },
        attachments: [{ name: "screenshot.jpg", data }],
      });
      requestId.current = "";
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send. Please try again.");
    } finally { setBusy(false); }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={close} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={[styles.root, { paddingTop: Math.max(insets.top, space.md), paddingBottom: Math.max(insets.bottom, space.md) }]} testID="feedback-sketch">
        <StatusBar barStyle="light-content" />
        <View style={styles.bar}>
          <Pressable accessibilityRole="button" onPress={close} hitSlop={12} disabled={busy}><Text style={styles.barText}>Cancel</Text></Pressable>
          <Text accessibilityRole="header" style={styles.barTitle}>Draw on what's wrong</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Undo last mark" onPress={() => setPaths((p) => p.slice(0, -1))} hitSlop={12} disabled={!paths.length || busy}>
            <Text style={[styles.barText, !paths.length && { opacity: 0.35 }]}>Undo</Text>
          </Pressable>
        </View>
        <View style={styles.stage}>
          <View ref={canvas} collapsable={false} onLayout={onCanvasLayout} style={[styles.canvas, { aspectRatio: shot.width / shot.height }]}>
            <Image source={{ uri: shot.uri }} style={StyleSheet.absoluteFill} resizeMode="stretch" />
            <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
              {[...paths, live].filter(points => points.length).map((points, i) => (
                <Path key={i} d={pathFor(points, size.width, size.height)} stroke={INK} strokeWidth={strokeWidthFor(size.width)} strokeLinecap="round" strokeLinejoin="round" fill="none" />
              ))}
            </Svg>
          </View>
          <View style={[styles.canvas, styles.touch, { aspectRatio: shot.width / shot.height }]} {...pan.panHandlers} accessibilityLabel="Drawing area" />
        </View>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <View style={styles.footer}>
          <TextInput
            accessibilityLabel="What's wrong (required)"
            accessibilityState={{ disabled: busy }}
            aria-required
            placeholder="What's wrong?"
            placeholderTextColor={colors.muted}
            value={text}
            onChangeText={setText}
            editable={!busy}
            maxLength={4000}
            style={styles.input}
            returnKeyType="done"
          />
          <Pressable accessibilityRole="button" accessibilityLabel="Send to agent" accessibilityState={{ disabled: busy || !note }} onPress={send} disabled={busy || !note} style={({ pressed }) => [styles.send, !note && { opacity: 0.4 }, pressed && { opacity: 0.8 }]}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.sendText}>Send</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000", paddingHorizontal: space.md, gap: space.sm },
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 },
  barText: { ...typography.bodyStrong, color: "#fff" },
  barTitle: { ...typography.bodyStrong, color: "#fff" },
  stage: { flex: 1, alignItems: "center", justifyContent: "center" },
  canvas: { height: "100%", maxWidth: "100%", borderRadius: radius.md, overflow: "hidden", backgroundColor: "#111" },
  touch: { position: "absolute", backgroundColor: "transparent" },
  footer: { flexDirection: "row", gap: space.sm, alignItems: "center" },
  input: { flex: 1, minHeight: 48, borderRadius: radius.lg, paddingHorizontal: space.md, backgroundColor: "#1c1c1e", color: "#fff", ...typography.body },
  send: { minHeight: 48, minWidth: 80, borderRadius: radius.lg, alignItems: "center", justifyContent: "center", backgroundColor: "#0071BC", paddingHorizontal: space.md },
  sendText: { ...typography.bodyStrong, color: "#fff" },
  error: { ...typography.caption, color: "#ff6b81" },
}));
