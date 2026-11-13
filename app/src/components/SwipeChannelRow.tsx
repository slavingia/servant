import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, PanResponder, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { api, ServerError, type Account, type Conversation } from "../lib/server";
import { space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { ConversationRow } from "./Messaging";
import { AppIcon } from "./AppIcon";
import { ConfirmDialog } from "./ConfirmDialog";
import { deleteDescription } from "../lib/records-notice";
import type { DragBindings } from "./ReorderableList";

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
    description={deleteDescription(deleting?.kind === "dm" ? "dm" : "channel", account?.recordsKept === true)}
    confirmLabel={deleting?.kind === "dm" ? "Delete conversation" : "Delete channel"} busy={busyId !== null} error={actionError}
    onCancel={() => { setDeleting(null); setActionError(null); }} onConfirm={() => { if (deleting) void act(deleting, true); }} />;
  return { openId, busyId, closeRow, rowProps, dialog, actionError: deleting ? null : actionError };
}

export function SwipeChannelRow({ c, compact = false, open, busy, canDelete, onOpen, onClose, onPress, onArchive, onDelete, drag, reordering = false }: {
  c: Conversation;
  /** Channels on Home: long press lifts the row to drag it instead of opening actions. */
  drag?: DragBindings;
  /** Reorder mode: swiping and opening are off and each row shows a grip. */
  reordering?: boolean;
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
  return <SwipeRow name={rowName(c)} kind={kindName(c)} archived={!!c.archived} open={open} busy={busy} canDelete={canDelete} locked={reordering}
    onOpen={onOpen} onClose={onClose} onArchive={onArchive} onDelete={onDelete}>
    {({ onPress: press, onLongPress, accessibilityActions, onAccessibilityAction, trailing }) =>
      <ConversationRow c={c} compact={compact} lifted={drag?.lifted} onPress={() => { if (!reordering) press(onPress); }}
        onLongPress={drag && !open ? drag.onLongPress : onLongPress}
        longPressHint={drag ? "Long press, then drag to reorder" : undefined}
        accessibilityActions={drag ? [...accessibilityActions, ...drag.accessibilityActions] : accessibilityActions}
        onAccessibilityAction={e => { if (drag?.accessibilityActions.some(a => a.name === e.nativeEvent.actionName)) drag.onAccessibilityAction(e); else onAccessibilityAction(e); }}
        trailing={drag && reordering ? <DragGrip name={rowName(c)} {...drag.gripProps} /> : trailing} />}
  </SwipeRow>;
}

function DragGrip({ name, ...responder }: { name: string } & DragBindings["gripProps"]) {
  const styles = useStyles();
  const { colors } = useTheme();
  return <View {...responder} accessibilityLabel={`Drag to reorder ${name}`} style={styles.more}>
    <AppIcon name="grip" size={20} color={colors.muted} />
  </View>;
}

type RowBindings = {
  onPress: (go: () => void) => void;
  onLongPress: () => void;
  accessibilityActions: { name: string; label: string }[];
  onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => void;
  trailing: React.ReactNode;
};

// Swipe left to reveal Archive (or Restore) and Delete. Long press and the
// VoiceOver actions open the same choices; on web a "⋯" button does.
export function SwipeRow({ name, kind, archived, open, busy, canDelete, locked = false, onOpen, onClose, onArchive, onDelete, children }: {
  name: string;
  locked?: boolean;
  kind: string;
  archived: boolean;
  open: boolean;
  busy: boolean;
  canDelete: boolean;
  onOpen: () => void;
  onClose: () => void;
  onArchive: () => void;
  onDelete: () => void;
  children: (bind: RowBindings) => React.ReactNode;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [x] = useState(() => new Animated.Value(0));
  const width = canDelete ? 184 : 96;
  const archiveLabel = archived ? "Restore" : "Archive";
  useEffect(() => {
    const animation = Animated.timing(x, { toValue: open ? -width : 0, duration: 180, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [open, width, x]);
  const pan = useMemo(() => {
    const origin = open ? -width : 0;
    return PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => !busy && !locked && Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
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
  }, [busy, locked, onClose, onOpen, open, width, x]);
  const bind: RowBindings = {
    onPress: (go) => { if (!busy) { if (open) onClose(); else go(); } },
    onLongPress: () => { if (!busy) onOpen(); },
    accessibilityActions: [{ name: "archive", label: archiveLabel }, ...(canDelete ? [{ name: "delete", label: `Delete ${kind}` }] : [])],
    onAccessibilityAction: (e) => { if (!busy) { if (e.nativeEvent.actionName === "archive") onArchive(); if (e.nativeEvent.actionName === "delete" && canDelete) onDelete(); } },
    trailing: Platform.OS === "web" && !locked ? <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel={`Actions for ${name}`} accessibilityState={{ expanded: open, disabled: busy }} aria-expanded={open} onPress={open ? onClose : onOpen} style={styles.more}><AppIcon name="more" size={18} color={colors.muted} /></Pressable> : undefined,
  };
  return (
    <View style={styles.root}>
      <Animated.View {...pan.panHandlers} style={{ zIndex: 1, backgroundColor: colors.background, transform: [{ translateX: x }], opacity: busy ? 0.5 : 1 }}>
        {children(bind)}
      </Animated.View>
      <View style={[styles.actions, { width }]} {...(Platform.OS === "web" ? { "aria-hidden": !open } : { accessibilityElementsHidden: !open, importantForAccessibility: open ? "auto" as const : "no-hide-descendants" as const })} pointerEvents={open && !busy ? "auto" : "none"}>
        <Pressable disabled={!open || busy} accessibilityRole="button" accessibilityLabel={`${archiveLabel} ${name}`} onPress={onArchive} style={[styles.action, styles.archive]}>
          <Text style={styles.label}>{archiveLabel}</Text>
        </Pressable>
        {canDelete ? <Pressable disabled={!open || busy} accessibilityRole="button" accessibilityLabel={`Delete ${name}`} onPress={onDelete} style={[styles.action, styles.delete]}>
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
