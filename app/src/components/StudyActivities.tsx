import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { AppIcon } from "./AppIcon";
import { Button } from "./Button";
import { MethodIllustration } from "./MethodIllustration";
import {
  GOALS,
  METHOD_PARTICIPANT_VIEW,
  OTHER_METHOD_PARTICIPANT_VIEW,
  MAX_OTHER_METHOD_PARTICIPANTS,
  MAX_OTHER_METHODS,
  MAX_STUDY_ACTIVITIES,
  OTHER_METHOD_PRESETS,
  STUDY_COLLECTIONS,
  STUDY_METHODS,
  STOP_DEFAULT,
  changeSortMode,
  chooseControl,
  directionOptions,
  methodLabel,
  newOtherMethod,
  nextPlanKey,
  otherMethodLabel,
  summarizeActivities,
  templateActivity,
  switchActivityMethod,
  usableLoss,
  NO_LOSS_ALLOWANCE_TEXT,
  type HypothesisDirection,
  type OtherMethod,
  type OtherMethodPreset,
  type StudyActivity,
  type StudyGoal,
  type StudyMethod,
  type StudySetup,
  AB_DESIGNS,
  POWERED_PREFERENCE_OPTIONS,
} from "../lib/research-methods";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";
import { checkboxKeys, useRadioGroup } from "./useRadioGroup";

const MAX_DESIGNS = 6;

/**
 * Editor for unmoderated Civic Research Studio activities. Presentational: the
 * caller owns the state, so the live study form and the local preview share it.
 * Sample sizes and standard analysis come from the ported Research Studio planner.
 */
export function StudyActivities({ activities, setup, onActivities, onSetup, otherMethods = [], onOtherMethods, disabled = false, studyPrototype = null }: {
  activities: readonly StudyActivity[];
  setup: StudySetup;
  onActivities: (next: StudyActivity[]) => void;
  onSetup: (next: StudySetup) => void;
  /** Methods run outside Research Studio. Shown, and offered in the picker, when onOtherMethods is given. */
  otherMethods?: readonly OtherMethod[];
  onOtherMethods?: (next: OtherMethod[]) => void;
  disabled?: boolean;
  /** The existing prototype chosen for the study; prototype activities without a link use it. */
  studyPrototype?: { title: string; url: string } | null;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [choosing, setChoosing] = useState(false);
  const [openAnalysis, setOpenAnalysis] = useState<string | null>(null);
  const [controlNotice, setControlNotice] = useState<{ key: string; text: string } | null>(null);
  // Details entered for a method an activity was switched away from, so switching back restores them.
  // Cleared when the activity is removed: keys can be reused by the next activity added.
  const setAside = useRef<Record<string, Partial<Record<StudyMethod, StudyActivity>>>>({});
  const changeMethod = (activity: StudyActivity, method: StudyMethod) => {
    const result = switchActivityMethod(activity, method, setAside.current[activity.key]);
    setAside.current[activity.key] = result.setAside;
    update(activity.key, () => result.activity);
  };
  const loss = usableLoss(setup.lossAllowance);
  const summary = useMemo(() => summarizeActivities(activities, setup.lossAllowance), [activities, setup.lossAllowance]);
  const update = (key: string, change: (activity: StudyActivity) => StudyActivity) =>
    onActivities(activities.map(activity => activity.key === key ? change(activity) : activity));
  // Keys only need to be unique within the plan.
  const usedKeys = () => [...activities.map(activity => activity.key), ...otherMethods.map(method => method.key)];
  const add = (method: StudyMethod) => {
    onActivities([...activities, templateActivity(method, nextPlanKey("activity", usedKeys()))]);
    setChoosing(false);
  };
  const addOther = (preset: OtherMethodPreset) => {
    onOtherMethods?.([...otherMethods, newOtherMethod(preset, nextPlanKey("other", usedKeys()))]);
    setChoosing(false);
  };
  const updateOther = (key: string, change: Partial<OtherMethod>) =>
    onOtherMethods?.(otherMethods.map(method => method.key === key ? { ...method, ...change } : method));
  const canAddStudio = activities.length < MAX_STUDY_ACTIVITIES;
  const canAddOther = !!onOtherMethods && otherMethods.length < MAX_OTHER_METHODS;

  return <View style={styles.root}>
    <Text accessibilityRole="header" style={styles.heading}>Study activities</Text>
    <Text style={styles.description}>Unmoderated activities that run in Civic Research Studio. Everyone takes every activity. Sample sizes and analysis use Research Studio's own planner. New activities start with template text: replace anything in [brackets] with your own.</Text>

    <Choice label="Data collection" value={setup.collection} disabled={disabled}
      options={STUDY_COLLECTIONS.map(item => ({ value: item.id, label: item.label, description: item.description }))}
      onChange={collection => onSetup({ ...setup, collection })} />
    <Choice label="Devices" value={setup.devices} disabled={disabled} inline
      options={[{ value: "any", label: "Any device" }, { value: "desktop", label: "Laptops and desktops only" }]}
      onChange={devices => onSetup({ ...setup, devices })} />
    <NumberField label="Loss allowance before randomization or start (%)" value={setup.lossAllowance} onChange={lossAllowance => onSetup({ ...setup, lossAllowance })} disabled={disabled}
      help="People you expect to lose before they're randomized or start an activity: screen-outs and technical failures. Recruitment targets allow for it once. People who don't finish after randomization aren't part of it: the analysis counts them as not successful. Enter 0 for none." />

    {activities.map((activity, index) => {
      const item = summary.items[index];
      const goals = GOALS[activity.method];
      const set = (change: Partial<StudyActivity>) => update(activity.key, current => ({ ...current, ...change }));
      return <View key={activity.key} style={styles.card}>
        <View style={styles.cardHeader}>
          <Text accessibilityRole="header" style={styles.cardTitle} numberOfLines={2}>{index + 1}. {activity.title.trim() || "Untitled activity"} · {methodLabel(activity.method)}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove activity ${index + 1}`} disabled={disabled} hitSlop={8}
            onPress={() => { delete setAside.current[activity.key]; onActivities(activities.filter(item => item.key !== activity.key)); }} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
            <AppIcon name="close" size={16} color={colors.muted} />
          </Pressable>
        </View>
        <MethodReference method={activity.method} text={METHOD_PARTICIPANT_VIEW[activity.method]} />
        <Choice label="Method" value={activity.method} disabled={disabled} inline activation="manual"
          options={STUDY_METHODS.map(method => ({ value: method.id, label: method.label }))}
          help="Arrow keys move between methods; Space or Enter chooses one. Switching back to a method restores what you'd entered for it."
          onChange={method => changeMethod(activity, method)} />
        <Field label="Activity title" value={activity.title} onChange={title => set({ title })} placeholder="e.g. Make a one-time payment" disabled={disabled} />
        <Field label="Instructions for participants" required value={activity.instructions} onChange={instructions => set({ instructions })} multiline
          placeholder="What participants see before they start" disabled={disabled} />
        <Field label="What this activity should tell you" value={activity.objective} onChange={objective => set({ objective })} multiline disabled={disabled} />

        {goals ? <Choice label="Goal" value={activity.goal} disabled={disabled}
          options={Object.entries(goals).map(([value, label]) => ({ value: value as StudyGoal, label: label! }))}
          onChange={goal => set({ goal })} /> : null}

        {activity.method === "prototype" ? <>
          <Field label="Prototype link" required={!studyPrototype} value={activity.url} onChange={url => set({ url })} url placeholder={studyPrototype ? "Leave empty to use the study prototype" : "https://…"} disabled={disabled}
            help={studyPrototype ? `Optional. Leave empty to use the study prototype, ${studyPrototype.title}.` : undefined} />
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
          <View style={styles.field}>
            <Text style={styles.label}>Control design</Text>
            <Text style={styles.optionLabel}>Design A{activity.designs[0]?.label.trim() ? ` (${activity.designs[0].label.trim()})` : ""} is the control.</Text>
            {activity.designs.length > 1 ? <Button label={`Make Design B${activity.designs[1].label.trim() ? ` (${activity.designs[1].label.trim()})` : ""} the control`} kind="link" compact disabled={disabled}
              accessibilityHint="Swaps the two designs, so the new control becomes Design A"
              onPress={() => {
                const chosen = activity.designs[1];
                update(activity.key, current => chooseControl(current, 1));
                setControlNotice({ key: activity.key, text: `${chosen?.label.trim() || "That design"} is now Design A, the control. The other design is now Design B.` });
              }} style={styles.addButton} /> : null}
          </View>
          <Text style={styles.help}>The control is always Design A, here and in Research Studio. Making the other design the control swaps their letters.</Text>
          <Text accessibilityLiveRegion="polite" style={controlNotice?.key === activity.key ? styles.help : styles.screenReaderOnly}>{controlNotice?.key === activity.key ? controlNotice.text : ""}</Text>
          <Choice label="Primary outcome (choose one before fielding)" value={activity.primary} disabled={disabled}
            options={[
              { value: "success", label: "Task success", description: "Measured by the prototype's success signal." },
              { value: "self", label: "Self-reported completion", description: "Participants say whether they finished." },
            ] as { value: StudyActivity["primary"]; label: string; description: string }[]}
            onChange={primary => set({ primary })} />
          <Field label="Success signal" required={activity.primary === "success"} value={activity.successSignal} onChange={successSignal => set({ successSignal })} disabled={disabled}
            help={activity.primary === "success" ? "Needed to measure task success." : "Optional. Recorded as a secondary measure."} />
          <Choice label="Planning direction: compared with the control, the alternative will have…" value={activity.direction} disabled={disabled} inline
            options={directionOptions(activity.primary) as { value: HypothesisDirection; label: string }[]}
            onChange={direction => set({ direction })} />
          <Text style={styles.help}>The test is two-sided whichever you choose. The direction sets which change the sample size is planned to detect.</Text>
          <Row>
            <NumberField label="Expected control rate (%)" value={activity.baseline} onChange={baseline => set({ baseline })} disabled={disabled} />
            <NumberField label="Difference to detect (points)" value={activity.difference} onChange={difference => set({ difference })} disabled={disabled} />
          </Row>
          <PowerChoice value={activity.power} onChange={power => set({ power })} disabled={disabled} />
          <Field label="Stopping rule" required value={activity.stoppingRule} onChange={stoppingRule => set({ stoppingRule, stoppingRuleConfirmed: false })} multiline disabled={disabled}
            help="Decide this before fielding: when data collection stops and when the results are analysed. Nothing is filled in for you." />
          {activity.stoppingRule.trim() !== STOP_DEFAULT ? <Button label="Use the standard rule" kind="link" compact disabled={disabled}
            accessibilityHint="Fills in: analyse once, after every design reaches its target, with no early stopping. You still need to confirm it."
            onPress={() => set({ stoppingRule: STOP_DEFAULT, stoppingRuleConfirmed: false })} style={styles.addButton} /> : null}
          <Pressable accessibilityRole="checkbox" role="checkbox" aria-checked={activity.stoppingRuleConfirmed} aria-disabled={disabled || !activity.stoppingRule.trim() || undefined}
            accessibilityState={{ checked: activity.stoppingRuleConfirmed, disabled: disabled || !activity.stoppingRule.trim() }}
            accessibilityLabel="I've reviewed this stopping rule and it's decided before fielding" disabled={disabled || !activity.stoppingRule.trim()}
            {...checkboxKeys(() => set({ stoppingRuleConfirmed: !activity.stoppingRuleConfirmed }), disabled || !activity.stoppingRule.trim())}
            onPress={() => set({ stoppingRuleConfirmed: !activity.stoppingRuleConfirmed })} style={({ pressed }) => [styles.check, pressed && styles.pressed]}>
            <View style={[styles.checkbox, activity.stoppingRuleConfirmed && styles.checkboxChecked]}>
              {activity.stoppingRuleConfirmed ? <AppIcon name="check" size={14} color={colors.onPrimary} /> : null}
            </View>
            <Text style={[styles.optionLabel, !activity.stoppingRule.trim() && styles.muted]}>I've reviewed this stopping rule and it's decided before fielding</Text>
          </Pressable>
        </> : null}

        {activity.method === "card_sort" ? <>
          <Choice label="Sort type" value={activity.sortMode} disabled={disabled} inline activation="manual"
            help="Arrow keys move between sort types; Space or Enter chooses one. The sort type sets the goal and the sample size."
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

        {activity.method === "preference" ? activity.designs.length === POWERED_PREFERENCE_OPTIONS ? <>
          <NumberField label="Smallest split worth finding (% choosing one option)" value={activity.split} onChange={split => set({ split })} disabled={disabled} />
          <PowerChoice value={activity.power} onChange={power => set({ power })} disabled={disabled} />
        </> : <Text style={styles.help}>Exploratory: with three or more options there's no sample-size estimate and no winner is declared. Use exactly two options for a powered comparison.</Text> : null}

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

    {summary.largest && activities.length > 1 ? <Text style={styles.recruit}>Recruit for the largest need: about {summary.largest.n} people ({summary.largest.title}). {loss ? `That already allows for ${loss}% loss.` : "No loss allowance is set."}</Text> : null}
    {loss == null && activities.length ? <Text style={styles.recruit}>{NO_LOSS_ALLOWANCE_TEXT}</Text> : null}

    {onOtherMethods && otherMethods.length ? <View style={styles.otherGroup}>
      <Text accessibilityRole="header" style={styles.subheading}>Other methods</Text>
      <Text style={styles.description}>Run outside Research Studio. They're part of this plan and listed in the working draft's analysis plan, but Research Studio doesn't run them or size their samples.</Text>
      {otherMethods.map((method, index) => <View key={method.key} style={styles.card}>
        <View style={styles.cardHeader}>
          <Text accessibilityRole="header" style={styles.cardTitle} numberOfLines={2}>Other method {index + 1}. {method.name.trim() || "Untitled method"}{method.preset !== "custom" && method.name.trim() !== otherMethodLabel(method.preset) ? ` · ${otherMethodLabel(method.preset)}` : ""}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove other method ${index + 1}`} disabled={disabled} hitSlop={8}
            onPress={() => onOtherMethods(otherMethods.filter(item => item.key !== method.key))} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
            <AppIcon name="close" size={16} color={colors.muted} />
          </Pressable>
        </View>
        <MethodReference method={method.preset} text={OTHER_METHOD_PARTICIPANT_VIEW[method.preset]} />
        <Field label="Method name" required value={method.name} onChange={name => updateOther(method.key, { name })} placeholder="e.g. Diary study" disabled={disabled} />
        <Field label="What happens" required value={method.description} onChange={description => updateOther(method.key, { description })} multiline
          placeholder="What participants and the research team do, and how sessions run" disabled={disabled} />
        <Field label="What this method should tell you" value={method.objective} onChange={objective => updateOther(method.key, { objective })} multiline disabled={disabled} />
        <NumberField label="How many people (optional)" value={method.participants} onChange={participants => updateOther(method.key, { participants })} disabled={disabled}
          help={`Your decision: nothing is calculated for methods run outside Research Studio. Up to ${MAX_OTHER_METHOD_PARTICIPANTS.toLocaleString("en-US")}.`} />
        <Field label="What result would be good enough, and what you would do" value={method.criteria} onChange={criteria => updateOther(method.key, { criteria })} multiline disabled={disabled} />
      </View>)}
    </View> : null}

    {choosing ? <View accessibilityLabel="Choose what to add" style={styles.picker}>
      <Text style={styles.label}>Run in Civic Research Studio</Text>
      {STUDY_METHODS.map(method => <Pressable key={method.id} accessibilityRole="button" accessibilityLabel={`Add ${method.label}`} accessibilityHint={method.description}
        disabled={!canAddStudio} accessibilityState={{ disabled: !canAddStudio }}
        onPress={() => add(method.id)} style={({ pressed }) => [styles.methodOption, pressed && styles.pressed]}>
        <MethodIllustration method={method.id} width={60} />
        <View style={styles.methodCopy}>
          <Text style={[styles.methodLabel, !canAddStudio && styles.muted]}>{method.label}</Text>
          <Text style={styles.help}>{method.description}</Text>
        </View>
        <AppIcon name="plus" size={16} color={canAddStudio ? colors.blueDark : colors.muted} />
      </Pressable>)}
      {!canAddStudio ? <Text style={styles.help}>A plan can have up to {MAX_STUDY_ACTIVITIES} Research Studio activities.</Text> : null}
      {onOtherMethods ? <>
        <Text style={styles.label}>Run outside Research Studio</Text>
        {OTHER_METHOD_PRESETS.map(preset => <Pressable key={preset.id} accessibilityRole="button" accessibilityLabel={`Add ${preset.label}`} accessibilityHint={preset.description}
          disabled={!canAddOther} accessibilityState={{ disabled: !canAddOther }}
          onPress={() => addOther(preset.id)} style={({ pressed }) => [styles.methodOption, pressed && styles.pressed]}>
          <MethodIllustration method={preset.id} width={60} />
          <View style={styles.methodCopy}>
            <Text style={[styles.methodLabel, !canAddOther && styles.muted]}>{preset.label}</Text>
            <Text style={styles.help}>{preset.description}</Text>
          </View>
          <AppIcon name="plus" size={16} color={canAddOther ? colors.blueDark : colors.muted} />
        </Pressable>)}
        {!canAddOther ? <Text style={styles.help}>A plan can have up to {MAX_OTHER_METHODS} other methods.</Text> : null}
      </> : null}
      <Button label="Cancel" kind="link" compact onPress={() => setChoosing(false)} />
    </View> : <Button label={activities.length || otherMethods.length ? "Add another activity" : "Add a study activity"} kind="secondary" compact
      disabled={disabled || (!canAddStudio && !canAddOther)} onPress={() => setChoosing(true)} style={styles.addButton} />}
  </View>;
}

/** The method's illustration and what participants do in it, at the top of its card. */
function MethodReference({ method, text }: { method: Parameters<typeof MethodIllustration>[0]["method"]; text: string }) {
  const styles = useStyles();
  return <View style={styles.reference}>
    <MethodIllustration method={method} width={96} />
    <View style={styles.methodCopy}>
      <Text style={styles.label}>What participants do</Text>
      <Text style={styles.help}>{text}</Text>
    </View>
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
    <Text style={styles.help}>{ab ? "Exactly two designs: a live prototype link for each. Choose the control below." : "An image link for each option. Presentation order is randomised. Two options support a powered comparison; three or more are exploratory."}</Text>
    {activity.designs.map((design, index) => {
      const letter = String.fromCharCode(65 + index);
      const control = ab && activity.controlIndex === index;
      return <View key={index} style={styles.designRow}>
        <View style={styles.designTop}>
          <Text style={styles.designLetter}>{noun} {letter}</Text>
          {control ? <Text style={styles.help}>Control</Text> : null}
          {(ab ? activity.designs.length > AB_DESIGNS : activity.designs.length > 2) ? <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${noun.toLowerCase()} ${letter}`} disabled={disabled} hitSlop={8}
            onPress={() => remove(index)} style={styles.iconButton}><AppIcon name="close" size={14} color={colors.muted} /></Pressable> : null}
        </View>
        <TextInput accessibilityLabel={`${noun} ${letter} name`} value={design.label} editable={!disabled} onChangeText={label => setDesign(index, { label })}
          placeholder="Name" placeholderTextColor={colors.muted} style={styles.input} />
        <TextInput accessibilityLabel={`${noun} ${letter} ${ab ? "prototype" : "image"} link`} value={design.url} editable={!disabled} onChangeText={url => setDesign(index, { url })}
          placeholder="https://…" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.input} />
      </View>;
    })}
    {!ab && activity.designs.length < MAX_DESIGNS ? <Button label={`Add ${noun.toLowerCase()}`} kind="link" compact disabled={disabled}
      onPress={() => onChange({ designs: [...activity.designs, { label: "", url: "" }] })} /> : null}
  </View>;
}

function Choice<T extends string>({ label, value, options, onChange, disabled, inline = false, activation = "auto", help }: {
  label: string; value: T; options: { value: T; label: string; description?: string }[]; onChange: (value: T) => void; disabled: boolean; inline?: boolean;
  /** "manual" when choosing has side effects: keys move focus, Space or Enter chooses. */
  activation?: "auto" | "manual";
  help?: string;
}) {
  const styles = useStyles();
  const radios = useRadioGroup({ values: options.map(option => option.value), value, onChange, label, disabled, activation });
  const helpId = `choice-help-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <View {...radios.group} {...(help ? { "aria-describedby": helpId } : {})} style={inline ? styles.chips : styles.options}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return inline
          ? <Pressable key={option.value} {...radios.radio(option.value, index)} accessibilityLabel={option.label}
            style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}>
            <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{option.label}</Text>
          </Pressable>
          : <Pressable key={option.value} {...radios.radio(option.value, index)} accessibilityLabel={option.description ? `${option.label}. ${option.description}` : option.label}
            style={({ pressed }) => [styles.option, selected && styles.optionSelected, pressed && styles.pressed]}>
            <View style={[styles.radio, selected && styles.radioSelected]}>{selected ? <View style={styles.radioDot} /> : null}</View>
            <View style={styles.methodCopy}>
              <Text style={styles.optionLabel}>{option.label}</Text>
              {option.description ? <Text style={styles.help}>{option.description}</Text> : null}
            </View>
          </Pressable>;
      })}
    </View>
    {help ? <Text nativeID={helpId} style={styles.help}>{help}</Text> : null}
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

function NumberField({ label, value, onChange, disabled, help }: { label: string; value: number | null; onChange: (value: number | null) => void; disabled: boolean; help?: string }) {
  const styles = useStyles();
  return <View style={[styles.field, styles.numberField]}>
    <Text style={styles.label}>{label}</Text>
    {help ? <Text style={styles.help}>{help}</Text> : null}
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
  subheading: { ...typography.bodyStrong, color: colors.ink },
  otherGroup: { gap: space.sm, marginTop: space.sm },
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
  reference: { flexDirection: "row", alignItems: "center", gap: space.sm },
  methodOption: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
  methodCopy: { flex: 1, minWidth: 0 },
  methodLabel: { ...typography.caption, color: colors.ink, fontWeight: "700" },
  addButton: { alignSelf: "flex-start" },
  check: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm },
  checkbox: { width: 22, height: 22, borderRadius: radius.sm, borderWidth: 2, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  checkboxChecked: { borderColor: colors.blue, backgroundColor: colors.blue },
  muted: { color: colors.muted },
  screenReaderOnly: { position: "absolute", width: 1, height: 1, overflow: "hidden" },
  pressed: { opacity: 0.75 },
}));
