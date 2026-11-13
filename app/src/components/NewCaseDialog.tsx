import { useEffect, useRef, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { randomUUID } from "expo-crypto";
import { Button, ButtonGroup } from "./Button";
import { createInboxDraftId, type InboxClient } from "../lib/secure-inbox";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

export function NewCaseDialog({ client, onClose, onCreated }: { client: InboxClient; onClose: () => void; onCreated: (id: string) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft] = useState(() => createInboxDraftId(randomUUID));
  const controller = useRef(new AbortController());
  useEffect(() => { controller.current = new AbortController(); return () => controller.current.abort(); }, []);
  const create = async () => {
    if (busy || !name.trim() || !subject.trim()) return;
    setBusy(true); setError("");
    try {
      const result = await client.create({ name: name.trim(), email: email.trim(), subject: subject.trim() }, draft.current(), controller.current.signal);
      if (!controller.current.signal.aborted) onCreated(result.conversation.id);
    } catch (cause) { if (!controller.current.signal.aborted) setError(`${cause instanceof Error ? cause.message : "Couldn't create the case."} Your details are kept. Try again.`); }
    finally { if (!controller.current.signal.aborted) setBusy(false); }
  };
  return <Modal visible transparent animationType="fade" onRequestClose={() => { if (!busy) onClose(); }}>
    <View style={styles.scrim}><View style={styles.dialog} accessibilityViewIsModal><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" style={styles.title}>New case</Text>
      <Text style={styles.caption}>Start a case for someone your team is helping. It will be assigned to you.</Text>
      {/* Each label sits on its own field; the space is between fields. */}
      <View style={styles.field}><Text style={styles.label}>Name</Text><TextInput accessibilityLabel="Name" value={name} onChangeText={value => { setName(value); draft.reset(); }} maxLength={80} editable={!busy} style={styles.input} placeholderTextColor={colors.muted} /></View>
      <View style={styles.field}><Text style={styles.label}>Contact email (optional)</Text><TextInput accessibilityLabel="Contact email (optional)" value={email} onChangeText={value => { setEmail(value); draft.reset(); }} maxLength={254} editable={!busy} autoCapitalize="none" keyboardType="email-address" style={styles.input} placeholderTextColor={colors.muted} />
        <Text style={styles.caption}>A contact detail only. This does not send an email or verify identity.</Text></View>
      <View style={styles.field}><Text style={styles.label}>Subject</Text><TextInput accessibilityLabel="Subject" value={subject} onChangeText={value => { setSubject(value); draft.reset(); }} maxLength={160} editable={!busy} style={styles.input} placeholderTextColor={colors.muted} /></View>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <ButtonGroup align="end"><Button label="Cancel" kind="secondary" disabled={busy} onPress={onClose} /><Button label="Create case" disabled={!name.trim() || !subject.trim()} busy={busy} onPress={() => void create()} /></ButtonGroup>
    </ScrollView></View></View>
  </Modal>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  input: controls.input,
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", padding: space.lg, backgroundColor: colors.scrim }, dialog: { width: "100%", maxWidth: 520, maxHeight: "90%", backgroundColor: colors.background, borderRadius: radius.lg }, content: { padding: space.lg, gap: space.md }, title: { ...typography.heading, color: colors.ink }, field: { gap: space.xxs }, label: { ...typography.label, color: colors.ink }, caption: { ...typography.caption, color: colors.muted }, error: { ...typography.caption, color: colors.red },
}));
