import { useId } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { createThemedStyles, radius, space, typography } from "../lib/theme";
import { useRadioGroup } from "./useRadioGroup";

export type PrototypeMode = "none" | "new" | "existing";
export type PrototypeModeOption = { id: PrototypeMode; label: string; description: string };

export const PROTOTYPE_OPTIONS: readonly PrototypeModeOption[] = [
  { id: "none", label: "No prototype", description: "Plan a study that does not depend on an interactive design." },
  { id: "new", label: "Create a new prototype", description: "Open a prototype-agent workspace with a build prompt based on this study brief and what your research found." },
  { id: "existing", label: "Choose an existing prototype", description: "Use an active prototype with a live preview from your Design Studio library." },
];

/**
 * The "Prototype for this study" choice, shared by the study form and the
 * local preview. Choosing has side effects (opening the prototype picker,
 * clearing a chosen prototype), so arrow keys only move focus here; Space,
 * Enter or a tap chooses.
 */
export function PrototypeModeOptions({ options, value, disabled, onChange }: {
  options: readonly PrototypeModeOption[];
  value: PrototypeMode;
  disabled: boolean;
  onChange: (mode: PrototypeMode) => void;
}) {
  const styles = useStyles();
  const radios = useRadioGroup({ values: options.map(option => option.id), value, onChange, label: "Prototype for this study", disabled, activation: "manual" });
  const helpId = `prototype-mode-help-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return <View style={styles.root}>
    <View {...radios.group} aria-describedby={helpId} style={styles.options}>
      {options.map((option, index) => {
        const selected = value === option.id;
        return <Pressable key={option.id} {...radios.radio(option.id, index)} accessibilityLabel={`${option.label}. ${option.description}`}
          style={({ pressed }) => [styles.option, selected && styles.optionSelected, pressed && !disabled && styles.optionPressed]}>
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.radio, selected && styles.radioSelected]}>
            {selected ? <View style={styles.radioDot} /> : null}
          </View>
          <View style={styles.copy}>
            <Text style={styles.title}>{option.label}</Text>
            <Text style={styles.description}>{option.description}</Text>
          </View>
        </Pressable>;
      })}
    </View>
    <Text nativeID={helpId} style={styles.help}>Arrow keys move between options; Space or Enter chooses one.</Text>
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { gap: space.xs, marginHorizontal: space.side },
  options: { gap: space.sm },
  option: { minHeight: 76, flexDirection: "row", alignItems: "flex-start", gap: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background },
  optionSelected: { borderColor: colors.blue, backgroundColor: colors.subtle },
  optionPressed: { opacity: 0.78 },
  radio: { width: 22, height: 22, borderRadius: radius.pill, borderWidth: 2, borderColor: colors.muted, alignItems: "center", justifyContent: "center", marginTop: 1 },
  radioSelected: { borderColor: colors.blue },
  radioDot: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: colors.blue },
  copy: { flex: 1, minWidth: 0 },
  title: { ...typography.bodyStrong, color: colors.ink },
  description: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  help: { ...typography.caption, color: colors.muted },
}));
