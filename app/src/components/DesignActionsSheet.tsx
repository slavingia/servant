import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { AppIcon } from "./AppIcon";
import { Button } from "./Button";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

export type DesignAction = { id: string; label: string; hint?: string; icon: Parameters<typeof AppIcon>[0]["name"]; run: () => Promise<void> | void };

/**
 * More things to do with one design (rename, duplicate, versions, archive…).
 * Rename asks for the new name here. Errors stay in the sheet.
 */
export function DesignActionsSheet({ title, actions, onRename, onClose }: {
  title: string;
  actions: readonly DesignAction[];
  onRename?: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(title);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = () => { if (!busy) onClose(); };
  const run = async (id: string, work: () => Promise<void> | void) => {
    if (busy) return;
    setBusy(id);
    setError(null);
    try { await work(); }
    catch (e) { setError(e instanceof Error && e.message ? e.message : "That didn't work. Try again."); }
    finally { setBusy(null); }
  };
  return <Modal visible transparent animationType="fade" onRequestClose={close}>
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.fill}>
      <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={close}>
        <Pressable accessibilityViewIsModal style={styles.card} onPress={() => {}}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text accessibilityRole="header" numberOfLines={2} style={styles.title}>{title}</Text>
            {renaming ? <View style={styles.rename}>
              <Text style={styles.label}>Design name</Text>
              <TextInput accessibilityLabel="Design name" autoFocus value={name} onChangeText={setName} maxLength={80} returnKeyType="done"
                onSubmitEditing={() => onRename && name.trim() && void run("rename", () => onRename(name.trim()))}
                placeholderTextColor={colors.muted} style={styles.input} />
              <View style={styles.row}>
                <Button label="Cancel" kind="secondary" compact onPress={() => { setRenaming(false); setName(title); setError(null); }} disabled={!!busy} />
                <Button label="Save name" compact busy={busy === "rename"} disabled={!name.trim() || name.trim() === title} onPress={() => onRename && void run("rename", () => onRename(name.trim()))} />
              </View>
            </View> : <View accessibilityRole="menu" style={styles.actions}>
              {onRename ? <Item icon="compose" label="Rename" busy={busy === "rename"} disabled={!!busy} onPress={() => setRenaming(true)} /> : null}
              {actions.map(action => <Item key={action.id} icon={action.icon} label={action.label} hint={action.hint} busy={busy === action.id} disabled={!!busy}
                onPress={() => void run(action.id, action.run)} />)}
            </View>}
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            {!renaming ? <Button label="Close" kind="link" onPress={close} disabled={!!busy} /> : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </KeyboardAvoidingView>
  </Modal>;
}

function Item({ icon, label, hint, busy, disabled, onPress }: { icon: DesignAction["icon"]; label: string; hint?: string; busy?: boolean; disabled?: boolean; onPress: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return <Pressable accessibilityRole="menuitem" accessibilityLabel={label} accessibilityHint={hint} accessibilityState={{ disabled, busy }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.item, pressed && styles.pressed, disabled && !busy && styles.disabled]}>
    <AppIcon name={icon} size={18} color={colors.ink} />
    <View style={styles.itemCopy}>
      <Text style={styles.itemLabel}>{busy ? `${label}…` : label}</Text>
      {hint ? <Text style={styles.itemHint}>{hint}</Text> : null}
    </View>
  </Pressable>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  fill: { flex: 1 },
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: space.side, backgroundColor: "rgba(17,46,81,0.42)" },
  card: { width: "100%", maxWidth: 440, maxHeight: "90%", backgroundColor: colors.background, borderRadius: radius.lg, padding: space.side },
  title: { ...typography.heading, color: colors.ink, marginBottom: space.sm },
  actions: { gap: 2 },
  item: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xs, paddingVertical: space.xs, borderRadius: radius.md },
  itemCopy: { flex: 1, minWidth: 0 },
  itemLabel: { ...typography.body, color: colors.ink },
  itemHint: { ...typography.meta, color: colors.muted },
  pressed: { backgroundColor: colors.surface },
  disabled: { opacity: 0.5 },
  rename: { gap: space.xs },
  label: { ...typography.label, color: colors.ink },
  input: controls.input,
  row: { flexDirection: "row", gap: space.xs, justifyContent: "flex-end" },
  error: { ...typography.caption, color: colors.red, marginTop: space.sm },
}));
