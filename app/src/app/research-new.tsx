import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppIcon } from "../components/AppIcon";
import { PageTitle } from "../components/Band";
import { Button } from "../components/Button";
import {
  buildResearchPrompt,
  isResearchTaskKind,
  MAX_RESEARCH_HUB_EVIDENCE,
  missingResearchFields,
  researchChatTitle,
  researchTask,
  type ResearchBrief,
  type ResearchFieldId,
} from "../lib/research-studio";
import { api, ServerError, type ResearchHubAvailableMetadata, type ResearchHubEvidence, type ResearchHubMetadata } from "../lib/server";
import { setDraft } from "../lib/drafts";
import { useSession } from "../lib/session";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

type ResearchHubFailureState = { kind: "unavailable" | "forbidden" | "error"; message: string };
type ResearchHubState =
  | { kind: "checking" }
  | { kind: "available"; hub: ResearchHubAvailableMetadata }
  | ResearchHubFailureState;

function researchHubFailure(error: unknown): ResearchHubFailureState {
  if (error instanceof ServerError && error.status === 403) return {
    kind: "forbidden",
    message: "Research Hub access isn't available for this account. You can continue without attaching Hub evidence.",
  };
  if (error instanceof ServerError && error.status === 404) return {
    kind: "unavailable",
    message: "Research Hub isn't connected to this server yet. You can continue with evidence you describe in the brief.",
  };
  return {
    kind: "error",
    message: error instanceof ServerError ? error.message : "Research Hub availability couldn't be checked.",
  };
}

function shortHubDate(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : value;
}

function shortEvidenceDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function evidenceKind(kind: ResearchHubEvidence["kind"]): string {
  return kind === "theme" ? "Theme" : kind === "feature" ? "Feature" : kind === "bug" ? "Issue" : "Rating";
}

export default function NewResearchWork() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { kind: rawKind } = useLocalSearchParams<{ kind?: string | string[] }>();
  const requestedKind = Array.isArray(rawKind) ? rawKind[0] : rawKind;
  const kind = isResearchTaskKind(requestedKind) ? requestedKind : "study";
  const task = researchTask(kind);
  const { account } = useSession();
  const [title, setTitle] = useState("");
  const [answers, setAnswers] = useState<Partial<Record<ResearchFieldId, string>>>({});
  const [agentTier, setAgentTier] = useState<number | null | undefined>(undefined);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hubState, setHubState] = useState<ResearchHubState>({ kind: "checking" });
  const [hubAttempt, setHubAttempt] = useState(0);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidence, setEvidence] = useState<ResearchHubEvidence[]>([]);
  const hubRevision = useRef<string | null>(null);

  const acceptHubMetadata = useCallback((hub: ResearchHubMetadata) => {
    if (hub.available) {
      if (hubRevision.current && hubRevision.current !== hub.revision) setEvidence([]);
      hubRevision.current = hub.revision;
    }
    setHubState(hub.available
      ? { kind: "available", hub }
      : { kind: "unavailable", message: hub.message || "Research Hub isn't available on this server yet. You can continue without attaching Hub evidence." });
  }, []);

  useEffect(() => {
    if (!account) return;
    let active = true;
    setAgentTier(undefined);
    setAccessError(null);
    api.projects(account).then(result => {
      if (!active) return;
      const tier = result.agentTier;
      if (typeof tier === "number" && Number.isInteger(tier)) setAgentTier(tier);
      else {
        setAgentTier(null);
        setAccessError("This workspace did not report Researcher access.");
      }
    }).catch(() => {
      if (!active) return;
      setAgentTier(null);
      setAccessError("Researcher access could not be verified. Return to Research Studio and try again.");
    });
    return () => { active = false; };
  }, [account?.serverUrl, account?.serverKey, account?.user.id]);

  useEffect(() => {
    if (!account || agentTier !== 4) return;
    let active = true;
    const controller = new AbortController();
    setHubState({ kind: "checking" });
    api.researchHubStatus(account, controller.signal).then(hub => {
      if (active) acceptHubMetadata(hub);
    }).catch(e => {
      if (active) setHubState(researchHubFailure(e));
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [account?.serverUrl, account?.serverKey, account?.user.id, acceptHubMetadata, agentTier, hubAttempt]);

  if (!account) return null;
  const update = (field: ResearchFieldId, value: string) => setAnswers(current => ({ ...current, [field]: value }));
  const brief = (records: readonly ResearchHubEvidence[] = evidence, hub?: ResearchHubMetadata): ResearchBrief => ({
    kind,
    title,
    answers,
    evidence: records,
    evidenceHub: hub ?? (hubState.kind === "available" ? hubState.hub : undefined),
  });

  const create = async () => {
    if (busy || agentTier !== 4) return;
    const current = brief();
    const missing = missingResearchFields(current);
    if (missing.length) {
      setError(`Complete ${missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`}.`);
      return;
    }
    setBusy(true);
    setError(null);
    const expectedTitle = researchChatTitle(kind, title);
    try {
      let resolvedBrief = current;
      if (evidence.length) {
        if (hubState.kind !== "available") {
          setError("Research Hub evidence can't be verified right now. Try the Hub check again or continue without the selection.");
          return;
        }
        let resolved;
        try {
          resolved = await api.resolveResearchHubEvidence(account, evidence.map(item => item.id), hubState.hub.revision);
        } catch (e) {
          if (e instanceof ServerError && (e.status === 403 || e.status === 404)) setHubState(researchHubFailure(e));
          setError(e instanceof ServerError && (e.status === 403 || e.status === 404)
            ? "Some selected Research Hub evidence is no longer available to you. Review the selection or continue without it."
            : e instanceof ServerError ? e.message : "Selected Research Hub evidence couldn't be verified. Try again.");
          return;
        }
        if (!resolved.hub.available) {
          acceptHubMetadata(resolved.hub);
          setError(resolved.hub.message || "Research Hub evidence isn't available right now.");
          return;
        }
        const byId = new Map(resolved.evidence.map(item => [item.id, item]));
        const ordered = evidence.map(item => byId.get(item.id)).filter((item): item is ResearchHubEvidence => !!item);
        if (ordered.length !== evidence.length) {
          setError("Some selected Research Hub evidence is no longer available. Review the selection or continue without it.");
          return;
        }
        acceptHubMetadata(resolved.hub);
        resolvedBrief = brief(ordered, resolved.hub);
      }
      const chat = await api.newChat(account, { title: expectedTitle, requiredAgentRole: "researcher" });
      // The server checks the role atomically. The response marker also keeps a
      // server that predates that check from silently accepting the wrong lane.
      if (chat.agentRole !== "researcher") {
        await api.deleteChat(account, chat.id).catch(() => {});
        setError(chat.mode === "vibe"
          ? "This workspace created a design workspace instead of a researcher chat. Ask a workspace owner to confirm your Researcher access."
          : "This workspace couldn't verify a researcher chat. Ask a workspace owner to update or confirm Researcher access.");
        return;
      }
      setDraft(`chat:${chat.id}`, buildResearchPrompt(resolvedBrief));
      router.replace({ pathname: "/chat/[id]", params: { id: chat.id, title: expectedTitle, compose: "1", research: "1" } });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't start this research chat. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (agentTier === undefined) return <View style={styles.loading}>
    <Stack.Screen options={{ title: task.actionLabel }} />
    <ActivityIndicator accessibilityLabel="Checking Researcher access" accessibilityRole="progressbar" color={colors.blue} />
    <Text style={styles.loadingText}>Checking Researcher access…</Text>
  </View>;

  if (agentTier !== 4) return <View style={styles.root}>
    <Stack.Screen options={{ title: task.actionLabel }} />
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <PageTitle description={task.description}>{task.actionLabel}</PageTitle>
      <View style={styles.locked}>
        <View style={styles.lockedIcon}><AppIcon name="lock" size={22} color={colors.muted} /></View>
        <Text accessibilityRole="header" style={styles.lockedTitle}>Researcher access is required</Text>
        <Text style={styles.lockedBody}>{accessError ?? "Ask a workspace owner to grant the Researcher agent tier. Choosing a research goal during onboarding does not change workspace permissions."}</Text>
        <Button label="Back to Research Studio" kind="secondary" onPress={() => router.replace("/research")} style={styles.lockedAction} />
      </View>
    </ScrollView>
  </View>;

  return <View style={styles.root}>
    <Stack.Screen options={{ title: task.actionLabel }} />
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <PageTitle description={task.description}>{task.actionLabel}</PageTitle>
      <View style={styles.note}>
        <AppIcon name="sparkles" size={17} color={colors.blueDark} />
        <Text style={styles.noteText}>Your answers and selected evidence become an unsent draft in a private researcher chat. Review or edit the prompt before you send it.</Text>
      </View>

      <Text accessibilityRole="header" style={styles.sectionTitle}>Name the work</Text>
      <View style={styles.field}>
        <Text style={styles.label}>Working title</Text>
        <TextInput value={title} onChangeText={setTitle} accessibilityLabel="Working title" placeholder="A short, recognizable name" placeholderTextColor={colors.muted}
          maxLength={Math.max(20, 80 - task.titlePrefix.length)} autoCapitalize="sentences" autoCorrect style={styles.input} />
      </View>

      <Text accessibilityRole="header" style={styles.sectionTitle}>Build the brief</Text>
      <Text style={styles.sectionDescription}>Required fields are marked. Add only what is safe to share with your workspace's researcher agent.</Text>
      {task.fields.map(field => {
        const suppliedByHub = kind === "synthesis" && field.id === "inputs" && evidence.length > 0;
        const required = !!field.required && !suppliedByHub;
        return <View key={field.id} style={styles.field}>
          <Text style={styles.label}>{field.label}{required ? " *" : ""}</Text>
          <TextInput value={answers[field.id] ?? ""} onChangeText={value => update(field.id, value)} accessibilityLabel={`${field.label}${required ? ", required" : ", optional"}`}
            placeholder={suppliedByHub ? "Optional — describe evidence outside Research Hub" : field.placeholder} placeholderTextColor={colors.muted} multiline={field.multiline} textAlignVertical={field.multiline ? "top" : "center"}
            autoCapitalize="sentences" autoCorrect style={[styles.input, field.multiline && styles.multiline]} />
        </View>;
      })}

      <Text accessibilityRole="header" style={styles.sectionTitle}>Research Hub evidence</Text>
      <Text style={styles.sectionDescription}>{kind === "study"
        ? "Optional — add prior evidence to sharpen the study gap and avoid duplicating known work."
        : kind === "synthesis"
          ? "Choose the Hub records to analyze, or describe evidence outside the Hub above."
          : "Recommended — add evidence about the intended audience, needs, or task so each review claim is traceable."}</Text>

      {evidence.length ? <View style={styles.evidenceSelection}>
        <Text accessibilityLiveRegion="polite" style={styles.selectionCount}>{evidence.length} of {MAX_RESEARCH_HUB_EVIDENCE} selected</Text>
        {evidence.map(item => <View key={item.id} style={styles.selectedEvidenceRow}>
          <View style={styles.selectedEvidenceCopy}>
            <Text numberOfLines={2} style={styles.selectedEvidenceTitle}>{item.title}</Text>
            <Text numberOfLines={1} style={styles.selectedEvidenceMeta}>{item.product.name} · {evidenceKind(item.kind)} · {item.catalogReference}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${item.title}`} accessibilityState={{ disabled: busy }} disabled={busy}
            hitSlop={10} onPress={() => { setEvidence(currentEvidence => currentEvidence.filter(selected => selected.id !== item.id)); setError(null); }} style={styles.removeEvidence}>
            <AppIcon name="close" size={16} color={colors.muted} />
          </Pressable>
        </View>)}
        {evidence.length > 1 ? <Button label="Remove all evidence" kind="link" compact disabled={busy} onPress={() => { setEvidence([]); setError(null); }} style={styles.clearEvidence} /> : null}
      </View> : null}

      {hubState.kind === "checking" ? <View style={styles.hubStatus}>
        <ActivityIndicator accessibilityLabel="Checking Research Hub availability" accessibilityRole="progressbar" color={colors.blue} />
        <Text style={styles.hubStatusText}>Checking Research Hub…</Text>
      </View> : hubState.kind === "available" ? <View style={styles.hubAvailable}>
        <Button label={evidence.length ? "Change evidence selection" : "Choose Research Hub evidence"} kind="secondary" disabled={busy} onPress={() => setEvidenceOpen(true)} />
        <Text style={styles.hubMeta}>{hubState.hub.recordCount} {hubState.hub.recordCount === 1 ? "record" : "records"} · Generated {shortHubDate(hubState.hub.generatedAt)} · Review by {shortHubDate(hubState.hub.reviewBy)}</Text>
      </View> : <View style={styles.hubNotice}>
        <AppIcon name={hubState.kind === "forbidden" ? "lock" : "warning"} size={18} color={hubState.kind === "error" ? colors.red : colors.muted} />
        <View style={styles.hubNoticeCopy}>
          <Text accessibilityRole={hubState.kind === "error" ? "alert" : undefined} style={styles.hubNoticeText}>{hubState.message}</Text>
          <Button compact label={hubState.kind === "error" ? "Try again" : "Check again"} kind="secondary" disabled={busy} onPress={() => setHubAttempt(value => value + 1)} style={styles.hubRetry} />
        </View>
      </View>}

      {kind === "design-review" && evidence.length === 0 ? <View style={styles.gapWarning}>
        <AppIcon name="warning" size={17} color={colors.muted} />
        <Text style={styles.gapWarningText}>No Hub evidence is selected. The draft will identify this as an evidence gap and limit conclusions to expert inspection.</Text>
      </View> : null}

      <View style={styles.boundary}>
        <Text style={styles.boundaryTitle}>What happens next</Text>
        <Text style={styles.boundaryBody}>Servant verifies selected evidence again, creates an ordinary titled chat, and places a structured prompt in its composer. Nothing is sent, shared, published, or used to contact participants until you choose what to do next.</Text>
      </View>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <Button label="Review in researcher chat" busy={busy} onPress={() => { void create(); }} style={styles.primary} />
      <Button label="Cancel" kind="link" disabled={busy} onPress={() => router.replace("/research")} />
    </ScrollView>
    {evidenceOpen && hubState.kind === "available" ? <ResearchEvidencePicker hub={hubState.hub} selected={evidence} onHubMetadata={acceptHubMetadata} onHubFailure={setHubState}
      onApply={items => { setEvidence(items); setEvidenceOpen(false); setError(null); }} onClose={() => setEvidenceOpen(false)} /> : null}
  </View>;
}

function ResearchEvidencePicker({ hub, selected, onHubMetadata, onHubFailure, onApply, onClose }: {
  hub: ResearchHubAvailableMetadata;
  selected: ResearchHubEvidence[];
  onHubMetadata: (hub: ResearchHubMetadata) => void;
  onHubFailure: (failure: ResearchHubFailureState) => void;
  onApply: (items: ResearchHubEvidence[]) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ResearchHubEvidence[] | null>(null);
  const [picked, setPicked] = useState<ResearchHubEvidence[]>(selected.slice(0, MAX_RESEARCH_HUB_EVIDENCE));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [revisionNotice, setRevisionNotice] = useState<string | null>(null);
  const revision = useRef(hub.revision);

  useEffect(() => {
    if (!account) return;
    let active = true;
    const controller = new AbortController();
    setResults(null);
    setLoadError(null);
    const timer = setTimeout(() => {
      api.researchHubEvidence(account, query.trim(), controller.signal).then(response => {
        if (!active) return;
        if (response.hub.available && response.hub.revision !== revision.current) {
          revision.current = response.hub.revision;
          setPicked([]);
          setRevisionNotice("Research Hub was updated, so the earlier selection was cleared. Review the current evidence before continuing.");
        }
        onHubMetadata(response.hub);
        if (!response.hub.available) {
          setResults([]);
          setLoadError(response.hub.message || "Research Hub isn't available right now.");
          return;
        }
        setResults(response.evidence);
      }).catch(e => {
        if (!active) return;
        const failure = researchHubFailure(e);
        if (failure.kind !== "error") {
          onHubFailure(failure);
          return;
        }
        setResults([]);
        setLoadError(failure.message);
      });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [account, loadAttempt, onHubFailure, onHubMetadata, query]);

  if (!account) return null;
  const toggle = (item: ResearchHubEvidence) => setPicked(current => current.some(selectedItem => selectedItem.id === item.id)
    ? current.filter(selectedItem => selectedItem.id !== item.id)
    : current.length >= MAX_RESEARCH_HUB_EVIDENCE ? current : [...current, item]);

  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <KeyboardAvoidingView style={styles.pickerKeyboard} behavior={Platform.OS === "ios" ? "padding" : Platform.OS === "android" ? "height" : undefined}>
      <View style={[styles.pickerOverlay, { paddingTop: insets.top + space.side, paddingBottom: insets.bottom + space.side }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close evidence picker" style={StyleSheet.absoluteFill} onPress={onClose} />
        <View accessibilityViewIsModal testID="research-evidence-picker" style={styles.pickerCard}>
          <View style={styles.pickerHeader}>
            <View style={styles.pickerHeadingCopy}>
              <Text accessibilityRole="header" style={styles.pickerTitle}>Choose Research Hub evidence</Text>
              <Text style={styles.pickerSubtitle}>Select up to {MAX_RESEARCH_HUB_EVIDENCE} read-only records. Nothing is sent when you choose them.</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" hitSlop={12} onPress={onClose}>
              <AppIcon name="close" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <TextInput value={query} onChangeText={setQuery} accessibilityLabel="Search Research Hub evidence"
            placeholder="Search topics, products, or findings" placeholderTextColor={colors.muted} autoCorrect={false} autoCapitalize="none" style={styles.pickerSearch} />

          <Text accessibilityLiveRegion="polite" style={styles.pickerCount}>{picked.length} of {MAX_RESEARCH_HUB_EVIDENCE} selected</Text>
          {revisionNotice ? <Text accessibilityRole="alert" style={styles.pickerRevisionNotice}>{revisionNotice}</Text> : null}
          {picked.length ? <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pickerChips}>
            {picked.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`Remove ${item.title}`} onPress={() => toggle(item)} style={styles.pickerChip}>
              <Text numberOfLines={1} style={styles.pickerChipText}>{item.title}</Text>
              <AppIcon name="close" size={14} color={colors.blueDark} />
            </Pressable>)}
          </ScrollView> : null}

          <ScrollView style={styles.pickerResults} contentContainerStyle={styles.pickerResultsContent} keyboardShouldPersistTaps="handled">
            {results === null && !loadError ? <View style={styles.pickerLoading}>
              <ActivityIndicator accessibilityLabel="Loading Research Hub evidence" accessibilityRole="progressbar" color={colors.blue} />
              <Text style={styles.pickerLoadingText}>Loading evidence…</Text>
            </View> : loadError ? <View style={styles.pickerEmpty}>
              <Text accessibilityRole="alert" style={styles.pickerError}>{loadError}</Text>
              <Button label="Try again" kind="secondary" compact onPress={() => setLoadAttempt(value => value + 1)} style={styles.pickerRetry} />
            </View> : !results?.length ? <View style={styles.pickerEmpty}>
              <Text style={styles.pickerEmptyText}>{query.trim()
                ? "No evidence matches this search. Try a product, audience, task, or finding."
                : hub.recordCount === 0 ? "No evidence has been published to Research Hub yet." : "No Research Hub evidence is available."}</Text>
              {query.trim() ? <Button label="Clear search" kind="secondary" compact onPress={() => setQuery("")} style={styles.pickerRetry} /> : null}
            </View> : results.map(item => {
              const checked = picked.some(selectedItem => selectedItem.id === item.id);
              const disabled = !checked && picked.length >= MAX_RESEARCH_HUB_EVIDENCE;
              const sample = typeof item.metric.sampleSize === "number" ? ` · n=${item.metric.sampleSize}` : "";
              return <Pressable key={item.id} accessibilityRole="checkbox" accessibilityState={{ checked, disabled }} disabled={disabled}
                accessibilityLabel={`${item.title}. ${item.product.name}. ${evidenceKind(item.kind)}. ${item.summary}`}
                onPress={() => toggle(item)} style={({ pressed }) => [styles.pickerRow, checked && styles.pickerRowSelected, disabled && styles.pickerRowDisabled, pressed && !disabled && styles.pickerRowPressed]}>
                <View style={styles.pickerRowCopy}>
                  <Text style={styles.pickerRowTitle}>{item.title}</Text>
                  <Text style={styles.pickerRowMeta}>{item.product.name} · {evidenceKind(item.kind)} · {shortEvidenceDate(item.period.start)}–{shortEvidenceDate(item.period.end)}</Text>
                  <Text numberOfLines={2} style={styles.pickerRowSummary}>{item.summary}</Text>
                  <Text numberOfLines={1} style={styles.pickerRowMetric}>{item.metric.label}: {item.metric.value} {item.metric.unit}{sample} · {item.catalogReference}</Text>
                </View>
                <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.pickerCheck, checked && styles.pickerCheckOn]}>
                  {checked ? <AppIcon name="check" size={16} color={colors.onPrimary} /> : null}
                </View>
              </Pressable>;
            })}
          </ScrollView>

          <View style={styles.pickerFooter}>
            <Button label={picked.length ? `Use ${picked.length} ${picked.length === 1 ? "source" : "sources"}` : "Use no Hub evidence"} onPress={() => onApply(picked)} style={styles.pickerApply} />
            <Button label="Cancel" kind="link" onPress={onClose} />
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm, backgroundColor: colors.background },
  loadingText: { ...typography.caption, color: colors.muted },
  content: { width: "100%", maxWidth: 680, alignSelf: "center", paddingBottom: space.xxl },
  note: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, marginHorizontal: space.side, padding: space.md, borderRadius: radius.md, backgroundColor: colors.blueSoft },
  noteText: { ...typography.caption, color: colors.ink, flex: 1 },
  sectionTitle: { ...typography.heading, color: colors.ink, marginTop: space.lg, marginHorizontal: space.side },
  sectionDescription: { ...typography.caption, color: colors.muted, marginTop: space.xxs, marginHorizontal: space.side, marginBottom: space.sm },
  field: { gap: space.xs, marginTop: space.md, marginHorizontal: space.side },
  label: { ...typography.bodyStrong, color: colors.ink },
  input: { ...typography.body, minHeight: 48, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, color: colors.ink, backgroundColor: colors.background },
  multiline: { minHeight: 104 },
  evidenceSelection: { marginHorizontal: space.side, marginBottom: space.sm, gap: space.xs },
  selectionCount: { ...typography.caption, color: colors.muted },
  selectedEvidenceRow: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.md, backgroundColor: colors.blueSoft },
  selectedEvidenceCopy: { flex: 1, minWidth: 0 },
  selectedEvidenceTitle: { ...typography.bodyStrong, color: colors.ink },
  selectedEvidenceMeta: { ...typography.meta, color: colors.muted, marginTop: 2 },
  removeEvidence: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  clearEvidence: { alignSelf: "flex-start" },
  hubStatus: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, marginHorizontal: space.side, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  hubStatusText: { ...typography.caption, color: colors.muted },
  hubAvailable: { marginHorizontal: space.side, gap: space.xs },
  hubMeta: { ...typography.meta, color: colors.muted, textAlign: "center" },
  hubNotice: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, marginHorizontal: space.side, padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface },
  hubNoticeCopy: { flex: 1, minWidth: 0 },
  hubNoticeText: { ...typography.caption, color: colors.muted },
  hubRetry: { alignSelf: "flex-start", minWidth: 120, marginTop: space.sm },
  gapWarning: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, marginHorizontal: space.side, marginTop: space.sm, padding: space.sm, borderRadius: radius.md, backgroundColor: colors.surface },
  gapWarningText: { ...typography.caption, color: colors.muted, flex: 1 },
  boundary: { marginHorizontal: space.side, marginTop: space.lg, padding: space.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surface },
  boundaryTitle: { ...typography.bodyStrong, color: colors.ink },
  boundaryBody: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  error: { ...typography.caption, color: colors.red, marginHorizontal: space.side, marginTop: space.md },
  primary: { marginHorizontal: space.side, marginTop: space.lg },
  locked: { alignItems: "center", marginHorizontal: space.side, marginTop: space.lg, padding: space.lg, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surface },
  lockedIcon: { width: 50, height: 50, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: colors.background },
  lockedTitle: { ...typography.heading, color: colors.ink, textAlign: "center", marginTop: space.md },
  lockedBody: { ...typography.body, color: colors.muted, textAlign: "center", maxWidth: 420, marginTop: space.xs },
  lockedAction: { minWidth: 220, marginTop: space.lg },
  pickerKeyboard: { flex: 1 },
  pickerOverlay: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: space.side, backgroundColor: "rgba(0,0,0,0.42)" },
  pickerCard: { width: "100%", maxWidth: 560, maxHeight: "100%", minHeight: 360, padding: space.side, borderRadius: radius.lg, backgroundColor: colors.background },
  pickerHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: space.sm },
  pickerHeadingCopy: { flex: 1, minWidth: 0 },
  pickerTitle: { ...typography.heading, color: colors.ink },
  pickerSubtitle: { ...typography.caption, color: colors.muted, marginTop: 2 },
  pickerSearch: { ...typography.body, minHeight: 48, marginTop: space.md, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, color: colors.ink, backgroundColor: colors.background },
  pickerCount: { ...typography.caption, color: colors.muted, marginTop: space.sm },
  pickerRevisionNotice: { ...typography.caption, color: colors.ink, marginTop: space.xs, padding: space.sm, borderRadius: radius.sm, backgroundColor: colors.surface },
  pickerChips: { gap: space.xs, paddingTop: space.xs, paddingBottom: space.sm },
  pickerChip: { maxWidth: 220, minHeight: 40, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.sm, borderRadius: radius.sm, backgroundColor: colors.blueSoft },
  pickerChipText: { ...typography.captionStrong, color: colors.blueDark, flexShrink: 1 },
  pickerResults: { flexShrink: 1, minHeight: 160, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  pickerResultsContent: { flexGrow: 1, paddingVertical: space.xs },
  pickerLoading: { flex: 1, minHeight: 180, alignItems: "center", justifyContent: "center", gap: space.sm },
  pickerLoadingText: { ...typography.caption, color: colors.muted },
  pickerEmpty: { flex: 1, minHeight: 180, alignItems: "center", justifyContent: "center", padding: space.lg },
  pickerEmptyText: { ...typography.body, color: colors.muted, textAlign: "center" },
  pickerError: { ...typography.body, color: colors.red, textAlign: "center" },
  pickerRetry: { minWidth: 120, marginTop: space.md },
  pickerRow: { minHeight: 112, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.sm, paddingVertical: space.sm, borderRadius: radius.md },
  pickerRowSelected: { backgroundColor: colors.blueSoft },
  pickerRowDisabled: { opacity: 0.5 },
  pickerRowPressed: { backgroundColor: colors.surface },
  pickerRowCopy: { flex: 1, minWidth: 0 },
  pickerRowTitle: { ...typography.bodyStrong, color: colors.ink },
  pickerRowMeta: { ...typography.meta, color: colors.muted, marginTop: 2 },
  pickerRowSummary: { ...typography.caption, color: colors.ink, marginTop: space.xxs },
  pickerRowMetric: { ...typography.meta, color: colors.muted, marginTop: space.xxs },
  pickerCheck: { width: 24, height: 24, borderRadius: 4, borderWidth: 1.5, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  pickerCheckOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  pickerFooter: { paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  pickerApply: { width: "100%" },
}));
