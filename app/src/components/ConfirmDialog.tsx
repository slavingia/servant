import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { radius, space, typography, createThemedStyles } from "../lib/theme";
import { Button } from "./Button";

type Props = {
  visible: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
  destructive?: boolean;
};

export function ConfirmDialog({ visible, title, description, confirmLabel, onConfirm, onCancel, busy, error, destructive = true }: Props) {
  const styles = useStyles();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => { if (!busy) onCancel(); }}>
      <View style={styles.scrim}>
        <View style={styles.dialog} accessibilityViewIsModal>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text accessibilityRole="header" style={styles.title}>{title}</Text>
          <Text style={styles.description}>{description}</Text>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <View style={styles.actions}>
            <Button label="Cancel" kind="secondary" onPress={onCancel} disabled={busy} />
            <Button label={confirmLabel} kind={destructive ? "danger" : "primary"} onPress={onConfirm} busy={busy} />
          </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", padding: space.lg, backgroundColor: "rgba(17,46,81,0.42)" },
  dialog: { width: "100%", maxWidth: 440, maxHeight: "100%", backgroundColor: colors.background, borderRadius: radius.lg, overflow: "hidden" },
  content: { padding: space.lg },
  title: { ...typography.heading, color: colors.ink },
  description: { ...typography.body, color: colors.muted, marginTop: space.sm },
  error: { ...typography.caption, color: colors.red, marginTop: space.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.xs, marginTop: space.lg },
}));
