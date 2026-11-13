import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Button } from "./Button";
import { lexiconApi, type LexiconEntry, type ShortcutFields } from "../lib/lexicon-api";
import type { Account } from "../lib/server";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

export function LexiconEditor({ account, entry, saveEntry, onSaved, onCancel }: {
  account: Account;
  entry?: LexiconEntry;
  saveEntry?: (fields: ShortcutFields) => Promise<LexiconEntry>;
  onSaved: (entry: LexiconEntry) => void;
  onCancel: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [abbreviation, setAbbreviation] = useState(entry?.abbreviation ?? "");
  const [replacement, setReplacement] = useState(entry?.fullName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = async () => {
    if (saving.current || !abbreviation.trim() || !replacement.trim()) return;
    saving.current = true; setBusy(true); setError("");
    try {
      const fields = { abbreviation, fullName: replacement };
      const saved = saveEntry ? await saveEntry(fields) : entry ? await lexiconApi.update(account, entry.id, fields) : await lexiconApi.create(account, fields);
      if (mounted.current) onSaved(saved);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "Couldn't save the shortcut. Try again.");
    } finally { saving.current = false; if (mounted.current) setBusy(false); }
  };
  return <Modal visible transparent animationType="fade" onRequestClose={() => { if (!busy) onCancel(); }}>
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.scrim}>
      <View accessibilityViewIsModal style={styles.dialog}>
        <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={styles.form}>
          <Text accessibilityRole="header" style={styles.title}>{entry ? "Edit shortcut" : "Add shortcut"}</Text>
          <Text style={styles.label}>Abbreviation</Text>
          <TextInput testID="lexicon-abbreviation" accessibilityLabel="Abbreviation" autoFocus editable={!busy} value={abbreviation} onChangeText={setAbbreviation} autoCapitalize="none" autoCorrect={false} maxLength={32} placeholderTextColor={colors.muted} style={styles.input} />
          <Text style={styles.label}>Meaning</Text>
          <TextInput testID="lexicon-full-name" accessibilityLabel="Meaning" editable={!busy} value={replacement} onChangeText={setReplacement} maxLength={200} placeholderTextColor={colors.muted} style={styles.input} onSubmitEditing={() => void save()} returnKeyType="done" />
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <View style={styles.actions}>
            <Button label="Cancel" kind="secondary" disabled={busy} onPress={onCancel} />
            <Button label="Save" busy={busy} disabled={!abbreviation.trim() || !replacement.trim()} onPress={() => void save()} />
          </View>
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", padding: space.md, backgroundColor: colors.scrim },
  dialog: { width: "100%", maxWidth: 480, maxHeight: "100%", backgroundColor: colors.background, borderRadius: radius.lg, overflow: "hidden" },
  form: { padding: space.md },
  title: { ...typography.heading, color: colors.ink },
  label: { ...typography.label, color: colors.muted, marginTop: space.md, marginBottom: space.xxs },
  input: controls.input,
  error: { ...typography.body, color: colors.red, marginTop: space.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.xs, marginTop: space.md },
}));
