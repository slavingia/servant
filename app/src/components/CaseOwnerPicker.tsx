import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { AppIcon } from "./AppIcon";
import { Button } from "./Button";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

export type CasePerson = { id: string; name: string };

export function CaseOwnerPicker({ label, people, value, onChange, disabled, error }: { label: string; people: readonly CasePerson[]; value: string | null; onChange: (id: string | null) => void; disabled?: boolean; error?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const name = value ? people.find(person => person.id === value)?.name ?? "Former teammate" : "Unassigned";
  const close = () => { setOpen(false); setQuery(""); };
  const pick = (id: string | null) => { onChange(id); close(); };
  const shown = people.filter(person => person.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    {/* A field that opens a list: the chosen name on the left and a chevron, not a button with a name on it. */}
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open, disabled: !!disabled }} aria-expanded={open} disabled={disabled} onPress={() => setOpen(true)}
      style={({ pressed }) => [styles.select, disabled && styles.off, pressed && { backgroundColor: colors.surface }]}>
      <Text style={styles.value}>{name}</Text>
      <AppIcon name="chevronDown" size={16} color={colors.muted} />
    </Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
      <View style={styles.scrim}><View style={styles.dialog} accessibilityViewIsModal>
        <Text accessibilityRole="header" style={styles.title}>{label}</Text>
        {/* A short list needs no search. */}
        {people.length > SEARCH_FROM ? <TextInput accessibilityLabel="Find a teammate" placeholder="Find a teammate" placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} style={styles.search} autoCapitalize="none" /> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          <View accessibilityRole="radiogroup" accessibilityLabel={label}>
            {[{ id: null, name: "Unassigned" }, ...shown].map(person => <Pressable key={person.id ?? "unassigned"} accessibilityRole="radio" accessibilityLabel={person.name} accessibilityState={{ checked: value === person.id }} aria-checked={value === person.id} onPress={() => pick(person.id)} style={({ pressed }) => [styles.option, pressed && { backgroundColor: colors.surface }]}>
              <Text style={styles.optionText}>{person.name}</Text>
              {value === person.id ? <AppIcon name="check" size={18} color={colors.blue} /> : null}
            </Pressable>)}
          </View>
          {!shown.length && query ? <Text style={styles.caption}>No matching teammates.</Text> : null}
        </ScrollView>
        <Button label="Cancel" kind="secondary" onPress={close} />
      </View></View>
    </Modal>
  </View>;
}

/** With more teammates than this, the list gets a search field. */
const SEARCH_FROM = 7;

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  search: controls.input,
  field: { gap: space.xxs },
  label: { ...typography.label, color: colors.muted },
  // The shared field's boundary and height, with the value where a typed value would be.
  select: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.md, paddingVertical: space.sm, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, backgroundColor: colors.background },
  value: { ...typography.body, color: colors.ink, flex: 1, minWidth: 0 },
  off: { opacity: 0.5 },
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", padding: space.lg, backgroundColor: colors.scrim },
  dialog: { width: "100%", maxWidth: 440, maxHeight: "90%", padding: space.lg, gap: space.sm, backgroundColor: colors.background, borderRadius: radius.lg },
  title: { ...typography.heading, color: colors.ink },
  list: { flexGrow: 0, maxHeight: 360 },
  option: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xs, borderRadius: radius.sm },
  optionText: { ...typography.body, color: colors.ink, flex: 1, minWidth: 0 },
  caption: { ...typography.caption, color: colors.muted, padding: space.sm },
  error: { ...typography.caption, color: colors.red },
}));
