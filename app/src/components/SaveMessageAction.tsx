import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { api, ServerError, type Account, type SavedMessage } from "../lib/server";
import { createThemedStyles, space, typography, useTheme } from "../lib/theme";
import { AppIcon } from "./AppIcon";

/** Mounted only while a message menu is open, so saved state is fresh across devices. */
export function SaveMessageAction({ account, messageId, onOpenSaved }: {
  account: Account; messageId: string; onOpenSaved: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [item, setItem] = useState<SavedMessage | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const pending = useRef(false);
  const requestVersion = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (pending.current) return;
    let live = true;
    const version = ++requestVersion.current;
    api.savedMessage(account, messageId).then(
      result => { if (live && version === requestVersion.current) setItem(result.item); },
      e => { if (live && version === requestVersion.current) setError(e instanceof ServerError ? e.message : "Couldn't check whether this message is saved. Try again."); },
    );
    return () => { live = false; };
  }, [account, messageId, attempt]);

  const toggle = async () => {
    if (item === undefined || pending.current) return;
    pending.current = true;
    requestVersion.current++;
    setBusy(true); setError(null); setNotice(null);
    try {
      if (item) {
        await api.removeSavedMessage(account, messageId);
        if (mounted.current) { setItem(null); setNotice("Removed from Saved"); }
      } else {
        const result = await api.saveMessage(account, messageId);
        if (mounted.current) { setItem(result.item); setNotice("Saved for later. Only you can see your list."); }
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof ServerError ? e.message : "Couldn't update your saved messages. Try again.");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const label = busy ? "Saving…" : item === undefined ? "Checking saved messages…" : item ? "Remove from saved" : "Save for later";
  return <View>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || item === undefined, busy }}
      disabled={busy || item === undefined} onPress={() => void toggle()} style={styles.action}>
      <AppIcon name="bookmark" size={18} color={item ? colors.red : colors.blueDark} />
      <Text style={[styles.actionText, item && styles.removeText]}>{label}</Text>
    </Pressable>
    {notice ? <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {error && item === undefined ? <Pressable accessibilityRole="button" onPress={() => { setError(null); setAttempt(v => v + 1); }} style={styles.action}>
      <Text style={styles.actionText}>Try again</Text>
    </Pressable> : null}
    {item ? <Pressable accessibilityRole="button" onPress={onOpenSaved} style={styles.action}>
      <Text style={styles.actionText}>View saved messages{item.completedAt !== null ? " · Completed" : ""}</Text>
    </Pressable> : null}
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  action: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.sm },
  actionText: { ...typography.bodyStrong, color: colors.blueDark },
  removeText: { color: colors.red },
  notice: { ...typography.caption, color: colors.muted, paddingBottom: space.xs },
  error: { ...typography.caption, color: colors.red, paddingBottom: space.xs },
}));
