import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, PanResponder, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { api, ServerError, type Account, type Conversation } from "../lib/server";
import { space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { ConversationRow } from "./Messaging";
import { AppIcon } from "./AppIcon";
import { ConfirmDialog } from "./ConfirmDialog";

const rowName = (c: Conversation) => c.kind === "channel" ? `#${c.title}` : c.title;
const kindName = (c: Conversation) => c.kind === "channel" ? "channel" : "conversation";

// Who may delete a row: channel creators and the owner (never #general);
// anyone in a direct conversation.
export function canDeleteConversation(c: Conversation, account: Account) {
  if (c.kind === "dm") return true;
  return c.name !== "general" && (account.user.role === "owner" || c.createdBy === account.user.id);
}

// Swipe state, archive/restore/delete calls and the delete confirmation,
// shared by every list that shows swipeable conversations.
export function useConversationActions(account: Account | null, refresh: () => unknown) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const busy = useRef(false);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const closeRow = useCallback(() => setOpenId(null), []);
  const act = async (c: Conversation, remove = false) => {
    if (!account || busy.current) return;
    busy.current = true;
    setBusyId(c.id);
    setActionError(null);
    try {
      if (remove) await api.deleteChannel(account, c.id);
      else if (c.archived) await api.restoreChannel(account, c.id);
      else await api.archiveChannel(account, c.id);
      setDeleting(null);
      closeRow();
      await refresh();
    } catch (e) {
      setActionError(e instanceof ServerError ? e.message : `Couldn't update the ${kindName(c)}. Try again.`);
    } finally {
      busy.current = false;
      setBusyId(null);
    }
  };
  const rowProps = (c: Conversation) => ({
    c, open: openId === c.id, busy: busyId !== null,
    canDelete: !!account && canDeleteConversation(c, account),
    onOpen: () => setOpenId(c.id), onClose: closeRow,
    onArchive: () => { void act(c); },
    onDelete: () => { setActionError(null); setDeleting(c); },
  });
  const dialog = <ConfirmDialog visible={!!deleting}
    title={deleting?.kind === "dm" ? `Delete your conversation with ${deleting.title}?` : `Delete #${deleting?.title ?? "channel"}?`}
    description={deleting?.kind === "dm"
      ? "This permanently deletes the conversation and all its messages for everyone in it. This can't be undone."
      : "This permanently deletes the channel and all its messages for everyone. This can't be undone."}
    confirmLabel={deleting?.kind === "dm" ? "Delete conversation" : "Delete channel"} busy={busyId !== null} error={actionError}
    onCancel={() => { setDeleting(null); setActionError(null); }} onConfirm={() => { if (deleting) void act(deleting, true); }} />;
  return { openId, busyId, closeRow, rowProps, dialog, actionError: deleting ? null : actionError };
}

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
  const styles = useStyles();
  const { colors } = useTheme();
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
      <Animated.View {...pan.panHandlers} style={{ zIndex: 1, backgroundColor: colors.background, transform: [{ translateX: x }], opacity: busy ? 0.5 : 1 }}>
        <ConversationRow c={c} compact={compact} onPress={() => { if (!busy) { if (open) onClose(); else onPress(); } }}
          onLongPress={() => { if (!busy) onOpen(); }}
          accessibilityActions={[{ name: "archive", label: archiveLabel }, ...(canDelete ? [{ name: "delete", label: `Delete ${kindName(c)}` }] : [])]}
          onAccessibilityAction={(e) => { if (!busy) { if (e.nativeEvent.actionName === "archive") onArchive(); if (e.nativeEvent.actionName === "delete" && canDelete) onDelete(); } }}
          trailing={Platform.OS === "web" ? <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel={`Actions for ${rowName(c)}`} accessibilityState={{ expanded: open, disabled: busy }} onPress={open ? onClose : onOpen} style={styles.more}><AppIcon name="more" size={18} color={colors.muted} /></Pressable> : undefined} />
      </Animated.View>
      <View style={[styles.actions, { width }]} {...(Platform.OS === "web" ? { "aria-hidden": !open } : { accessibilityElementsHidden: !open, importantForAccessibility: open ? "auto" as const : "no-hide-descendants" as const })} pointerEvents={open && !busy ? "auto" : "none"}>
        <Pressable disabled={!open || busy} accessibilityRole="button" accessibilityLabel={`${archiveLabel} ${rowName(c)}`} onPress={onArchive} style={[styles.action, styles.archive]}>
          <Text style={styles.label}>{archiveLabel}</Text>
        </Pressable>
        {canDelete ? <Pressable disabled={!open || busy} accessibilityRole="button" accessibilityLabel={`Delete ${rowName(c)}`} onPress={onDelete} style={[styles.action, styles.delete]}>
          <Text style={styles.label}>Delete</Text>
        </Pressable> : null}
      </View>
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { overflow: "hidden" },
  actions: { zIndex: 0, position: "absolute", right: 0, top: 0, bottom: 0, flexDirection: "row" },
  action: { flex: 1, minHeight: 44, paddingHorizontal: space.xs, alignItems: "center", justifyContent: "center" },
  archive: { backgroundColor: colors.primary },
  delete: { backgroundColor: colors.danger },
  label: { ...typography.label, color: colors.onPrimary },
  more: { minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "center", marginRight: space.xs },
}));
