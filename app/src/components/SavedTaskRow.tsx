import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { savedMessageHref, savedMessagePreview, savedMessageSource } from "../lib/saved-messages";
import { savedWorkLabel } from "../lib/saved-report";
import type { SavedCompletion, SavedMessage } from "../lib/server";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";
import { Button } from "./Button";
import { CheckBox } from "./CheckBox";

export function SavedTaskRow({ item, completion, note, expanded, disabled, busy, onExpand, onNote, onTick, onRemove }: {
  item: SavedMessage; completion?: SavedCompletion; note: string; expanded: boolean; disabled: boolean; busy: boolean;
  onExpand: () => void; onNote: (text: string) => void; onTick: () => void; onRemove: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const done = item.completedAt !== null;
  const href = savedMessageHref(item);
  const preview = savedMessagePreview(item);
  const source = savedMessageSource(item);
  return <View testID={`saved-message-${item.messageId}`} style={styles.row}>
    <Pressable accessibilityRole="checkbox" accessibilityLabel={`${done ? "Reopen" : "Mark complete"}: ${preview.slice(0, 100)}`}
      accessibilityState={{ checked: done, disabled, busy }} aria-checked={done} disabled={disabled} onPress={onTick}
      style={({ pressed }) => [styles.checkTarget, pressed && styles.pressed]}>
      <CheckBox on={done} tone="done" busy={busy} />
    </Pressable>
    <View style={styles.body}>
      <Text selectable numberOfLines={expanded ? undefined : 4} style={[styles.title, done && styles.doneTitle, !href && styles.unavailable]}>{preview}</Text>
      {source ? <Text style={styles.source}>{source}</Text> : null}
      {done ? <Text style={styles.completed}>Completed {savedWorkLabel(item.completedAt!)}</Text> : null}
      {completion?.note ? <View style={styles.work}><Text style={styles.workLabel}>Work completed</Text><Text selectable style={styles.note}>{completion.note}</Text></View> : null}
      <View style={styles.actions}>
        {href ? <Button label="Open message" kind="link" compact onPress={() => router.push(href)} /> : null}
        {!done ? <Button label={expanded ? "Hide work note" : note ? "Edit work note" : "Add work note"} kind="link" compact onPress={onExpand} disabled={disabled} /> : null}
        <Button label="Remove" accessibilityLabel={`Remove saved message: ${preview.slice(0, 100)}`} kind="danger" compact onPress={onRemove} disabled={disabled} style={styles.remove} />
      </View>
      {expanded && !done ? <View style={styles.editor}>
        <Text style={styles.workLabel}>What did you finish?</Text>
        <TextInput accessibilityLabel="Work completed" multiline value={note} onChangeText={onNote} editable={!disabled} maxLength={4000}
          placeholder="Optional: describe the result, decisions, or links to your work…" placeholderTextColor={colors.muted} style={styles.input} />
        <Text style={styles.hint}>Your note and the completion time are kept in your work log when you check this off.</Text>
        <Text style={styles.hint}>{note.length.toLocaleString("en-US")} / 4,000 characters</Text>
        <View style={styles.finish}><Button label="Complete task" compact disabled={disabled} onPress={onTick} /></View>
      </View> : null}
    </View>
  </View>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  row: { marginHorizontal: space.side, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: colors.line, flexDirection: "row", gap: space.xxs },
  checkTarget: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  body: { flex: 1, minWidth: 0, paddingTop: space.sm },
  title: { ...typography.bodyStrong, color: colors.ink },
  doneTitle: { color: colors.muted, textDecorationLine: "line-through" },
  unavailable: { color: colors.muted, fontStyle: "italic" },
  source: { ...typography.meta, color: colors.muted, marginTop: space.xs },
  completed: { ...typography.meta, color: colors.greenDark, marginTop: space.xs },
  // The links' words line up with the message; the outlined button does too when it wraps under them.
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginLeft: -space.md, marginTop: space.xxs },
  remove: { marginLeft: space.md },
  editor: { backgroundColor: colors.surface, padding: space.sm, borderRadius: radius.md, marginVertical: space.xs, gap: space.xs },
  work: { paddingVertical: space.sm, gap: space.xxs },
  workLabel: { ...typography.label, color: colors.ink },
  note: { ...typography.body, color: colors.ink },
  input: { ...controls.input, ...controls.inputMultiline, minHeight: 100 },
  hint: { ...typography.caption, color: colors.muted },
  finish: { alignItems: "flex-start", marginTop: space.xxs },
  pressed: { opacity: 0.6 },
}));
