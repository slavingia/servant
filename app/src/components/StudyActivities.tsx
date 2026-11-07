import { useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { AppIcon } from "./AppIcon";
import { Button } from "./Button";
import {
  GOALS,
  MAX_STUDY_ACTIVITIES,
  STUDY_COLLECTIONS,
  STUDY_METHODS,
  changeActivityMethod,
  changeSortMode,
  methodLabel,
  newStudyActivity,
  summarizeActivities,
  type HypothesisDirection,
  type StudyActivity,
  type StudyGoal,
  type StudyMethod,
  type StudySetup,
} from "../lib/research-methods";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

const MAX_DESIGNS = 6;

/**
 * Editor for unmoderated Civic Research Studio activities. Presentational: the
 * caller owns the state, so the live study form and the local preview share it.
 * Sample sizes and standard analysis come from the ported Research Studio planner.
 */
export function StudyActivities({ activities, setup, onActivities, onSetup, disabled = false }: {
  activities: readonly StudyActivity[];
  setup: StudySetup;
  onActivities: (next: StudyActivity[]) => void;
  onSetup: (next: StudySetup) => void;
  disabled?: boolean;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [choosing, setChoosing] = useState(false);
  const [openAnalysis, setOpenAnalysis] = useState<string | null>(null);
  const summary = useMemo(() => summarizeActivities(activities), [activities]);
  const update = (key: string, change: (activity: StudyActivity) => StudyActivity) =>
    onActivities(activities.map(activity => activity.key === key ? change(activity) : activity));
  const add = (method: StudyMethod) => {
    // Keys only need to be unique within this list.
    const used = new Set(activities.map(activity => activity.key));
    let n = activities.length + 1;
    while (used.has(`activity-${n}`)) n++;
    const key = `activity-${n}`;
    onActivities([...activities, newStudyActivity(method, key)]);
    setChoosing(false);
  };

  return <View style={styles.root}>
    <Text accessibilityRole="header" style={styles.heading}>Study activities</Text>
    <Text style={styles.description}>Unmoderated activities that run in Civic Research Studio. Everyone takes every activity. Sample sizes and analysis use Research Studio's own planner.</Text>

    <Choice label="Data collection" value={setup.collection} disabled={disabled}
      options={STUDY_COLLECTIONS.map(item => ({ value: item.id, label: item.label, description: item.description }))}
      onChange={collection => onSetup({ ...setup, collection })} />
    <Choice label="Devices" value={setup.devices} disabled={disabled} inline
      options={[{ value: "any", label: "Any device" }, { value: "desktop", label: "Laptops and desktops only" }]}
      onChange={devices => onSetup({ ...setup, devices })} />

    {activities.map((activity, index) => {
      const item = summary.items[index];
      const goals = GOALS[activity.method];
      const set = (change: Partial<StudyActivity>) => update(activity.key, current => ({ ...current, ...change }));
      return <View key={activity.key} style={styles.card}>
        <View style={styles.cardHeader}>
          <Text accessibilityRole="header" style={styles.cardTitle} numberOfLines={2}>{index + 1}. {activity.title.trim() || "Untitled activity"} · {methodLabel(activity.method)}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove activity ${index + 1}`} disabled={disabled} hitSlop={8}
            onPress={() => onActivities(activities.filter(item => item.key !== activity.key))} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
            <AppIcon name="close" size={16} color={colors.muted} />
          </Pressable>
        </View>
        <Choice label="Method" value={activity.method} disabled={disabled} inline
          options={STUDY_METHODS.map(method => ({ value: method.id, label: method.label }))}
          onChange={method => update(activity.key, current => changeActivityMethod(current, method))} />
        <Field label="Activity title" value={activity.title} onChange={title => set({ title })} placeholder="e.g. Make a one-time payment" disabled={disabled} />
        <Field label="Instructions for participants" required value={activity.instructions} onChange={instructions => set({ instructions })} multiline
          placeholder="What participants see before they start" disabled={disabled} />
        <Field label="What this activity should tell you" value={activity.objective} onChange={objective => set({ objective })} multiline disabled={disabled} />

        {goals ? <Choice label="Goal" value={activity.goal} disabled={disabled}
          options={Object.entries(goals).map(([value, label]) => ({ value: value as StudyGoal, label: label! }))}
          onChange={goal => set({ goal })} /> : null}

        {activity.method === "prototype" ? <>
          <Field label="Prototype link" required value={activity.url} onChange={url => set({ url })} url placeholder="https://…" disabled={disabled} />
          <Field label="Success signal" value={activity.successSignal} onChange={successSignal => set({ successSignal })} disabled={disabled}
            help="Optional. The signal the prototype sends when the task is done, e.g. payment-submitted." />
          {activity.goal === "discover" ? <Row>
            <NumberField label="People per round" value={activity.perRound} onChange={perRound => set({ perRound })} disabled={disabled} />
            <NumberField label="Rounds" value={activity.rounds} onChange={rounds => set({ rounds })} disabled={disabled} />
          </Row> : <Row>
            <NumberField label="Benchmark success (%)" value={activity.benchmark} onChange={benchmark => set({ benchmark })} disabled={disabled} />
            <NumberField label="Precision (± points)" value={activity.margin} onChange={margin => set({ margin })} disabled={disabled} />
          </Row>}
        </> : null}

        {activity.method === "ab_test" || activity.method === "preference" ? <Designs activity={activity} disabled={disabled} onChange={set} /> : null}

        {activity.method === "ab_test" ? <>
          <Field label="Success signal" value={activity.successSignal} onChange={successSignal => set({ successSignal })} disabled={disabled}
            help="Optional but recommended. Without it, the primary measure is self-reported completion." />
          <Choice label="Hypothesis: compared with the control, each other design will have…" value={activity.direction} disabled={disabled} inline
            options={[{ value: "higher", label: "Higher success" }, { value: "lower", label: "Lower success" }, { value: "different", label: "Different success" }] as { value: HypothesisDirection; label: string }[]}
            onChange={direction => set({ direction })} />
          <Row>
            <NumberField label="Expected control rate (%)" value={activity.baseline} onChange={baseline => set({ baseline })} disabled={disabled} />
            <NumberField label="Difference to detect (points)" value={activity.difference} onChange={difference => set({ difference })} disabled={disabled} />
          </Row>
          <PowerChoice value={activity.power} onChange={power => set({ power })} disabled={disabled} />
          <Field label="Stopping rule" value={activity.stoppingRule} onChange={stoppingRule => set({ stoppingRule })} multiline disabled={disabled}
            help="Optional. Default: field until every design reaches its target, then analyse once." />
        </> : null}

        {activity.method === "card_sort" ? <>
          <Choice label="Sort type" value={activity.sortMode} disabled={disabled} inline
            options={[{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }, { value: "hybrid", label: "Hybrid" }] as { value: StudyActivity["sortMode"]; label: string }[]}
            onChange={sortMode => update(activity.key, current => changeSortMode(current, sortMode))} />
          <Field label="Cards" required value={activity.cards} onChange={cards => set({ cards })} multiline help="One card per line." disabled={disabled} />
          {activity.sortMode !== "open" ? <Field label="Categories" required={activity.sortMode === "closed"} value={activity.categories} onChange={categories => set({ categories })} multiline help="One category per line." disabled={disabled} /> : null}
          <Row>
            <NumberField label="Agreement threshold (%)" value={activity.threshold} onChange={threshold => set({ threshold })} disabled={disabled} />
            {activity.goal === "explore"
              ? <NumberField label="Target participants" value={activity.target} onChange={target => set({ target })} disabled={disabled} />
              : <NumberField label="Precision (± points)" value={activity.margin} onChange={margin => set({ margin })} disabled={disabled} />}
          </Row>
        </> : null}

        {activity.method === "tree_test" ? <>
          <Field label="Tree" required value={activity.tree} onChange={tree => set({ tree })} multiline mono disabled={disabled}
            help={"One label per line. Indent two spaces for each level. End each correct destination with *, e.g. \"  Tax transcripts *\"."} />
          <Row>
            <NumberField label="Benchmark success (%)" value={activity.benchmark} onChange={benchmark => set({ benchmark })} disabled={disabled} />
            <NumberField label="Benchmark directness (%)" value={activity.directBenchmark} onChange={directBenchmark => set({ directBenchmark })} disabled={disabled} />
          </Row>
          <NumberField label="Precision (± points)" value={activity.margin} onChange={margin => set({ margin })} disabled={disabled} />
        </> : null}

        {activity.method === "first_click" ? <>
          <Field label="Screenshot or mockup link" required value={activity.url} onChange={url => set({ url })} url placeholder="https://…" disabled={disabled}
            help="Draw the target areas in Research Studio after importing; until then first clicks aren't scored." />
          <Row>
            <NumberField label="Benchmark first-click success (%)" value={activity.benchmark} onChange={benchmark => set({ benchmark })} disabled={disabled} />
            <NumberField label="Precision (± points)" value={activity.margin} onChange={margin => set({ margin })} disabled={disabled} />
          </Row>
        </> : null}

        {activity.method === "preference" ? <>
          <NumberField label="Smallest split worth finding (% choosing one option)" value={activity.split} onChange={split => set({ split })} disabled={disabled} />
          <PowerChoice value={activity.power} onChange={power => set({ power })} disabled={disabled} />
        </> : null}

        {activity.method === "survey" ? <>
          <Field label="Questions" required value={activity.questions} onChange={questions => set({ questions })} multiline disabled={disabled}
            help="One question per line. They start as open text; change question types in Research Studio." />
          <Field label="What the questions measure" value={activity.constructs} onChange={constructs => set({ constructs })} placeholder="e.g. ease, confidence, trust" disabled={disabled} />
          <NumberField label="Precision (± points)" value={activity.margin} onChange={margin => set({ margin })} disabled={disabled} />
        </> : null}

        <View accessibilityLiveRegion="polite" style={styles.plan}>
          <Text style={styles.planLabel}>Sample size</Text>
          <Text style={styles.planText}>{item.size}</Text>
          {item.hypotheses.map(line => <Text key={line} style={styles.planText}>Hypothesis: {line}</Text>)}
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: openAnalysis === activity.key }}
            onPress={() => setOpenAnalysis(current => current === activity.key ? null : activity.key)} style={styles.disclosure}>
            <Text style={styles.disclosureText}>Standard analysis</Text>
            <AppIcon name={openAnalysis === activity.key ? "chevronDown" : "chevronRight"} size={14} color={colors.blueDark} />
          </Pressable>
          {openAnalysis === activity.key ? item.analysis.split(/\n+/).map(line => <Text key={line} style={styles.planText}>{line}</Text>) : null}
        </View>
        <Field label="What result would be good enough, and what you would do" value={activity.criteria} onChange={criteria => set({ criteria })} multiline disabled={disabled} />
      </View>;
    })}

    {summary.largest && activities.length > 1 ? <Text style={styles.recruit}>Recruit for the largest need: about {summary.largest.n} people ({summary.largest.title}), plus extra for drop-out.</Text> : null}

    {choosing ? <View accessibilityLabel="Choose an activity type" style={styles.picker}>
      {STUDY_METHODS.map(method => <Pressable key={method.id} accessibilityRole="button" accessibilityLabel={`Add ${method.label}`} accessibilityHint={method.description}
        onPress={() => add(method.id)} style={({ pressed }) => [styles.methodOption, pressed && styles.pressed]}>
        <View style={styles.methodCopy}>
          <Text style={styles.methodLabel}>{method.label}</Text>
          <Text style={styles.help}>{method.description}</Text>
        </View>
        <AppIcon name="plus" size={16} color={colors.blueDark} />
      </Pressable>)}
      <Button label="Cancel" kind="link" compact onPress={() => setChoosing(false)} />
    </View> : <Button label={activities.length ? "Add another activity" : "Add a study activity"} kind="secondary" compact
      disabled={disabled || activities.length >= MAX_STUDY_ACTIVITIES} onPress={() => setChoosing(true)} style={styles.addButton} />}
  </View>;
}

function Designs({ activity, disabled, onChange }: { activity: StudyActivity; disabled: boolean; onChange: (change: Partial<StudyActivity>) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const ab = activity.method === "ab_test";
  const noun = ab ? "Design" : "Option";
  const setDesign = (index: number, change: Partial<{ label: string; url: string }>) =>
    onChange({ designs: activity.designs.map((design, i) => i === index ? { ...design, ...change } : design) });
  const remove = (index: number) => onChange({
    designs: activity.designs.filter((_, i) => i !== index),
    controlIndex: activity.controlIndex === index ? 0 : activity.controlIndex > index ? activity.controlIndex - 1 : activity.controlIndex,
  });
  return <View style={styles.designs}>
    <Text style={styles.label}>{ab ? "Designs" : "Options"} *</Text>
    <Text style={styles.help}>{ab ? "A live prototype link for each design. Mark the current design as the control." : "An image link for each option. Presentation order is randomised."}</Text>
    {activity.designs.map((design, index) => {
      const letter = String.fromCharCode(65 + index);
      const control = ab && activity.controlIndex === index;
      return <View key={index} style={styles.designRow}>
        <View style={styles.designTop}>
          <Text style={styles.designLetter}>{noun} {letter}</Text>
          {ab ? <Pressable accessibilityRole="radio" accessibilityState={{ checked: control, disabled }} accessibilityLabel={`${noun} ${letter} is the control`}
            disabled={disabled} onPress={() => onChange({ controlIndex: index })} style={[styles.chip, control && styles.chipSelected]}>
            <Text style={[styles.chipText, control && styles.chipTextSelected]}>{control ? "Control" : "Make control"}</Text>
          </Pressable> : null}
          {activity.designs.length > 2 ? <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${noun.toLowerCase()} ${letter}`} disabled={disabled} hitSlop={8}
            onPress={() => remove(index)} style={styles.iconButton}><AppIcon name="close" size={14} color={colors.muted} /></Pressable> : null}
        </View>
        <TextInput accessibilityLabel={`${noun} ${letter} name`} value={design.label} editable={!disabled} onChangeText={label => setDesign(index, { label })}
          placeholder="Name" placeholderTextColor={colors.muted} style={styles.input} />
        <TextInput accessibilityLabel={`${noun} ${letter} ${ab ? "prototype" : "image"} link`} value={design.url} editable={!disabled} onChangeText={url => setDesign(index, { url })}
          placeholder="https://…" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.input} />
      </View>;
    })}
    {activity.designs.length < MAX_DESIGNS ? <Button label={`Add ${noun.toLowerCase()}`} kind="link" compact disabled={disabled}
      onPress={() => onChange({ designs: [...activity.designs, { label: "", url: "" }] })} /> : null}
  </View>;
}

function Choice<T extends string>({ label, value, options, onChange, disabled, inline = false }: {
  label: string; value: T; options: { value: T; label: string; description?: string }[]; onChange: (value: T) => void; disabled: boolean; inline?: boolean;
}) {
  const styles = useStyles();
  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={inline ? styles.chips : styles.options}>
      {options.map(option => {
        const selected = option.value === value;
        return inline
          ? <Pressable key={option.value} accessibilityRole="radio" accessibilityState={{ checked: selected, disabled }} disabled={disabled}
            onPress={() => onChange(option.value)} style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}>
            <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{option.label}</Text>
          </Pressable>
          : <Pressable key={option.value} accessibilityRole="radio" accessibilityState={{ checked: selected, disabled }} disabled={disabled}
            onPress={() => onChange(option.value)} style={({ pressed }) => [styles.option, selected && styles.optionSelected, pressed && styles.pressed]}>
            <View style={[styles.radio, selected && styles.radioSelected]}>{selected ? <View style={styles.radioDot} /> : null}</View>
            <View style={styles.methodCopy}>
              <Text style={styles.optionLabel}>{option.label}</Text>
              {option.description ? <Text style={styles.help}>{option.description}</Text> : null}
            </View>
          </Pressable>;
      })}
    </View>
  </View>;
}

function PowerChoice({ value, onChange, disabled }: { value: number; onChange: (value: number) => void; disabled: boolean }) {
  return <Choice label="Power" value={value === 0.9 ? "0.9" : "0.8"} disabled={disabled} inline
    options={[{ value: "0.8", label: "80% (common)" }, { value: "0.9", label: "90%" }]} onChange={next => onChange(Number(next))} />;
}

function Field({ label, value, onChange, required, multiline, url, mono, placeholder, help, disabled }: {
  label: string; value: string; onChange: (value: string) => void; required?: boolean; multiline?: boolean; url?: boolean; mono?: boolean; placeholder?: string; help?: string; disabled: boolean;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  return <View style={styles.field}>
    <Text style={styles.label}>{label}{required ? " *" : ""}</Text>
    {help ? <Text style={styles.help}>{help}</Text> : null}
    <TextInput accessibilityLabel={`${label}${required ? ", required for the Research Studio file" : ", optional"}`} value={value} onChangeText={onChange} editable={!disabled}
      multiline={multiline} textAlignVertical={multiline ? "top" : "center"} placeholder={placeholder} placeholderTextColor={colors.muted}
      autoCapitalize={url || mono ? "none" : "sentences"} autoCorrect={!url && !mono} keyboardType={url ? "url" : "default"}
      style={[styles.input, multiline && styles.multiline, mono && styles.mono]} />
  </View>;
}

function NumberField({ label, value, onChange, disabled }: { label: string; value: number | null; onChange: (value: number | null) => void; disabled: boolean }) {
  const styles = useStyles();
  return <View style={[styles.field, styles.numberField]}>
    <Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={label} value={value == null ? "" : String(value)} editable={!disabled} keyboardType="number-pad" inputMode="numeric"
      onChangeText={text => { const digits = text.replace(/[^0-9]/g, "").slice(0, 4); onChange(digits ? Number(digits) : null); }} style={styles.input} />
  </View>;
}

function Row({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <View style={styles.row}>{children}</View>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { gap: space.sm },
  heading: { ...typography.heading, color: colors.ink },
  description: { ...typography.caption, color: colors.muted },
  card: { gap: space.sm, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  cardTitle: { ...typography.bodyStrong, color: colors.ink, flex: 1, minWidth: 0 },
  iconButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  field: { gap: space.xxs },
  numberField: { flex: 1, minWidth: 140 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  label: { ...typography.captionStrong, color: colors.ink },
  help: { ...typography.meta, color: colors.muted },
  input: { ...controls.input },
  multiline: { minHeight: 88, paddingTop: space.sm },
  mono: { fontFamily: "monospace" },
  options: { gap: space.xs },
  option: { minHeight: 48, flexDirection: "row", alignItems: "flex-start", gap: space.sm, padding: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
  optionSelected: { borderColor: colors.blue, backgroundColor: colors.blueSoft },
  optionLabel: { ...typography.caption, color: colors.ink },
  radio: { width: 20, height: 20, marginTop: 2, borderRadius: 10, borderWidth: 2, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  radioSelected: { borderColor: colors.blue },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.blue },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  chip: { minHeight: 36, justifyContent: "center", paddingHorizontal: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background },
  chipSelected: { borderColor: colors.blue, backgroundColor: colors.blueSoft },
  chipText: { ...typography.meta, color: colors.ink },
  chipTextSelected: { color: colors.blueDark, fontWeight: "700" },
  designs: { gap: space.xs },
  designRow: { gap: space.xs, padding: space.sm, borderRadius: radius.md, backgroundColor: colors.surface },
  designTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
  designLetter: { ...typography.captionStrong, color: colors.ink, flex: 1 },
  plan: { gap: space.xxs, padding: space.sm, borderLeftWidth: 3, borderLeftColor: colors.blue, backgroundColor: colors.surface },
  planLabel: { ...typography.captionStrong, color: colors.ink },
  planText: { ...typography.meta, color: colors.ink },
  disclosure: { minHeight: 36, flexDirection: "row", alignItems: "center", gap: space.xxs },
  disclosureText: { ...typography.meta, color: colors.blueDark, fontWeight: "700" },
  recruit: { ...typography.caption, color: colors.ink },
  picker: { gap: space.xs },
  methodOption: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
  methodCopy: { flex: 1, minWidth: 0 },
  methodLabel: { ...typography.caption, color: colors.ink, fontWeight: "700" },
  addButton: { alignSelf: "flex-start" },
  pressed: { opacity: 0.75 },
}));
