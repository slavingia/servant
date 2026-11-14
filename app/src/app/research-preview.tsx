import { useMemo, useReducer, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack } from "expo-router";
import { AppIcon, type AppIconName } from "../components/AppIcon";
import { PageTitle } from "../components/Band";
import { Button } from "../components/Button";
import { ResearchCollaborators } from "../components/ResearchCollaborators";
import { StudyActivities } from "../components/StudyActivities";
import { StudyMethodPicker } from "../components/StudyMethodPicker";
import {
  buildResearchPreviewPrompt,
  createResearchPreviewState,
  RESEARCH_PREVIEW_DIRECTIONS,
  RESEARCH_PREVIEW_EVIDENCE,
  RESEARCH_PREVIEW_ME,
  RESEARCH_PREVIEW_PEOPLE,
  RESEARCH_PREVIEW_PROTOTYPES,
  researchPreviewActivities,
  RESEARCH_PREVIEW_STUDY,
  RESEARCH_PREVIEW_TASKS,
  researchPreviewAllowed,
  researchPreviewReducer,
} from "../lib/research-preview";
import { buildStudyPrototypePrompt, researchFindingsProblems, researchTask, type ResearchFieldId, type ResearchTaskKind } from "../lib/research-studio";
import { accessLabel, collaborationNotice, collaboratorCandidates, planTimesText, type PlanCollaborator } from "../lib/research-collaborators";
import { DEFAULT_STUDY_SETUP, buildResearchStudioWorkingCopy, otherMethodsPrompt, recheckStudyPrototype, researchStudioFileName, studyActivitiesPrompt, studyDraftProblems, type OtherMethod, type StudyActivity, type StudySetup } from "../lib/research-methods";
import { DraftChecklist } from "../components/DraftChecklist";
import { useRadioGroup } from "../components/useRadioGroup";
import { PROTOTYPE_OPTIONS, PrototypeModeOptions } from "../components/PrototypeModeOptions";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

// The preview shows the research pilot build: features on hold are left out.
const PILOT_HOLD = true;
const HELD_FEATURES = [
  "Sending to the Researcher Agent from Research Studio (synthesis, design review and “Review in researcher chat”)",
  "Real Research Hub evidence and research-informed design guidance",
  "Research Hub to Prototype Agent handoffs",
  "Collaborators who can edit or message the Researcher Agent",
];

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
  const [activities, setActivities] = useState<StudyActivity[]>(researchPreviewActivities);
  const [otherMethods, setOtherMethods] = useState<OtherMethod[]>([]);
  const [studySetup, setStudySetup] = useState<StudySetup>(DEFAULT_STUDY_SETUP);
  const [showFile, setShowFile] = useState(false);
  const [showActivityPrompt, setShowActivityPrompt] = useState(false);
  const [viewingAs, setViewingAs] = useState<string | null>(null);
  const [collaboratorLoadedAt, setCollaboratorLoadedAt] = useState<number>(() => Date.now());
  // The sample plan last changed 25 minutes before the preview opened.
  const [samplePlanUpdatedAt] = useState<number>(() => Date.now() - 25 * 60_000);
  // Synthetic Design Studio library: choose an existing prototype for the working draft.
  const [prototypeChoice, setPrototypeChoice] = useState<"none" | "new" | "existing">("existing");
  const [findings, setFindings] = useState<string>(RESEARCH_PREVIEW_STUDY.findings);
  const [showBuildPrompt, setShowBuildPrompt] = useState(false);
  const findingsProblems = researchFindingsProblems(findings);
  const [prototypeId, setPrototypeId] = useState<string | null>(RESEARCH_PREVIEW_PROTOTYPES[0].id);
  const [unreadyIds, setUnreadyIds] = useState<string[]>([]);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
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
    setActivities(researchPreviewActivities());
    setStudySetup(DEFAULT_STUDY_SETUP);
    setShowFile(false);
    setShowActivityPrompt(false);
    setPrototypeChoice("existing");
    setPrototypeId(RESEARCH_PREVIEW_PROTOTYPES[0].id);
    setUnreadyIds([]);
    setFileNotice(null);
  };
  const readyPrototypes = RESEARCH_PREVIEW_PROTOTYPES.filter(item => !unreadyIds.includes(item.id));
  const chosenPrototype = prototypeChoice === "existing" ? RESEARCH_PREVIEW_PROTOTYPES.find(item => item.id === prototypeId) ?? null : null;
  const draftPrototype = prototypeChoice === "existing" ? { mode: "existing" as const, url: chosenPrototype?.previewUrl ?? null } : { mode: "none" as const };
  const fileProblems = studyDraftProblems({ title, decision: answers.decision, question: answers.question, participants: answers.participants, setup: studySetup, activities, otherMethods, prototype: draftPrototype });
  const changed = () => { setShowFile(false); setFileNotice(null); };
  // Same recheck as the live app, against the synthetic library, right before the draft is shown.
  const viewFile = () => {
    if (showFile) { setShowFile(false); return; }
    if (chosenPrototype) {
      const checked = recheckStudyPrototype(chosenPrototype.id, readyPrototypes);
      if (!checked.ok) { setPrototypeId(null); setFileNotice(checked.message); return; }
    }
    setFileNotice(null);
    setShowFile(true);
  };
  const studioFile = showFile && !fileProblems.length
    ? JSON.stringify(buildResearchStudioWorkingCopy({ title, decision: answers.decision, question: answers.question, participants: answers.participants, background: answers.inputs, setup: studySetup, activities, otherMethods, prototypeUrl: chosenPrototype?.previewUrl }), null, 2)
    : "";
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

      {PILOT_HOLD ? <View style={styles.boundaryCard}>
        <Text accessibilityRole="header" style={styles.boundaryTitle}>Research pilot build</Text>
        <Text style={styles.boundaryBody}>On: the local study builder, new prototypes from the researcher's own findings, working drafts for Research Studio, and view-only collaborators. On hold until a workspace owner turns them back on:</Text>
        {HELD_FEATURES.map(item => <Text key={item} style={styles.boundaryBody}>• {item}</Text>)}
      </View> : null}

      <Text accessibilityRole="header" style={styles.sectionTitle}>Start new research</Text>
      <View style={styles.taskGrid}>
        {RESEARCH_PREVIEW_TASKS.map(item => {
          const selected = selectedTask === item.kind;
          const paused = PILOT_HOLD && item.kind !== "study";
          return <Pressable key={item.kind} accessibilityRole="button" accessibilityState={{ selected, disabled: paused }} accessibilityLabel={item.actionLabel}
            accessibilityHint={paused ? "Paused for the research pilot" : undefined} disabled={paused}
            onPress={() => setSelectedTask(item.kind)} style={({ pressed }) => [styles.taskCard, selected && styles.taskCardSelected, paused && styles.prototypeOptionDisabled, pressed && !paused && styles.pressed]}>
            <View style={styles.taskIcon}><AppIcon name={taskIcons[item.kind]} size={20} color={paused ? colors.muted : colors.blueDark} /></View>
            <View style={styles.taskCopy}>
              <Text style={styles.taskTitle}>{item.actionLabel}</Text>
              <Text style={styles.taskDescription}>{paused ? "Paused for the research pilot." : item.description}</Text>
            </View>
            <AppIcon name={paused ? "lock" : selected ? "check" : "chevronRight"} size={16} color={selected ? colors.greenDark : colors.muted} />
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

{PILOT_HOLD ? <>
        <Text accessibilityRole="header" style={styles.sectionTitle}>Prototype for this study</Text>
        <Text style={styles.sectionDescription}>Optional. A chosen prototype is used by prototype activities without their own link, and it's checked again right before the working draft is saved. A new one starts from the study brief and what your research found.</Text>
        <PrototypeModeOptions options={PROTOTYPE_OPTIONS} value={prototypeChoice} disabled={false}
          onChange={choice => { setPrototypeChoice(choice); setShowBuildPrompt(false); changed(); }} />
        {prototypeChoice === "new" ? <View style={styles.field}>
          <Text style={styles.label}>Prototype purpose *</Text>
          <TextInput accessibilityLabel="Prototype purpose, required" value={purpose} onChangeText={value => { setPurpose(value); setShowBuildPrompt(false); }}
            multiline textAlignVertical="top" style={[styles.input, styles.multiline]} />
          <Text style={styles.label}>What the research found (optional)</Text>
          <Text nativeID="preview-findings-help" style={styles.help}>Summarize findings from any research in general terms: what people need, where they struggle, and what's still unknown. Leave out names, quotes, links, record IDs, dates and numbers. Only what you write here goes to the prototype agent; “What you already know” stays with the study plan.</Text>
          <TextInput accessibilityLabel="What the research found, optional" aria-describedby="preview-findings-help" value={findings}
            onChangeText={value => { setFindings(value); setShowBuildPrompt(false); }} multiline textAlignVertical="top" style={[styles.input, styles.guidanceInput]} />
          {findingsProblems.length ? <View accessibilityLiveRegion="polite" style={styles.boundaryCard}>
            <Text style={styles.boundaryTitle}>Before this can go to the prototype agent</Text>
            {findingsProblems.map(problem => <Text key={problem} style={styles.boundaryBody}>{`\u2022 ${problem}`}</Text>)}
          </View> : null}
          <Text style={styles.help}>With findings, the prototype agent suggests a few directions first and builds the one you choose. In the app, Create prototype workspace opens a private prototype-agent chat with this prompt unsent.</Text>
          <Button label={showBuildPrompt ? "Hide the build prompt" : "Show the build prompt"} kind="secondary" disabled={!purpose.trim() || findingsProblems.length > 0}
            onPress={() => setShowBuildPrompt(value => !value)} />
          {showBuildPrompt && !findingsProblems.length ? <View style={styles.promptPanel}>
            <Text style={styles.promptTitle}>Exact prototype prompt (sample, not sent)</Text>
            <Text selectable style={styles.promptText}>{buildStudyPrototypePrompt({ kind: "study", title, answers, prototype: { kind: "new", purpose }, researchFindings: findings })}</Text>
          </View> : null}
        </View> : null}
        {prototypeChoice === "existing" ? <>
          <Text style={styles.sectionDescription}>Sample Design Studio prototypes with a live preview:</Text>
          <SampleRadios label="Existing prototype" value={prototypeId} onChange={id => { setPrototypeId(id); changed(); }}
            options={readyPrototypes.map(item => ({ value: item.id, label: item.title, chip: "Published", accessibilityLabel: `${item.title}, by ${item.author}, published` }))} />
          {chosenPrototype && !unreadyIds.includes(chosenPrototype.id) ? <Button label="Simulate: this prototype stops being ready" kind="link" compact
            accessibilityHint="Sample only. The recheck before saving will then refuse to use it."
            onPress={() => { setUnreadyIds(current => [...current, chosenPrototype.id]); setShowFile(false); }} /> : null}
          {chosenPrototype && unreadyIds.includes(chosenPrototype.id) ? <Text style={styles.sectionDescription}>Sample: {chosenPrototype.title} is no longer ready. It's still selected until the recheck before saving.</Text> : null}
        </> : null}
        <View style={styles.boundaryCard}>
          <Text style={styles.boundaryTitle}>Paused for the research pilot</Text>
          <Text style={styles.boundaryBody}>This plan isn't sent to the Researcher Agent during the pilot, and Research Hub evidence isn't available. Save a working draft below to keep working on it in Civic Research Studio.</Text>
        </View>
        </> : <>
        <Text accessibilityRole="header" style={styles.sectionTitle}>Prototype for this study</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="Prototype for this study" style={styles.prototypeOptions}>
          {[{ id: "none", label: "No prototype" }, { id: "new", label: "Create a new prototype" }, { id: "existing", label: "Choose an existing prototype" }].map(option => {
            const selected = option.id === "new";
            return <View key={option.id} accessibilityRole="radio" role="radio" aria-checked={selected} aria-disabled={!selected || undefined} accessibilityState={{ checked: selected, disabled: !selected }} style={[styles.prototypeOption, selected && styles.prototypeOptionSelected, !selected && styles.prototypeOptionDisabled]}>
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
            return <Pressable key={item.id} accessibilityRole="checkbox" role="checkbox" aria-checked={checked} accessibilityState={{ checked }} onPress={() => toggleEvidence(item.id)}
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
            <View style={styles.agentIcon}><AppIcon name="brush" size={20} color={colors.blueDark} /></View>
            <View style={styles.agentHeaderCopy}>
              <Text accessibilityRole="header" style={styles.agentTitle}>Prototype Agent response preview</Text>
              <Text style={styles.agentMeta}>Choose a direction before anything is built</Text>
            </View>
          </View>
          <Text style={styles.agentIntro}>Here are three minimum-testable directions based on the approved guidance. Each is a hypothesis, not a validated solution.</Text>
          <View accessibilityRole="radiogroup" accessibilityLabel="Prototype directions" style={styles.directionList}>
            {RESEARCH_PREVIEW_DIRECTIONS.map(direction => {
              const selected = preview.directionId === direction.id;
              return <Pressable key={direction.id} accessibilityRole="radio" role="radio" aria-checked={selected} accessibilityState={{ checked: selected }}
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
      </>}

      <View style={styles.divider} />
      <Text accessibilityRole="header" style={styles.flowTitle}>Plan Research Studio activities</Text>
      <Text style={styles.flowDescription}>In the live app this sits in Build a research study. Sample activities use example.com links. The working draft below is shown, not saved.</Text>
      <View style={styles.activitiesCard}>
        <StudyMethodPicker activities={activities} otherMethods={otherMethods}
          onActivities={next => { setActivities(next); changed(); }} onOtherMethods={next => { setOtherMethods(next); changed(); }} />
      </View>
      <View style={styles.activitiesCard}>
        <StudyActivities activities={activities} setup={studySetup} studyPrototype={chosenPrototype ? { title: chosenPrototype.title, url: chosenPrototype.previewUrl } : null}
          onActivities={next => { setActivities(next); changed(); }} onSetup={next => { setStudySetup(next); changed(); }}
          otherMethods={otherMethods} onOtherMethods={next => { setOtherMethods(next); changed(); }} />
      </View>
      <View style={styles.activitiesCard}>
        <DraftChecklist problems={fileProblems} notice={fileNotice} onSave={viewFile}
          saveLabel={showFile ? "Hide working draft" : `View working draft (${researchStudioFileName(title)})`} />
      </View>
      {studioFile ? <View style={[styles.promptPanel, styles.activitiesCard]}>
        <Text style={styles.promptTitle}>Exact working draft for Import JSON (a draft to refine, not a finished plan)</Text>
        <Text selectable style={styles.promptText}>{studioFile}</Text>
      </View> : null}
      {!PILOT_HOLD ? <Button label={showActivityPrompt ? "Hide the Researcher agent's activity section" : "View the Researcher agent's activity section"} kind="link" onPress={() => setShowActivityPrompt(value => !value)} /> : null}
      {!PILOT_HOLD && showActivityPrompt ? <View style={[styles.promptPanel, styles.activitiesCard]}>
        <Text style={styles.promptTitle}>Added to the unsent study draft</Text>
        <Text selectable style={styles.promptText}>{[...studyActivitiesPrompt(studySetup, activities), ...otherMethodsPrompt(otherMethods)].join("\n").trim()}</Text>
      </View> : null}

      <View style={styles.divider} />
      <Text accessibilityRole="header" style={styles.flowTitle}>Collaborate on the research plan</Text>
      <Text style={styles.flowDescription}>In the live app this sits in a study plan's chat options. Only teammates with Researcher access can be added, and they can view only. Sample people only; nothing is saved or sent.</Text>
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
        <SampleRadios label="Preview as collaborator" value={viewingAs} onChange={setViewingAs}
          options={collaborators.map(person => ({ value: person.id, label: person.name, chip: accessLabel(person.access) }))} />
        {viewingAs ? <Button label="Stop previewing as a collaborator" kind="link" compact onPress={() => setViewingAs(null)} /> : null}
        {viewer && viewerNotice ? <View style={styles.boundaryCard}>
          <Text style={styles.boundaryTitle}>{viewerNotice.title}</Text>
          <Text style={styles.boundaryBody}>{viewerNotice.body}</Text>
          <View style={styles.refreshRow}>
            <Text accessibilityLiveRegion="polite" style={[styles.help, styles.flexText]}>{planTimesText({ updatedAt: samplePlanUpdatedAt, checkedAt: collaboratorLoadedAt })}</Text>
            <Button compact kind="secondary" label="Refresh" accessibilityHint="Loads the latest version and checks your access again" onPress={() => setCollaboratorLoadedAt(Date.now())} />
          </View>
          <Text style={styles.help}>No message box. The plan opens read-only. Refresh loads the latest version and checks access again; if access ended, the plan closes.</Text>
        </View> : null}
      </> : null}

      <Button label="Reset sample preview" kind="link" onPress={reset} />
    </ScrollView>
  </View>;
}

/** A sample radio group: the same keyboard and ARIA behaviour as the live app (useRadioGroup). */
function SampleRadios<T extends string>({ label, options, value, onChange }: {
  label: string;
  options: { value: T; label: string; chip?: string; accessibilityLabel?: string }[];
  value: T | null;
  onChange: (value: T) => void;
}) {
  const styles = useStyles();
  const radios = useRadioGroup({ values: options.map(option => option.value), value, onChange, label });
  return <View {...radios.group} style={styles.prototypeOptions}>
    {options.map((option, index) => {
      const selected = option.value === value;
      return <Pressable key={option.value} {...radios.radio(option.value, index)} accessibilityLabel={option.accessibilityLabel ?? option.label}
        style={({ pressed }) => [styles.prototypeOption, selected && styles.prototypeOptionSelected, pressed && styles.pressed]}>
        <View style={[styles.radio, selected && styles.radioSelected]}>{selected ? <View style={styles.radioDot} /> : null}</View>
        <Text style={styles.prototypeOptionLabel}>{option.label}</Text>
        {option.chip ? <Text style={styles.selectedChip}>{option.chip}</Text> : null}
      </Pressable>;
    })}
  </View>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { width: "100%", maxWidth: 820, alignSelf: "center", paddingBottom: space.xxl },
  activitiesCard: { marginHorizontal: space.side, marginTop: space.md },
  flexText: { flex: 1, minWidth: 0 },
  refreshRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
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
