import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Button } from "./Button";
import { rememberProject } from "../lib/projects-store";
import { api, ServerError } from "../lib/server";
import { useSession } from "../lib/session";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

// Name a new project; it opens as soon as it's made. Used from the sidebar and Home.
export function NewProjectDialog({ visible, onClose, onCreated }: { visible: boolean; onClose: () => void; onCreated?: (id: string) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { if (busy) return; setName(""); setError(null); onClose(); };
  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy || !account) return;
    setBusy(true); setError(null);
    try {
      const project = await api.createProject(account, { name: trimmed });
      rememberProject(project, account);
      setName(""); onClose();
      if (onCreated) onCreated(project.id); else router.push({ pathname: "/project", params: { id: project.id } });
    } catch (e) { setError(e instanceof ServerError ? e.message : "Couldn't make the project"); }
    finally { setBusy(false); }
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.fill}>
      <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={close}>
        <Pressable accessibilityViewIsModal style={styles.card} onPress={() => {}}>
          <Text accessibilityRole="header" style={styles.title}>New project</Text>
          <TextInput accessibilityLabel="Project name" autoFocus value={name} onChangeText={setName} onSubmitEditing={() => void create()} returnKeyType="done" maxLength={60}
            placeholder="Project name" placeholderTextColor={colors.muted} style={styles.input} />
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <View style={styles.actions}>
            <Button label="Cancel" kind="secondary" onPress={close} style={{ flex: 1 }} />
            <Button label="Create" busy={busy} disabled={!name.trim()} onPress={() => void create()} style={{ flex: 1 }} />
          </View>
        </Pressable>
      </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  fill: { flex: 1 },
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: space.side, backgroundColor: colors.scrim },
  card: { width: "100%", maxWidth: 420, backgroundColor: colors.background, borderRadius: radius.lg, padding: space.side },
  title: { ...typography.heading, color: colors.ink, marginBottom: space.sm },
  input: controls.input,
  error: { ...typography.caption, color: colors.red, marginTop: space.sm },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.md },
}));
