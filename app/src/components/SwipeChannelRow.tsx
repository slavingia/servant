import { useEffect, useMemo, useState } from "react";
import { Animated, PanResponder, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { Conversation } from "../lib/server";
import { colors, space, typography } from "../lib/theme";
import { ConversationRow } from "./Messaging";
import { AppIcon } from "./AppIcon";

export function SwipeChannelRow({ c, compact = false, open, busy, canDelete, onOpen, onClose, onPress, onArchive, onDelete }: {
  c: Conversation;
  compact?: boolean;
  open: boolean;
  busy: boolean;
  canDelete: boolean;
  onOpen: () => void;
  onClose: () => void;
  onPress: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [x] = useState(() => new Animated.Value(0));
  const width = canDelete ? 184 : 96;
  const archiveLabel = c.archived ? "Restore" : "Archive";
  useEffect(() => {
    const animation = Animated.timing(x, { toValue: open ? -width : 0, duration: 180, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [open, width, x]);
  const pan = useMemo(() => {
    const origin = open ? -width : 0;
    return PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => !busy && Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderGrant: () => { x.stopAnimation(); },
    onPanResponderMove: (_, g) => x.setValue(Math.max(-width, Math.min(0, origin + g.dx))),
    onPanResponderRelease: (_, g) => {
      const reveal = g.vx < -0.4 || (g.vx <= 0.4 && origin + g.dx < -width / 3);
      if (reveal) onOpen(); else onClose();
      // Also settle when the requested open state hasn't changed.
      Animated.timing(x, { toValue: reveal ? -width : 0, duration: 180, useNativeDriver: true }).start();
    },
    onPanResponderTerminate: () => {
      onClose();
      Animated.timing(x, { toValue: 0, duration: 180, useNativeDriver: true }).start();
    },
  });
  }, [busy, onClose, onOpen, open, width, x]);
  return (
    <View style={styles.root}>
      <Animated.View {...pan.panHandlers} style={{ zIndex: 1, backgroundColor: colors.white, transform: [{ translateX: x }], opacity: busy ? 0.5 : 1 }}>
        <ConversationRow c={c} compact={compact} onPress={() => { if (!busy) { if (open) onClose(); else onPress(); } }}
          onLongPress={() => { if (!busy) onOpen(); }}
          accessibilityActions={[{ name: "archive", label: archiveLabel }, ...(canDelete ? [{ name: "delete", label: "Delete channel" }] : [])]}
          onAccessibilityAction={(e) => { if (!busy) { if (e.nativeEvent.actionName === "archive") onArchive(); if (e.nativeEvent.actionName === "delete" && canDelete) onDelete(); } }}
          trailing={Platform.OS === "web" ? <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel={`Actions for #${c.title}`} accessibilityState={{ expanded: open, disabled: busy }} onPress={open ? onClose : onOpen} style={styles.more}><AppIcon name="more" size={18} color={colors.muted} /></Pressable> : undefined} />
      </Animated.View>
      <View style={[styles.actions, { width }]} accessibilityElementsHidden={!open} importantForAccessibility={open ? "auto" : "no-hide-descendants"} pointerEvents={open && !busy ? "auto" : "none"}>
        <Pressable disabled={!open || busy} accessibilityRole="button" accessibilityLabel={`${archiveLabel} #${c.title}`} onPress={onArchive} style={[styles.action, styles.archive]}>
          <Text style={styles.label}>{archiveLabel}</Text>
        </Pressable>
        {canDelete ? <Pressable disabled={!open || busy} accessibilityRole="button" accessibilityLabel={`Delete #${c.title}`} onPress={onDelete} style={[styles.action, styles.delete]}>
          <Text style={styles.label}>Delete</Text>
        </Pressable> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { overflow: "hidden" },
  actions: { zIndex: 0, position: "absolute", right: 0, top: 0, bottom: 0, flexDirection: "row" },
  action: { flex: 1, minHeight: 44, paddingHorizontal: space.xs, alignItems: "center", justifyContent: "center" },
  archive: { backgroundColor: colors.blue },
  delete: { backgroundColor: colors.red },
  label: { ...typography.label, color: colors.white },
  more: { minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "center", marginRight: space.xs },
});
