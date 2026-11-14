import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AppIcon } from "./AppIcon";
import { ConfirmDialog } from "./ConfirmDialog";
import { MethodIllustration } from "./MethodIllustration";
import { checkboxKeys } from "./useRadioGroup";
import {
  MAX_OTHER_METHODS,
  MAX_STUDY_ACTIVITIES,
  OTHER_METHOD_PRESETS,
  STUDY_METHODS,
  activityEdited,
  newOtherMethod,
  nextPlanKey,
  otherMethodEdited,
  templateActivity,
  type OtherMethod,
  type OtherMethodPreset,
  type StudyActivity,
  type StudyMethod,
} from "../lib/research-methods";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

type MethodChoice = { kind: "studio"; id: StudyMethod; label: string } | { kind: "other"; id: OtherMethodPreset; label: string };

/**
 * The start of a study plan: choose one or more methods, and each adds a plan
 * item with its starting text. Unticking a method removes its items (after a
 * confirmation if anything was changed). Presentational: the caller owns the
 * activities and other methods, which the Study activities editor also edits.
 */
export function StudyMethodPicker({ activities, otherMethods, onActivities, onOtherMethods, disabled = false }: {
  activities: readonly StudyActivity[];
  otherMethods: readonly OtherMethod[];
  onActivities: (next: StudyActivity[]) => void;
  onOtherMethods: (next: OtherMethod[]) => void;
  disabled?: boolean;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [removing, setRemoving] = useState<MethodChoice | null>(null);
  const [status, setStatus] = useState("");
  const usedKeys = () => [...activities.map(item => item.key), ...otherMethods.map(item => item.key)];
  const itemsOf = (pick: MethodChoice) => pick.kind === "studio" ? activities.filter(item => item.method === pick.id) : otherMethods.filter(item => item.preset === pick.id);
  const remove = (pick: MethodChoice) => {
    if (pick.kind === "studio") onActivities(activities.filter(item => item.method !== pick.id));
    else onOtherMethods(otherMethods.filter(item => item.preset !== pick.id));
    setStatus(`Removed ${pick.label} from the plan.`);
  };
  const toggle = (pick: MethodChoice) => {
    const items = itemsOf(pick);
    if (!items.length) {
      if (pick.kind === "studio") onActivities([...activities, templateActivity(pick.id, nextPlanKey("activity", usedKeys()))]);
      else onOtherMethods([...otherMethods, newOtherMethod(pick.id, nextPlanKey("other", usedKeys()))]);
      setStatus(`Added ${pick.label}. Edit it under Study activities below.`);
      return;
    }
    const edited = pick.kind === "studio" ? (items as StudyActivity[]).some(activityEdited) : (items as OtherMethod[]).some(otherMethodEdited);
    if (edited) setRemoving(pick);
    else remove(pick);
  };
  const studioFull = activities.length >= MAX_STUDY_ACTIVITIES;
  const otherFull = otherMethods.length >= MAX_OTHER_METHODS;

  const row = (pick: MethodChoice, description: string, full: boolean) => {
    const count = itemsOf(pick).length;
    const checked = count > 0;
    const off = disabled || (!checked && full);
    return <Pressable key={`${pick.kind}-${pick.id}`} accessibilityRole="checkbox" role="checkbox" aria-checked={checked} aria-disabled={off || undefined}
      accessibilityState={{ checked, disabled: off }} accessibilityLabel={`${pick.label}. ${description}`} accessibilityHint={checked ? "Removes it from the plan" : "Adds it to the plan with starting text you can edit"}
      disabled={off} {...checkboxKeys(() => toggle(pick), off)} onPress={() => toggle(pick)}
      style={({ pressed }) => [styles.option, checked && styles.optionChecked, pressed && styles.pressed]}>
      <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
        {checked ? <AppIcon name="check" size={14} color={colors.onPrimary} /> : null}
      </View>
      <View style={styles.copy}>
        <Text style={[styles.label, off && !checked && styles.muted]}>{pick.label}{count > 1 ? ` · ${count} in this plan` : ""}</Text>
        <Text style={styles.help}>{description}</Text>
      </View>
      <MethodIllustration method={pick.id} width={72} />
    </Pressable>;
  };

  const removingCount = removing ? itemsOf(removing).length : 0;
  return <View style={styles.root}>
    <Text accessibilityRole="header" style={styles.heading}>Choose your methods</Text>
    <Text style={styles.description}>Pick one or more. Each adds a starting plan you can change under Study activities below: replace the [bracketed] text with your own. You can add, remove or change methods at any time.</Text>

    <Text style={styles.group}>Run in Civic Research Studio (unmoderated)</Text>
    <View style={styles.options}>
      {STUDY_METHODS.map(method => row({ kind: "studio", id: method.id, label: method.label }, method.description, studioFull))}
    </View>
    {studioFull ? <Text style={styles.help}>A plan can have up to {MAX_STUDY_ACTIVITIES} Research Studio activities.</Text> : null}

    <Text style={styles.group}>Run outside Research Studio</Text>
    <Text style={styles.help}>Listed in the plan and in the working draft's analysis plan, but Research Studio doesn't run them or size their samples.</Text>
    <View style={styles.options}>
      {OTHER_METHOD_PRESETS.map(preset => row({ kind: "other", id: preset.id, label: preset.label }, preset.description, otherFull))}
    </View>

    <Text accessibilityLiveRegion="polite" style={styles.status}>{status}</Text>

    <ConfirmDialog visible={removing !== null} title={`Remove ${removing?.label ?? "this method"}?`} confirmLabel="Remove"
      description={`This removes ${removingCount === 1 ? "it" : `all ${removingCount}`} from the plan, including what you entered. It can't be undone.`}
      onConfirm={() => { if (removing) remove(removing); setRemoving(null); }} onCancel={() => setRemoving(null)} />
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { gap: space.xs },
  heading: { ...typography.heading, color: colors.ink },
  description: { ...typography.caption, color: colors.muted },
  group: { ...typography.captionStrong, color: colors.ink, marginTop: space.sm },
  options: { gap: space.xs },
  option: { minHeight: 48, flexDirection: "row", alignItems: "flex-start", gap: space.sm, padding: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background },
  optionChecked: { borderColor: colors.blue, backgroundColor: colors.blueSoft },
  checkbox: { width: 22, height: 22, marginTop: 1, borderRadius: radius.sm, borderWidth: 2, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  checkboxChecked: { borderColor: colors.blue, backgroundColor: colors.blue },
  copy: { flex: 1, minWidth: 0, gap: 2 },
  label: { ...typography.caption, color: colors.ink, fontWeight: "700" },
  help: { ...typography.meta, color: colors.muted },
  muted: { color: colors.muted },
  status: { ...typography.meta, color: colors.ink, minHeight: 1 },
  pressed: { opacity: 0.75 },
}));
