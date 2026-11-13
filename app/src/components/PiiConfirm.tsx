import { useCallback, useRef, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Button } from "./Button";
import { CheckBox } from "./CheckBox";
import type { PiiChoice } from "../lib/pii-warning";
import { radius, space, typography, createThemedStyles } from "../lib/theme";

type Ask = (message: string, options?: { reportable?: boolean }) => Promise<PiiChoice>;

/** Asks "send anyway?" when the server warns about personal or sensitive business information. When the server can take a
 * report, it also offers "This wasn't sensitive": send anyway, and tell the owner the warning was wrong so the check can
 * learn from it. Returns ask() and the dialog to render. */
export function usePiiConfirm(): { ask: Ask; dialog: ReactNode } {
  const styles = useStyles();
  const [state, setState] = useState<{ message: string; reportable: boolean } | null>(null);
  const [wrong, setWrong] = useState(false);
  const pending = useRef<((choice: PiiChoice) => void) | null>(null);
  const ask = useCallback<Ask>((text, options) => new Promise<PiiChoice>(resolve => {
    pending.current = resolve; setWrong(false); setState({ message: text, reportable: options?.reportable === true });
  }), []);
  const settle = (choice: PiiChoice) => { setState(null); pending.current?.(choice); pending.current = null; };
  const dialog = (
    <Modal visible={state !== null} transparent animationType="fade" onRequestClose={() => settle(false)}>
      <View style={styles.scrim}>
        <View style={styles.dialog} accessibilityViewIsModal>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text accessibilityRole="header" style={styles.title}>Send with sensitive information?</Text>
            <Text style={styles.description}>{state?.message ?? ""}</Text>
            {state?.reportable ? (
              <Pressable testID="pii-not-sensitive" accessibilityRole="checkbox" accessibilityState={{ checked: wrong }} aria-checked={wrong} onPress={() => setWrong(v => !v)} style={styles.check}>
                <CheckBox on={wrong} style={styles.box} />
                <View style={styles.checkCopy}>
                  <Text style={styles.checkLabel}>This wasn't sensitive</Text>
                  <Text style={styles.checkHint}>Send and report a false warning. Your message is saved for owner review.</Text>
                </View>
              </Pressable>
            ) : null}
            <View style={styles.actions}>
              <Button label="Cancel" kind="secondary" onPress={() => settle(false)} />
              <Button label="Send anyway" kind="primary" onPress={() => settle(wrong && state?.reportable ? "reported" : true)} />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
  return { ask, dialog };
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", padding: space.lg, backgroundColor: colors.scrim },
  dialog: { width: "100%", maxWidth: 440, maxHeight: "100%", backgroundColor: colors.background, borderRadius: radius.lg, overflow: "hidden" },
  content: { padding: space.lg },
  title: { ...typography.heading, color: colors.ink },
  description: { ...typography.body, color: colors.muted, marginTop: space.sm },
  check: { flexDirection: "row", gap: space.sm, marginTop: space.md, paddingVertical: space.xs, minHeight: 44 },
  box: { marginTop: 1 },
  checkCopy: { flex: 1 },
  checkLabel: { ...typography.bodyStrong, color: colors.ink },
  checkHint: { ...typography.caption, color: colors.muted, marginTop: 2 },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.xs, marginTop: space.lg },
}));
