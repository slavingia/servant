import { useMemo, useReducer, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack } from "expo-router";
import { AppIcon, type AppIconName } from "../components/AppIcon";
import { PageTitle } from "../components/Band";
import { Button } from "../components/Button";
import { ResearchCollaborators } from "../components/ResearchCollaborators";
import {
  buildResearchPreviewPrompt,
  createResearchPreviewState,
  RESEARCH_PREVIEW_DIRECTIONS,
  RESEARCH_PREVIEW_EVIDENCE,
  RESEARCH_PREVIEW_ME,
  RESEARCH_PREVIEW_PEOPLE,
  RESEARCH_PREVIEW_STUDY,
  RESEARCH_PREVIEW_TASKS,
  researchPreviewAllowed,
  researchPreviewReducer,
} from "../lib/research-preview";
import { researchTask, type ResearchFieldId, type ResearchTaskKind } from "../lib/research-studio";
import { accessLabel, collaborationNotice, collaboratorCandidates, type PlanCollaborator } from "../lib/research-collaborators";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

const taskIcons: Record<ResearchTaskKind, AppIconName> = {
  study: "people",
  synthesis: "search",
  "design-review": "eye",
};

export default function ResearchPreview() {
  const styles = useStyles();
  const { colors } = useTheme();
  const hostname = Platform.OS === "web" && typeof window !== "undefined" ? window.location.hostname : "";
  const allowed = researchPreviewAllowed({ dev: __DEV__, platform: Platform.OS, hostname });
  const task = researchTask("study");
  const [selectedTask, setSelectedTask] = useState<ResearchTaskKind>("study");
  const [title, setTitle] = useState<string>(RESEARCH_PREVIEW_STUDY.title);
  const [answers, setAnswers] = useState<Partial<Record<ResearchFieldId, string>>>({ ...RESEARCH_PREVIEW_STUDY.answers });
  const [purpose, setPurpose] = useState<string>(RESEARCH_PREVIEW_STUDY.purpose);
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>(RESEARCH_PREVIEW_EVIDENCE.map(item => item.id));
  const [preview, dispatch] = useReducer(researchPreviewReducer, undefined, createResearchPreviewState);
  const [showPrompt, setShowPrompt] = useState(false);
  const [collaborators, setCollaborators] = useState<PlanCollaborator[]>([]);
  const [viewingAs, setViewingAs] = useState<string | null>(null);
  const selectedDirection = RESEARCH_PREVIEW_DIRECTIONS.find(direction => direction.id === preview.directionId) ?? null;
  const prompt = useMemo(() => preview.approved ? buildResearchPreviewPrompt({
    title,
    answers,
    purpose,
    guidance: preview.guidance,
    approved: true,
  }) : "", [answers, preview.approved, preview.guidance, purpose, title]);

  if (!allowed) return <View style={styles.root}>
    <Stack.Screen options={{ title: "Research preview" }} />
    <View style={styles.unavailable}>
      <View style={styles.unavailableIcon}><AppIcon name="lock" size={24} color={colors.muted} /></View>
      <Text accessibilityRole="header" style={styles.unavailableTitle}>Local preview only</Text>
      <Text style={styles.unavailableBody}>This sample review surface is available only in the local web development preview.</Text>
    </View>
  </View>;

  const invalidateGuidance = () => {
    if (preview.guidance || preview.approved || preview.handoffOpen || preview.directionId) dispatch({ type: "invalidate-guidance" });
    setShowPrompt(false);
  };
  const updateAnswer = (id: ResearchFieldId, value: string) => {
    setAnswers(current => ({ ...current, [id]: value }));
    invalidateGuidance();
  };
  const toggleEvidence = (id: string) => {
    setSelectedEvidence(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
    invalidateGuidance();
  };
  const reset = () => {
    setSelectedTask("study");
    setTitle(RESEARCH_PREVIEW_STUDY.title);
    setAnswers({ ...RESEARCH_PREVIEW_STUDY.answers });
    setPurpose(RESEARCH_PREVIEW_STUDY.purpose);
    setSelectedEvidence(RESEARCH_PREVIEW_EVIDENCE.map(item => item.id));
    dispatch({ type: "reset" });
    setShowPrompt(false);
    setCollaborators([]);
    setViewingAs(null);
  };
  const viewer = collaborators.find(person => person.id === viewingAs) ?? null;
  const viewerNotice = viewer ? collaborationNotice(viewer.access, "The plan's author") : null;

  return <View style={styles.root}>
    <Stack.Screen options={{ title: "Research Studio preview" }} />
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <View style={styles.previewBanner}>
        <View style={styles.previewBannerIcon}><AppIcon name="eye" size={18} color={colors.blueDark} /></View>
        <View style={styles.previewBannerCopy}>
          <Text style={styles.previewBannerTitle}>Local preview · Sample data only</Text>
          <Text style={styles.previewBannerBody}>The preview controls use sample data only and do not save or send anything to the current workspace.</Text>
        </View>
      </View>

      <PageTitle description="Review role-specific research and prototype interactions before they are committed.">Research Studio preview</PageTitle>

      <Text accessibilityRole="header" style={styles.sectionTitle}>Start new research</Text>
      <View style={styles.taskGrid}>
        {RESEARCH_PREVIEW_TASKS.map(item => {
          const selected = selectedTask === item.kind;
          return <Pressable key={item.kind} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={item.actionLabel}
            onPress={() => setSelectedTask(item.kind)} style={({ pressed }) => [styles.taskCard, selected && styles.taskCardSelected, pressed && styles.pressed]}>
            <View style={styles.taskIcon}><AppIcon name={taskIcons[item.kind]} size={20} color={colors.blueDark} /></View>
            <View style={styles.taskCopy}>
              <Text style={styles.taskTitle}>{item.actionLabel}</Text>
              <Text style={styles.taskDescription}>{item.description}</Text>
            </View>
            <AppIcon name={selected ? "check" : "chevronRight"} size={16} color={selected ? colors.greenDark : colors.muted} />
          </Pressable>;
        })}
      </View>

      {selectedTask !== "study" ? <View style={styles.previewNote}>
        <AppIcon name="sparkles" size={18} color={colors.blueDark} />
        <View style={styles.previewNoteCopy}>
          <Text style={styles.previewNoteTitle}>{RESEARCH_PREVIEW_TASKS.find(item => item.kind === selectedTask)?.actionLabel}</Text>
          <Text style={styles.previewNoteBody}>This review surface focuses on the new research-to-prototype handoff. Select “Build a research study” to walk through it.</Text>
        </View>
      </View> : <>
        <View style={styles.divider} />
        <Text accessibilityRole="header" style={styles.flowTitle}>Build a research study</Text>
        <Text style={styles.flowDescription}>The fields are prefilled with synthetic content so you can focus on the interaction. You can edit anything.</Text>

        <Text accessibilityRole="header" style={styles.sectionTitle}>Name the work</Text>
        <View style={styles.field}>
          <Text style={styles.label}>Working title</Text>
          <TextInput accessibilityLabel="Working title" value={title} onChangeText={value => { setTitle(value); invalidateGuidance(); }} style={styles.input} />
        </View>

        <Text accessibilityRole="header" style={styles.sectionTitle}>Build the brief</Text>
        {task.fields.map(field => <View key={field.id} style={styles.field}>
          <Text style={styles.label}>{field.label}{field.required ? " *" : ""}</Text>
          <TextInput accessibilityLabel={`${field.label}${field.required ? ", required" : ", optional"}`} value={answers[field.id] ?? ""}
            onChangeText={value => updateAnswer(field.id, value)} multiline={field.multiline} textAlignVertical={field.multiline ? "top" : "center"}
            placeholder={field.placeholder} placeholderTextColor={colors.muted} style={[styles.input, field.multiline && styles.multiline]} />
        </View>)}

        <Text accessibilityRole="header" style={styles.sectionTitle}>Prototype for this study</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="Prototype for this study" style={styles.prototypeOptions}>
          {[{ id: "none", label: "No prototype" }, { id: "new", label: "Create a new prototype" }, { id: "existing", label: "Choose an existing prototype" }].map(option => {
            const selected = option.id === "new";
            return <View key={option.id} accessibilityRole="radio" accessibilityState={{ checked: selected, disabled: !selected }} style={[styles.prototypeOption, selected && styles.prototypeOptionSelected, !selected && styles.prototypeOptionDisabled]}>
              <View style={[styles.radio, selected && styles.radioSelected]}>{selected ? <View style={styles.radioDot} /> : null}</View>
              <Text style={styles.prototypeOptionLabel}>{option.label}</Text>
              {selected ? <Text style={styles.selectedChip}>Previewed</Text> : null}
            </View>;
          })}
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Prototype purpose *</Text>
          <TextInput accessibilityLabel="Prototype purpose, required" value={purpose} onChangeText={value => { setPurpose(value); invalidateGuidance(); }}
            multiline textAlignVertical="top" style={[styles.input, styles.multiline]} />
          <Text style={styles.help}>With approved guidance, the Prototype Agent suggests distinct directions first and builds only after the researcher chooses.</Text>
        </View>

        <Text accessibilityRole="header" style={styles.sectionTitle}>Research Hub evidence</Text>
        <Text style={styles.sectionDescription}>Synthetic examples stand in for approved Hub records. Raw records would remain with the restricted Researcher Agent.</Text>
        <View style={styles.evidenceList}>
          {RESEARCH_PREVIEW_EVIDENCE.map(item => {
            const checked = selectedEvidence.includes(item.id);
            return <Pressable key={item.id} accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={() => toggleEvidence(item.id)}
              style={({ pressed }) => [styles.evidenceCard, checked && styles.evidenceCardSelected, pressed && styles.pressed]}>
              <View style={[styles.checkbox, checked && styles.checkboxSelected]}>{checked ? <AppIcon name="check" size={15} color={colors.onPrimary} /> : null}</View>
              <View style={styles.evidenceCopy}>
                <Text style={styles.evidenceKind}>{item.kind} · Preview evidence</Text>
                <Text style={styles.evidenceTitle}>{item.title}</Text>
                <Text style={styles.evidenceSummary}>{item.summary}</Text>
              </View>
            </Pressable>;
          })}
        </View>

        <View style={styles.guidanceCard}>
          <View style={styles.cardHeading}>
            <View style={styles.cardHeadingIcon}><AppIcon name="sparkles" size={18} color={colors.blueDark} /></View>
            <View style={styles.cardHeadingCopy}>
              <Text accessibilityRole="header" style={styles.cardTitle}>Research-informed design guidance</Text>
              <Text style={styles.cardDescription}>Prepare generalized needs and pain points, review the text, then explicitly approve what the Prototype Agent may use.</Text>
            </View>
          </View>
          {!preview.guidance ? <Button label="Prepare needs & pain points" kind="secondary" disabled={!selectedEvidence.length}
            onPress={() => dispatch({ type: "prepare-guidance" })} /> : <>
            <TextInput accessibilityLabel="Research-informed design guidance" value={preview.guidance}
              onChangeText={value => dispatch({ type: "edit-guidance", value })} multiline textAlignVertical="top" style={[styles.input, styles.guidanceInput]} />
            <Text style={styles.guidanceWarning}>Review this generalized handoff before sharing it. It is design context, not proof that a direction is validated.</Text>
            {preview.approved ? <View style={styles.approvedRow}>
              <AppIcon name="check" size={17} color={colors.greenDark} />
              <Text style={styles.approvedText}>Approved for this prototype preview</Text>
            </View> : <Button label="Use in prototype" kind="secondary" disabled={!preview.guidance.trim()}
              onPress={() => dispatch({ type: "approve-guidance" })} />}
            <Button label="Regenerate sample guidance" kind="link" compact onPress={() => dispatch({ type: "prepare-guidance" })} />
          </>}
        </View>

        <View style={styles.boundaryCard}>
          <Text style={styles.boundaryTitle}>What happens next</Text>
          <Text style={styles.boundaryBody}>Only the reviewed generalized guidance enters the prototype handoff. The Prototype Agent proposes directions tied to need and pain-point IDs, explains tradeoffs and evidence limits, and waits for a choice before building.</Text>
        </View>

        <Button label="Preview prototype handoff" disabled={!preview.approved} onPress={() => {
          dispatch({ type: "open-handoff" });
          setShowPrompt(false);
        }} style={styles.primaryAction} />

        {preview.handoffOpen ? <View style={styles.agentPanel}>
          <View style={styles.agentHeader}>
            <View style={styles.agentIcon}><AppIcon name="code" size={20} color={colors.blueDark} /></View>
            <View style={styles.agentHeaderCopy}>
              <Text accessibilityRole="header" style={styles.agentTitle}>Prototype Agent response preview</Text>
              <Text style={styles.agentMeta}>Choose a direction before anything is built</Text>
            </View>
          </View>
          <Text style={styles.agentIntro}>Here are three minimum-testable directions based on the approved guidance. Each is a hypothesis, not a validated solution.</Text>
          <View accessibilityRole="radiogroup" accessibilityLabel="Prototype directions" style={styles.directionList}>
            {RESEARCH_PREVIEW_DIRECTIONS.map(direction => {
              const selected = preview.directionId === direction.id;
              return <Pressable key={direction.id} accessibilityRole="radio" accessibilityState={{ checked: selected }}
                onPress={() => dispatch({ type: "choose-direction", id: direction.id })}
                style={({ pressed }) => [styles.directionCard, selected && styles.directionCardSelected, pressed && styles.pressed]}>
                <View style={styles.directionTopline}>
                  <Text style={styles.directionTitle}>{direction.title}</Text>
                  {direction.recommended ? <Text style={styles.recommendedChip}>Recommended</Text> : null}
                </View>
                <Text style={styles.directionAddresses}>Addresses {direction.addresses.join(" · ")}</Text>
                <Text style={styles.directionSummary}>{direction.summary}</Text>
                <Text style={styles.directionDetail}><Text style={styles.directionLabel}>Tradeoff: </Text>{direction.tradeoff}</Text>
                <Text style={styles.directionDetail}><Text style={styles.directionLabel}>Accessibility: </Text>{direction.accessibility}</Text>
              </Pressable>;
            })}
          </View>
          {selectedDirection ? <View style={styles.selectionResult}>
            <AppIcon name="check" size={18} color={colors.greenDark} />
            <View style={styles.selectionCopy}>
              <Text style={styles.selectionTitle}>{selectedDirection.title} selected</Text>
              <Text style={styles.selectionBody}>In the live workflow, the Prototype Agent would now build this direction and return a preview link.</Text>
            </View>
          </View> : null}
          <Button label={showPrompt ? "Hide exact handoff" : "View exact handoff"} kind="secondary" onPress={() => setShowPrompt(value => !value)} />
          {showPrompt ? <View style={styles.promptPanel}>
            <Text style={styles.promptTitle}>Exact prototype prompt</Text>
            <Text selectable style={styles.promptText}>{prompt}</Text>
          </View> : null}
        </View> : null}

      </>}

      <View style={styles.divider} />
      <Text accessibilityRole="header" style={styles.flowTitle}>Collaborate on the research plan</Text>
      <Text style={styles.flowDescription}>In the live app this sits in a study plan's chat options. Only teammates with Researcher access can be added. Sample people only; nothing is saved or sent.</Text>
      <View style={styles.collaboratorCard}>
        <ResearchCollaborators collaborators={collaborators} saving={false} error={null}
          candidates={collaboratorCandidates(RESEARCH_PREVIEW_PEOPLE, { me: RESEARCH_PREVIEW_ME, current: collaborators })}
          onChange={next => {
            setCollaborators(next.map(person => ({ ...person, active: true })));
            if (viewingAs && !next.some(person => person.id === viewingAs)) setViewingAs(null);
          }} />
      </View>
      {collaborators.length ? <>
        <Text accessibilityRole="header" style={styles.sectionTitle}>What a collaborator sees</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="Preview as collaborator" style={styles.prototypeOptions}>
          {collaborators.map(person => {
            const selected = viewingAs === person.id;
            return <Pressable key={person.id} accessibilityRole="radio" accessibilityState={{ checked: selected }} onPress={() => setViewingAs(selected ? null : person.id)}
              style={({ pressed }) => [styles.prototypeOption, selected && styles.prototypeOptionSelected, pressed && styles.pressed]}>
              <View style={[styles.radio, selected && styles.radioSelected]}>{selected ? <View style={styles.radioDot} /> : null}</View>
              <Text style={styles.prototypeOptionLabel}>{person.name}</Text>
              <Text style={styles.selectedChip}>{accessLabel(person.access)}</Text>
            </Pressable>;
          })}
        </View>
        {viewer && viewerNotice ? <View style={styles.boundaryCard}>
          <Text style={styles.boundaryTitle}>{viewerNotice.title}</Text>
          <Text style={styles.boundaryBody}>{viewerNotice.body}</Text>
          <Text style={styles.help}>{viewer.access === "edit"
            ? "A text-only message box appears under the plan. Files and forwarded messages are not available to collaborators."
            : "No message box. The plan opens read-only."}</Text>
        </View> : null}
      </> : null}

      <Button label="Reset sample preview" kind="link" onPress={reset} />
    </ScrollView>
  </View>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { width: "100%", maxWidth: 820, alignSelf: "center", paddingBottom: space.xxl },
  collaboratorCard: { marginHorizontal: space.side, paddingHorizontal: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background },
  previewBanner: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, marginHorizontal: space.side, marginTop: space.md, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.blue, backgroundColor: colors.blueSoft },
  previewBannerIcon: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: colors.background },
  previewBannerCopy: { flex: 1, minWidth: 0 },
  previewBannerTitle: { ...typography.bodyStrong, color: colors.ink },
  previewBannerBody: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  sectionTitle: { ...typography.heading, color: colors.ink, marginHorizontal: space.side, marginTop: space.lg, marginBottom: space.sm },
  sectionDescription: { ...typography.caption, color: colors.muted, marginHorizontal: space.side, marginTop: -space.xs, marginBottom: space.sm },
  taskGrid: { gap: space.sm, paddingHorizontal: space.side },
  taskCard: { minHeight: 88, flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background },
  taskCardSelected: { borderColor: colors.blue, backgroundColor: colors.blueSoft },
  taskIcon: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.blueSoft },
  taskCopy: { flex: 1, minWidth: 0 },
  taskTitle: { ...typography.bodyStrong, color: colors.ink },
  taskDescription: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  pressed: { opacity: 0.78 },
  previewNote: { flexDirection: "row", gap: space.sm, margin: space.side, padding: space.md, borderRadius: radius.lg, backgroundColor: colors.surface },
  previewNoteCopy: { flex: 1 },
  previewNoteTitle: { ...typography.bodyStrong, color: colors.ink },
  previewNoteBody: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  divider: { height: 1, backgroundColor: colors.line, marginTop: space.xl, marginBottom: space.lg },
  flowTitle: { ...typography.title, color: colors.ink, marginHorizontal: space.side },
  flowDescription: { ...typography.body, color: colors.muted, marginHorizontal: space.side, marginTop: space.xs },
  field: { gap: space.xs, paddingHorizontal: space.side, marginBottom: space.md },
  label: { ...typography.label, color: colors.ink },
  input: { ...controls.input },
  multiline: { ...controls.inputMultiline, minHeight: 96 },
  help: { ...typography.caption, color: colors.muted },
  prototypeOptions: { gap: space.xs, paddingHorizontal: space.side, marginBottom: space.md },
  prototypeOption: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background },
  prototypeOptionSelected: { borderColor: colors.blue, backgroundColor: colors.blueSoft },
  prototypeOptionDisabled: { opacity: 0.48 },
  radio: { width: 20, height: 20, borderRadius: radius.pill, borderWidth: 1.5, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  radioSelected: { borderColor: colors.blue },
  radioDot: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: colors.blue },
  prototypeOptionLabel: { ...typography.bodyStrong, color: colors.ink, flex: 1 },
  selectedChip: { ...typography.meta, color: colors.blueDark, backgroundColor: colors.background, paddingHorizontal: space.xs, paddingVertical: space.xxs, borderRadius: radius.pill },
  evidenceList: { gap: space.sm, paddingHorizontal: space.side },
  evidenceCard: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background },
  evidenceCardSelected: { borderColor: colors.blue, backgroundColor: colors.blueSoft },
  checkbox: { width: 22, height: 22, borderRadius: radius.sm, borderWidth: 1.5, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center", marginTop: 2 },
  checkboxSelected: { borderColor: colors.primary, backgroundColor: colors.primary },
  evidenceCopy: { flex: 1, minWidth: 0 },
  evidenceKind: { ...typography.meta, color: colors.blueDark, textTransform: "uppercase", letterSpacing: 0.4 },
  evidenceTitle: { ...typography.bodyStrong, color: colors.ink, marginTop: space.xxs },
  evidenceSummary: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  guidanceCard: { gap: space.md, marginHorizontal: space.side, marginTop: space.lg, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  cardHeading: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  cardHeadingIcon: { width: 34, height: 34, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", backgroundColor: colors.blueSoft },
  cardHeadingCopy: { flex: 1 },
  cardTitle: { ...typography.heading, color: colors.ink },
  cardDescription: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  guidanceInput: { minHeight: 310, backgroundColor: colors.background },
  guidanceWarning: { ...typography.caption, color: colors.muted },
  approvedRow: { minHeight: 46, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.xs, paddingHorizontal: space.md, borderRadius: radius.sm, backgroundColor: colors.greenSoft },
  approvedText: { ...typography.bodyStrong, color: colors.greenDark },
  boundaryCard: { marginHorizontal: space.side, marginTop: space.lg, padding: space.md, borderLeftWidth: 3, borderLeftColor: colors.blue, backgroundColor: colors.surface },
  boundaryTitle: { ...typography.bodyStrong, color: colors.ink },
  boundaryBody: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  primaryAction: { marginHorizontal: space.side, marginTop: space.lg },
  agentPanel: { gap: space.md, marginHorizontal: space.side, marginTop: space.lg, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.blue, backgroundColor: colors.background },
  agentHeader: { flexDirection: "row", alignItems: "center", gap: space.sm },
  agentIcon: { width: 42, height: 42, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: colors.blueSoft },
  agentHeaderCopy: { flex: 1 },
  agentTitle: { ...typography.heading, color: colors.ink },
  agentMeta: { ...typography.caption, color: colors.blueDark, marginTop: space.xxs },
  agentIntro: { ...typography.body, color: colors.ink },
  directionList: { gap: space.sm },
  directionCard: { gap: space.xs, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  directionCardSelected: { borderColor: colors.blue, backgroundColor: colors.blueSoft },
  directionTopline: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  directionTitle: { ...typography.bodyStrong, color: colors.ink, flex: 1 },
  recommendedChip: { ...typography.meta, color: colors.greenDark, backgroundColor: colors.greenSoft, paddingHorizontal: space.xs, paddingVertical: space.xxs, borderRadius: radius.pill },
  directionAddresses: { ...typography.meta, color: colors.blueDark },
  directionSummary: { ...typography.body, color: colors.ink },
  directionDetail: { ...typography.caption, color: colors.muted },
  directionLabel: { ...typography.captionStrong, color: colors.ink },
  selectionResult: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.greenSoft },
  selectionCopy: { flex: 1 },
  selectionTitle: { ...typography.bodyStrong, color: colors.greenDark },
  selectionBody: { ...typography.caption, color: colors.ink, marginTop: space.xxs },
  promptPanel: { padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface },
  promptTitle: { ...typography.bodyStrong, color: colors.ink, marginBottom: space.sm },
  promptText: { ...typography.meta, color: colors.muted, fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) },
  unavailable: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.lg },
  unavailableIcon: { width: 52, height: 52, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: colors.surface },
  unavailableTitle: { ...typography.heading, color: colors.ink, marginTop: space.md },
  unavailableBody: { ...typography.body, color: colors.muted, textAlign: "center", maxWidth: 420, marginTop: space.xs },
}));
