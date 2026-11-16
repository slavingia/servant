import React, { useCallback, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SwipeSurface } from "./SwipeSurface";
import { api, ServerError, type Account, type Conversation } from "../lib/server";
import { useLiveActions } from "../lib/live";
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
  const { change } = useLiveActions();
  const act = async (c: Conversation, remove = false) => {
    if (!account || busy.current) return;
    busy.current = true;
    setBusyId(c.id);
    setActionError(null);
    // The row moves at once (lib/row-changes.ts). The server does the work as it always has: where records are
    // kept, a delete saves its copy first. If the server refuses, the row is back where it was and the error says why.
    change(c.id, remove ? { deleted: true } : { archived: !c.archived });
    setDeleting(null);
    closeRow();
    try {
      if (remove) await api.deleteChannel(account, c.id);
      else if (c.archived) await api.restoreChannel(account, c.id);
      else await api.archiveChannel(account, c.id);
      await refresh();
    } catch (e) {
      setActionError(e instanceof ServerError ? e.message : `Couldn't update the ${kindName(c)}. Try again.`);
      // A delete that was refused asks again, with the reason, wherever the list is scrolled to.
      if (remove) setDeleting(c);
    } finally {
      // The refreshed list has the change now, or it was refused: either way it no longer waits.
      change(c.id, null);
      busy.current = false;
      setBusyId(null);
    }
  };
  // Mute is yours alone and changes nothing for anyone else, so it just flips and the list refreshes.
  const mute = async (c: Conversation) => {
    if (!account || busy.current) return;
    busy.current = true;
    setBusyId(c.id);
    setActionError(null);
    closeRow();
    try {
      await api.muteConversation(account, c.id, !c.muted);
      await refresh();
    } catch (e) {
      setActionError(e instanceof ServerError ? e.message : `Couldn't ${c.muted ? "unmute" : "mute"} the ${kindName(c)}. Try again.`);
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
    onMute: c.archived ? undefined : () => { void mute(c); },
    onDelete: () => { setActionError(null); setDeleting(c); },
  });
  const dialog = <ConfirmDialog visible={!!deleting}
    title={deleting?.kind === "dm" ? `Delete your conversation with ${deleting.title}?` : `Delete #${deleting?.title ?? "channel"}?`}
    description={deleteDescription(deleting?.kind === "dm" ? "dm" : "channel", account?.recordsKept === true)}
    confirmLabel={deleting?.kind === "dm" ? "Delete conversation" : "Delete channel"} busy={busyId !== null} error={actionError}
    onCancel={() => { setDeleting(null); setActionError(null); }} onConfirm={() => { if (deleting) void act(deleting, true); }} />;
  return { openId, busyId, closeRow, rowProps, dialog, actionError: deleting ? null : actionError };
}

export function SwipeChannelRow({ c, compact = false, open, busy, canDelete, onOpen, onClose, onPress, onArchive, onDelete, onMute, drag, reordering = false }: {
  c: Conversation;
  onMute?: () => void;
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
  return <SwipeRow name={rowName(c)} kind={kindName(c)} archived={!!c.archived} muted={!!c.muted} onMute={onMute} open={open} busy={busy} canDelete={canDelete} locked={reordering}
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
export function SwipeRow({ name, kind, archived, muted, open, busy, canDelete, locked = false, onOpen, onClose, onArchive, onDelete, onMute, children }: {
  name: string;
  /** With onMute: a Mute (or Unmute) action first, like Slack's. */
  muted?: boolean;
  onMute?: () => void;
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
  const width = (canDelete ? 184 : 96) + (onMute ? 88 : 0);
  const muteLabel = muted ? "Unmute" : "Mute";
  const archiveLabel = archived ? "Restore" : "Archive";
  const settled = useCallback((reveal: boolean) => { if (reveal) onOpen(); else onClose(); }, [onClose, onOpen]);
  const bind: RowBindings = {
    onPress: (go) => { if (!busy) { if (open) onClose(); else go(); } },
    onLongPress: () => { if (!busy) onOpen(); },
    accessibilityActions: [...(onMute ? [{ name: "mute", label: muteLabel }] : []), { name: "archive", label: archiveLabel }, ...(canDelete ? [{ name: "delete", label: `Delete ${kind}` }] : [])],
    onAccessibilityAction: (e) => { if (!busy) { if (e.nativeEvent.actionName === "mute") onMute?.(); if (e.nativeEvent.actionName === "archive") onArchive(); if (e.nativeEvent.actionName === "delete" && canDelete) onDelete(); } },
    trailing: Platform.OS === "web" && !locked ? <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel={`Actions for ${name}`} accessibilityState={{ expanded: open, disabled: busy }} aria-expanded={open} onPress={open ? onClose : onOpen} style={styles.more}><AppIcon name="more" size={18} color={colors.muted} /></Pressable> : undefined,
  };
  return (
    <View style={styles.root}>
      {/* Only the row being acted on dims. Dimming every row let the action
          buttons behind each one show through the whole list. */}
      <SwipeSurface open={open} width={width} enabled={!busy && !locked} onSettle={settled}
        rowStyle={{ zIndex: 1, backgroundColor: colors.background, opacity: busy && open ? 0.5 : 1 }}
        behindStyle={styles.actions}
        behindProps={{ ...(Platform.OS === "web" ? { "aria-hidden": !open } : { accessibilityElementsHidden: !open, importantForAccessibility: open ? "auto" as const : "no-hide-descendants" as const }), pointerEvents: open && !busy ? "auto" : "none" }}
        behind={<>
          {onMute ? <Pressable disabled={!open || busy} accessibilityRole="button" accessibilityLabel={`${muteLabel} ${name}`} onPress={onMute} style={[styles.action, styles.mute]}>
            <Text style={styles.label}>{muteLabel}</Text>
          </Pressable> : null}
          <Pressable disabled={!open || busy} accessibilityRole="button" accessibilityLabel={`${archiveLabel} ${name}`} onPress={onArchive} style={[styles.action, styles.archive]}>
            <Text style={styles.label}>{archiveLabel}</Text>
          </Pressable>
          {canDelete ? <Pressable disabled={!open || busy} accessibilityRole="button" accessibilityLabel={`Delete ${name}`} onPress={onDelete} style={[styles.action, styles.delete]}>
            <Text style={styles.label}>Delete</Text>
          </Pressable> : null}
        </>}>
        {children(bind)}
      </SwipeSurface>
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { overflow: "hidden" },
  actions: { zIndex: 0, position: "absolute", right: 0, top: 0, bottom: 0, flexDirection: "row" },
  action: { flex: 1, minHeight: 44, paddingHorizontal: space.xs, alignItems: "center", justifyContent: "center" },
  archive: { backgroundColor: colors.primary },
  mute: { backgroundColor: colors.muted },
  delete: { backgroundColor: colors.danger },
  label: { ...typography.label, color: colors.onPrimary },
  more: { minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "center", marginRight: space.xs },
}));
