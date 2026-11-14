import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppIcon } from "../components/AppIcon";
import { PageTitle } from "../components/Band";
import { Button } from "../components/Button";
import { designChats, designStatus, designTitle, studyPrototypeChats } from "../lib/designs";
import {
  buildResearchPrompt,
  buildStudyPrototypePrompt,
  isResearchTaskKind,
  MAX_RESEARCH_HUB_EVIDENCE,
  missingResearchFields,
  prototypeChatTitle,
  MAX_RESEARCH_FINDINGS_CHARS,
  researchDesignGuidanceKey,
  researchFindingsProblems,
  researchChatTitle,
  researchTask,
  type ResearchBrief,
  type ResearchFieldId,
  type ResearchPrototype,
} from "../lib/research-studio";
import { api, ServerError, type Chat, type ResearchHubAvailableMetadata, type ResearchHubEvidence, type ResearchHubMetadata } from "../lib/server";
import { setDraft } from "../lib/drafts";
import { StudyActivities } from "../components/StudyActivities";
import { StudyMethodPicker } from "../components/StudyMethodPicker";
import { DEFAULT_STUDY_SETUP, studyDraftProblems, type OtherMethod, type StudyActivity, type StudySetup } from "../lib/research-methods";
import { saveWorkingDraft, type WorkingDraftForm } from "../lib/working-draft-save";
import { DraftChecklist } from "../components/DraftChecklist";
import { useRadioGroup } from "../components/useRadioGroup";
import { PROTOTYPE_OPTIONS, PrototypeModeOptions, type PrototypeMode } from "../components/PrototypeModeOptions";
import { SUPPORTED_RESEARCH_STUDIO_VERSION } from "../lib/research-studio-compat";
import { saveTextFile } from "../lib/save-text-file";
import { useSession } from "../lib/session";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { clearFormDraft, formDraftKey, readFormDraft, writeFormDraft } from "../lib/form-drafts";
import { parseResearchFormDraft, researchFormDraft, researchFormDraftEmpty, type ResearchFormDraft } from "../lib/research-form-draft";
import { whenInSentence } from "../lib/time-label";
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

function prototypeReference(design: Chat, ownName: string): ResearchPrototype {
  return {
    kind: "existing",
    id: design.id,
    title: designTitle(design),
    status: designStatus(design),
    previewUrl: design.previewUrl?.trim() || undefined,
    author: design.author?.name?.trim() || ownName,
  };
}

export default function NewResearchWork() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { kind: rawKind, prototype: rawPrototype } = useLocalSearchParams<{ kind?: string | string[]; prototype?: string | string[] }>();
  // From a design's "Use in a study plan": that prototype, chosen once it's confirmed ready.
  const requestedPrototype = Array.isArray(rawPrototype) ? rawPrototype[0] : rawPrototype;
  const requestedKind = Array.isArray(rawKind) ? rawKind[0] : rawKind;
  const kind = isResearchTaskKind(requestedKind) ? requestedKind : "study";
  const task = researchTask(kind);
  const { account, setAccount } = useSession();
  const [title, setTitle] = useState("");
  const [answers, setAnswers] = useState<Partial<Record<ResearchFieldId, string>>>({});
  const [activities, setActivities] = useState<StudyActivity[]>([]);
  const [otherMethods, setOtherMethods] = useState<OtherMethod[]>([]);
  const [studySetup, setStudySetup] = useState<StudySetup>(DEFAULT_STUDY_SETUP);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [savingFile, setSavingFile] = useState(false);
  const [agentTier, setAgentTier] = useState<number | null | undefined>(undefined);
  // Research pilot: sending to the Researcher Agent and Research Hub evidence
  // are on hold. The study builder stays local, and a new prototype can still
  // start from the researcher's own findings.
  const [held, setHeld] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hubState, setHubState] = useState<ResearchHubState>({ kind: "checking" });
  const [hubAttempt, setHubAttempt] = useState(0);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidence, setEvidence] = useState<ResearchHubEvidence[]>([]);
  const [prototypeMode, setPrototypeMode] = useState<PrototypeMode>("none");
  const [prototypePurpose, setPrototypePurpose] = useState("");
  const [researchFindings, setResearchFindings] = useState("");
  const [showBuildPrompt, setShowBuildPrompt] = useState(false);
  // The form is kept as a draft on this device as it's filled in, and put back when it's opened again.
  const draftKey = account ? formDraftKey(account, `research-new:${kind}`) : null;
  const [hydrated, setHydrated] = useState(false);
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  // Which confirmation is open: Start over, or starting a new plan for a prototype chosen in Design Studio.
  const [confirming, setConfirming] = useState<null | "start-over" | "new-with-prototype">(null);
  // A prototype chosen with "Use in a study plan" while a plan was in progress: the researcher decides where it goes.
  const [prototypeOffer, setPrototypeOffer] = useState<Chat | null>(null);
  const restoredDraft = useRef<{ selectedPrototypeId: string | null } | null>(null);
  const pendingDraft = useRef<ResearchFormDraft | null>(null);
  const draftDone = useRef(false);
  const [prototypeOpen, setPrototypeOpen] = useState(false);
  const [selectedPrototype, setSelectedPrototype] = useState<Chat | null>(null);
  const [createdPrototype, setCreatedPrototype] = useState<Chat | null>(null);
  const [createdPrototypePrompt, setCreatedPrototypePrompt] = useState<string | null>(null);
  const [prototypeNotice, setPrototypeNotice] = useState<string | null>(null);
  const [prototypeChecking, setPrototypeChecking] = useState(false);
  const [designGuidanceText, setDesignGuidanceText] = useState("");
  const [designGuidanceSourceKey, setDesignGuidanceSourceKey] = useState<string | null>(null);
  const [designGuidanceSourceCount, setDesignGuidanceSourceCount] = useState(0);
  const [designGuidanceApproved, setDesignGuidanceApproved] = useState(false);
  const [designGuidanceBusy, setDesignGuidanceBusy] = useState(false);
  const [designGuidanceError, setDesignGuidanceError] = useState<string | null>(null);
  const hubRevision = useRef<string | null>(null);
  const createdPrototypeRef = useRef<Chat | null>(null);
  const prototypeModeRef = useRef<PrototypeMode>(prototypeMode);
  const prototypeRefresh = useRef(0);
  // The form as last rendered, read again after every await while saving.
  const draftForm = useRef<WorkingDraftForm | null>(null);
  useEffect(() => {
    draftForm.current = {
      title, decision: answers.decision, question: answers.question, participants: answers.participants, background: answers.inputs, setup: studySetup, activities, otherMethods,
      prototype: prototypeMode === "existing" ? { mode: "existing", url: selectedPrototype?.previewUrl?.trim() || null } : { mode: "none" },
      prototypeId: prototypeMode === "existing" ? selectedPrototype?.id ?? null : null,
    };
  }, [title, answers, studySetup, activities, otherMethods, prototypeMode, selectedPrototype]);

  const acceptHubMetadata = useCallback((hub: ResearchHubMetadata) => {
    if (hub.available) {
      if (hubRevision.current && hubRevision.current !== hub.revision) setEvidence([]);
      hubRevision.current = hub.revision;
    }
    setHubState(hub.available
      ? { kind: "available", hub }
      : { kind: "unavailable", message: hub.message || "Research Hub isn't available on this server yet. You can continue without attaching Hub evidence." });
  }, [setEvidence, setHubState]);
  const clearSelectedPrototype = useCallback(() => setSelectedPrototype(null), [setSelectedPrototype]);

  useEffect(() => { prototypeModeRef.current = prototypeMode; }, [prototypeMode]);

  const refreshCreatedPrototype = useCallback(async () => {
    const prototypeId = createdPrototypeRef.current?.id;
    if (!account || !prototypeId) return;
    const refresh = ++prototypeRefresh.current;
    setPrototypeChecking(true);
    try {
      const library = await api.orgChats(account, setAccount);
      if (refresh !== prototypeRefresh.current) return;
      const current = designChats(library.mine, library.others).find(design => design.id === prototypeId);
      if (!current) {
        createdPrototypeRef.current = null;
        setDraft(`chat:${prototypeId}`, "");
        setCreatedPrototype(null);
        setCreatedPrototypePrompt(null);
        setPrototypeNotice("That empty prototype workspace was discarded. Create it again when you're ready.");
        return;
      }
      createdPrototypeRef.current = current;
      setCreatedPrototype(current);
      const ready = studyPrototypeChats(library.mine, library.others).find(design => design.id === prototypeId);
      if (ready && prototypeModeRef.current === "new") {
        prototypeModeRef.current = "existing";
        setSelectedPrototype(ready);
        setPrototypeMode("existing");
        setPrototypeNotice("Prototype is ready and selected for this study.");
      } else if (!ready) {
        setPrototypeNotice(`Prototype status: ${designStatus(current)}. Return to the workspace to keep building, or check again when it has a live preview.`);
      }
    } catch (e) {
      if (refresh === prototypeRefresh.current) setPrototypeNotice(e instanceof ServerError ? e.message : "The prototype status couldn't be checked. Try again.");
    } finally {
      if (refresh === prototypeRefresh.current) setPrototypeChecking(false);
    }
  }, [account, setAccount, setCreatedPrototype, setCreatedPrototypePrompt, setPrototypeChecking, setPrototypeMode, setPrototypeNotice, setSelectedPrototype]);

  useFocusEffect(useCallback(() => {
    void refreshCreatedPrototype();
    return () => { prototypeRefresh.current += 1; };
  }, [refreshCreatedPrototype]));

  useEffect(() => {
    if (!account) return;
    let active = true;
    setAgentTier(undefined);
    setAccessError(null);
    api.projects(account).then(result => {
      if (!active) return;
      const tier = result.agentTier;
      setHeld(result.researchHold === true);
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

  // Only a published, shareable prototype the server lists for this person is chosen; anything else is ignored.
  // Put a saved draft back once Researcher access is confirmed. Prototypes are
  // kept by id and checked again here; nothing from Research Hub is kept.
  useEffect(() => {
    if (!account || !draftKey || agentTier !== 4 || hydrated) return;
    let active = true;
    void (async () => {
      const saved = await readFormDraft(draftKey).catch(() => null);
      const draft = saved ? parseResearchFormDraft(saved.value, kind) : null;
      if (!active) return;
      if (saved && draft && !researchFormDraftEmpty(draft)) {
        setTitle(draft.title);
        setAnswers(draft.answers);
        setActivities(draft.activities);
        setOtherMethods(draft.otherMethods);
        setStudySetup(draft.setup);
        setPrototypePurpose(draft.prototypePurpose);
        setResearchFindings(draft.researchFindings);
        let mode = draft.prototypeMode;
        let notice: string | null = null;
        if (draft.selectedPrototypeId || draft.createdPrototypeId) {
          try {
            const library = await api.orgChats(account, setAccount);
            if (!active) return;
            const created = draft.createdPrototypeId ? designChats(library.mine, library.others).find(design => design.id === draft.createdPrototypeId) : undefined;
            if (created) {
              createdPrototypeRef.current = created;
              setCreatedPrototype(created);
              setCreatedPrototypePrompt(draft.createdPrototypePrompt);
            }
            const ready = draft.selectedPrototypeId ? studyPrototypeChats(library.mine, library.others).find(design => design.id === draft.selectedPrototypeId) : undefined;
            if (mode === "existing" && ready) setSelectedPrototype(ready);
            else if (mode === "existing") {
              mode = created ? "new" : "none";
              notice = "The prototype you chose earlier isn't published anymore, so none is chosen. Choose one again.";
            } else if (mode === "new" && draft.createdPrototypeId && !created) {
              notice = "The prototype workspace you created earlier is gone. Create it again when you're ready.";
            }
          } catch {
            if (!active) return;
            if (mode === "existing") mode = "none";
            notice = "Couldn't check the prototype you chose earlier. Choose it again.";
          }
        } else if (mode === "existing") mode = "none";
        prototypeModeRef.current = mode;
        setPrototypeMode(mode);
        if (notice) setPrototypeNotice(notice);
        restoredDraft.current = { selectedPrototypeId: mode === "existing" ? draft.selectedPrototypeId : null };
        setRestoredAt(saved.savedAt);
        setDraftSavedAt(saved.savedAt);
      }
      setHydrated(true);
    })();
    return () => { active = false; };
  }, [account, setAccount, draftKey, agentTier, hydrated, kind]);
  // A restored prototype workspace may have published while the form was closed.
  useEffect(() => { if (hydrated && createdPrototypeRef.current) void refreshCreatedPrototype(); }, [hydrated, refreshCreatedPrototype]);

  // Save as the form changes (shortly after typing stops), and right away when leaving it.
  useEffect(() => {
    if (!hydrated || !draftKey || draftDone.current) return;
    const draft = researchFormDraft({
      kind, title, answers, activities, otherMethods, setup: studySetup, prototypeMode, prototypePurpose, researchFindings,
      selectedPrototypeId: prototypeMode === "existing" ? selectedPrototype?.id ?? null : null,
      createdPrototypeId: createdPrototype?.id ?? null,
      createdPrototypePrompt: createdPrototype ? createdPrototypePrompt : null,
    });
    pendingDraft.current = draft;
    const timer = setTimeout(() => {
      pendingDraft.current = null;
      if (researchFormDraftEmpty(draft)) { void clearFormDraft(draftKey).catch(() => {}); setDraftSavedAt(null); return; }
      const at = Date.now();
      void writeFormDraft(draftKey, draft, at).then(() => setDraftSavedAt(at)).catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [hydrated, draftKey, kind, title, answers, activities, otherMethods, studySetup, prototypeMode, prototypePurpose, researchFindings, selectedPrototype?.id, createdPrototype, createdPrototypePrompt]);
  // Anything typed in the last moment is saved when leaving the form, and when
  // the page is closed, reloaded or hidden, or the app goes to the background.
  useEffect(() => {
    const flush = () => {
      const draft = pendingDraft.current;
      if (!draft || !draftKey || draftDone.current) return;
      pendingDraft.current = null;
      void (researchFormDraftEmpty(draft) ? clearFormDraft(draftKey) : writeFormDraft(draftKey, draft)).catch(() => {});
    };
    const hidden = () => { if (typeof document !== "undefined" && document.visibilityState === "hidden") flush(); };
    const web = Platform.OS === "web" && typeof window !== "undefined";
    if (web) {
      window.addEventListener("pagehide", flush);
      window.addEventListener("beforeunload", flush);
      document.addEventListener("visibilitychange", hidden);
    }
    const app = web ? null : AppState.addEventListener("change", state => { if (state !== "active") flush(); });
    return () => {
      if (web) {
        window.removeEventListener("pagehide", flush);
        window.removeEventListener("beforeunload", flush);
        document.removeEventListener("visibilitychange", hidden);
      }
      app?.remove();
      flush();
    };
  }, [draftKey]);

  const chooseStudyPrototype = useCallback((ready: Chat) => {
    prototypeModeRef.current = "existing";
    setPrototypeMode("existing");
    setSelectedPrototype(ready);
    setPrototypeOffer(null);
    setPrototypeNotice(`Using ${designTitle(ready)} as this study's prototype.`);
  }, [setPrototypeMode, setSelectedPrototype, setPrototypeNotice]);
  const prechosen = useRef(false);
  useEffect(() => {
    // After a saved draft is put back. A plan in progress isn't changed without asking.
    if (!account || agentTier !== 4 || kind !== "study" || !requestedPrototype || prechosen.current || !hydrated) return;
    prechosen.current = true;
    let active = true;
    api.orgChats(account, setAccount).then(library => {
      const ready = studyPrototypeChats(library.mine, library.others).find(design => design.id === requestedPrototype);
      if (!active) return;
      if (!ready) { setPrototypeNotice("That prototype isn't ready for a study yet, so none is chosen. Choose one below when it's published."); return; }
      const restored = restoredDraft.current;
      if (restored && restored.selectedPrototypeId !== ready.id) setPrototypeOffer(ready);
      else chooseStudyPrototype(ready);
    }).catch(() => { if (active) setPrototypeNotice("Couldn't load that prototype. Choose one below."); });
    return () => { active = false; };
  }, [account, setAccount, agentTier, kind, requestedPrototype, hydrated, chooseStudyPrototype]);

  useEffect(() => {
    if (!account || agentTier !== 4 || held) return;
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
  }, [account?.serverUrl, account?.serverKey, account?.user.id, acceptHubMetadata, agentTier, hubAttempt, held]);

  if (!account) return null;
  const update = (field: ResearchFieldId, value: string) => setAnswers(current => ({ ...current, [field]: value }));
  const selectedResearchPrototype = (): ResearchPrototype | undefined => kind !== "study" || prototypeMode === "none"
    ? undefined
    : prototypeMode === "new"
      ? { kind: "new", purpose: prototypePurpose }
      : selectedPrototype ? prototypeReference(selectedPrototype, account.user.name) : undefined;
  const brief = (
    records: readonly ResearchHubEvidence[] = evidence,
    hub?: ResearchHubMetadata,
    prototype: ResearchPrototype | undefined = selectedResearchPrototype(),
  ): ResearchBrief => ({
    kind,
    title,
    answers,
    evidence: records,
    evidenceHub: hub ?? (hubState.kind === "available" ? hubState.hub : undefined),
    ...(prototype ? { prototype } : {}),
    ...(kind === "study" && activities.length ? { activities, setup: studySetup } : {}),
    ...(kind === "study" && otherMethods.length ? { otherMethods } : {}),
  });
  // The working draft uses an existing prototype the person chose; new prototypes aren't part of it.
  const draftPrototype = prototypeMode === "existing" ? { mode: "existing" as const, url: selectedPrototype?.previewUrl?.trim() || null } : { mode: "none" as const };
  const draftInput = { title, decision: answers.decision, question: answers.question, participants: answers.participants, setup: studySetup, activities, otherMethods, prototype: draftPrototype };
  const fileProblems = kind === "study" ? studyDraftProblems(draftInput) : [];
  // Everything that feeds the working draft is locked while it's checked and saved.
  const locked = busy || savingFile;
  // Built on this device from this form only: no Research Hub records, chats, or workspace data.
  // Every control is locked while saving, and the save is abandoned if the plan changes anyway.
  const saveStudioFile = async () => {
    if (fileProblems.length || savingFile) return;
    setFileNotice(null);
    setSavingFile(true);
    try {
      const result = await saveWorkingDraft({
        current: () => draftForm.current ?? { ...draftInput, background: answers.inputs, prototypeId: selectedPrototype?.id ?? null },
        loadReadyPrototypes: async () => {
          try {
            const library = await api.orgChats(account, setAccount);
            return studyPrototypeChats(library.mine, library.others);
          } catch (e) { throw new Error(e instanceof ServerError ? e.message : ""); }
        },
        save: saveTextFile,
      });
      if (!result.ok) {
        if (result.clearPrototype) setSelectedPrototype(null);
        setFileNotice(result.message);
        return;
      }
      setFileNotice(Platform.OS === "web" ? `Saved working draft ${result.fileName}. In Research Studio, choose Import JSON and keep refining it there.` : "Choose where to save or send the working draft, then use Import JSON in Research Studio.");
    } finally {
      setSavingFile(false);
    }
  };
  const prototypeContextBrief = (hub: ResearchHubMetadata | undefined = hubState.kind === "available" ? hubState.hub : undefined): ResearchBrief => ({
    kind: "study",
    title,
    answers,
    prototype: { kind: "new", purpose: prototypePurpose },
    evidence,
    evidenceHub: hub,
  });
  const currentDesignGuidanceKey = researchDesignGuidanceKey(prototypeContextBrief());
  const designGuidanceStale = !!designGuidanceText && designGuidanceSourceKey !== currentDesignGuidanceKey;
  const findingsProblems = researchFindingsProblems(researchFindings);
  const prototypeBuildBrief = (): ResearchBrief => ({
    ...prototypeContextBrief(),
    researchFindings,
    ...(designGuidanceText && designGuidanceApproved && !designGuidanceStale
      ? { designGuidance: { text: designGuidanceText, approved: true } }
      : {}),
  });
  const currentPrototypePrompt = kind === "study" && createdPrototype
    ? buildStudyPrototypePrompt(prototypeBuildBrief())
    : null;
  const prototypeBriefChanged = !!createdPrototypePrompt && currentPrototypePrompt !== createdPrototypePrompt;
  const resetCreatedPrototype = () => {
    createdPrototypeRef.current = null;
    prototypeModeRef.current = "new";
    setCreatedPrototype(null);
    setCreatedPrototypePrompt(null);
    setSelectedPrototype(null);
    setPrototypeMode("new");
    setPrototypeNotice("The earlier prototype stays in Design Studio. Create a new workspace from the updated study brief.");
    setError(null);
  };
  const choosePrototypeMode = (mode: PrototypeMode) => {
    if (mode !== prototypeMode) {
      if (mode === "new") setSelectedPrototype(null);
      if (mode === "existing") setPrototypeOpen(true);
    }
    prototypeModeRef.current = mode;
    setPrototypeMode(mode);
    setError(null);
    setPrototypeNotice(null);
  };

  const openPrototypeWorkspace = (prototype: Chat) => {
    router.push({ pathname: "/chat/[id]", params: { id: prototype.id, title: designTitle(prototype), compose: "1", studio: "1" } });
  };

  // Clears the form and its saved draft. Prototypes it created stay in Design Studio.
  const startOver = () => {
    if (draftKey) void clearFormDraft(draftKey).catch(() => {});
    pendingDraft.current = null;
    setTitle("");
    setAnswers({});
    setActivities([]);
    setOtherMethods([]);
    setStudySetup(DEFAULT_STUDY_SETUP);
    prototypeModeRef.current = "none";
    setPrototypeMode("none");
    setPrototypePurpose("");
    setResearchFindings("");
    setShowBuildPrompt(false);
    setSelectedPrototype(null);
    createdPrototypeRef.current = null;
    setCreatedPrototype(null);
    setCreatedPrototypePrompt(null);
    setEvidence([]);
    setDesignGuidanceText("");
    setDesignGuidanceSourceKey(null);
    setDesignGuidanceApproved(false);
    setDesignGuidanceError(null);
    setPrototypeNotice(null);
    setFileNotice(null);
    setError(null);
    setRestoredAt(null);
    setDraftSavedAt(null);
    setPrototypeOffer(null);
    restoredDraft.current = null;
    setConfirming(null);
  };

  const discardDesignGuidance = () => {
    setDesignGuidanceText("");
    setDesignGuidanceSourceKey(null);
    setDesignGuidanceSourceCount(0);
    setDesignGuidanceApproved(false);
    setDesignGuidanceError(null);
  };

  const prepareDesignGuidance = async () => {
    if (designGuidanceBusy || busy || agentTier !== 4) return;
    if (!evidence.length) {
      setDesignGuidanceError("Choose Research Hub evidence before preparing needs and pain points.");
      return;
    }
    if (hubState.kind !== "available") {
      setDesignGuidanceError("Research Hub evidence can't be verified right now. Check the Hub again before preparing design guidance.");
      return;
    }
    const contextBrief = prototypeContextBrief();
    const missing = missingResearchFields(contextBrief);
    if (missing.length) {
      setDesignGuidanceError(`Complete ${missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`} before preparing design guidance.`);
      return;
    }
    setDesignGuidanceBusy(true);
    setDesignGuidanceError(null);
    setDesignGuidanceApproved(false);
    try {
      const result = await api.researchHubDesignGuidance(account, evidence.map(item => item.id), hubState.hub.revision, {
        title,
        decision: answers.decision ?? "",
        question: answers.question ?? "",
        participants: answers.participants ?? "",
        purpose: prototypePurpose,
        constraints: answers.constraints ?? "",
      });
      acceptHubMetadata(result.hub);
      setDesignGuidanceText(result.guidance);
      setDesignGuidanceSourceKey(researchDesignGuidanceKey(prototypeContextBrief(result.hub)));
      setDesignGuidanceSourceCount(evidence.length);
      setDesignGuidanceApproved(false);
    } catch (e) {
      if (e instanceof ServerError && e.code === "research_hub_changed") setHubAttempt(value => value + 1);
      setDesignGuidanceError(e instanceof ServerError ? e.message : "The Researcher Agent couldn't prepare design guidance. Try again.");
    } finally {
      setDesignGuidanceBusy(false);
    }
  };

  const create = async () => {
    // Nothing goes to the Researcher Agent while the research pilot holds it. A
    // new prototype (from the researcher's own findings) still can be created.
    if (held && !(kind === "study" && prototypeMode === "new")) return;
    if (busy || designGuidanceBusy || agentTier !== 4) return;
    if (kind === "study" && prototypeMode === "new" && !createdPrototype && findingsProblems.length) {
      setError(`Check what the research found before creating the prototype: ${findingsProblems.join(" ")}`);
      return;
    }
    if (kind === "study" && prototypeMode === "new" && designGuidanceText && (designGuidanceStale || !designGuidanceApproved)) {
      setError(designGuidanceStale
        ? "The research-informed design guidance no longer matches this study or evidence. Refresh it, or continue without Hub insights."
        : "Review and approve the research-informed design guidance, or continue without Hub insights.");
      return;
    }
    if (kind === "study" && prototypeMode === "new" && createdPrototype) {
      if (prototypeBriefChanged) {
        resetCreatedPrototype();
        return;
      }
      openPrototypeWorkspace(createdPrototype);
      return;
    }
    if (kind === "study" && prototypeMode === "existing" && createdPrototype && selectedPrototype?.id === createdPrototype.id && prototypeBriefChanged) {
      setError("The study details changed after this prototype was created. Create an updated prototype before finishing the study plan.");
      return;
    }
    if (kind === "study" && prototypeMode === "existing" && !selectedPrototype) {
      setError("Choose an existing prototype or select a different prototype option.");
      return;
    }
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
      if (kind === "study" && prototypeMode === "new") {
        let researchHandoff: { ids: string[]; revision: string; guidance: string; firstMessage: string } | undefined;
        let verifiedHandoffRevision: string | null = null;
        if (designGuidanceApproved) {
          if (hubState.kind !== "available" || !evidence.length) {
            setDesignGuidanceApproved(false);
            setError("Research Hub evidence can't be verified right now. Refresh the design guidance or continue without Hub insights.");
            return;
          }
          let verified;
          try {
            verified = await api.resolveResearchHubEvidence(account, evidence.map(item => item.id), hubState.hub.revision);
          } catch (e) {
            if (e instanceof ServerError && (e.status === 403 || e.status === 404)) setHubState(researchHubFailure(e));
            if (e instanceof ServerError && e.code === "research_hub_changed") setHubAttempt(value => value + 1);
            setDesignGuidanceApproved(false);
            setDesignGuidanceError("The Hub evidence behind this guidance is no longer current. Review the evidence and prepare the guidance again.");
            setError(e instanceof ServerError ? e.message : "The Hub evidence behind this guidance couldn't be verified.");
            return;
          }
          if (!verified.hub.available) {
            acceptHubMetadata(verified.hub);
            setDesignGuidanceApproved(false);
            setError(verified.hub.message || "Research Hub evidence isn't available right now.");
            return;
          }
          const byId = new Map(verified.evidence.map(item => [item.id, item]));
          const ordered = evidence.map(item => byId.get(item.id)).filter((item): item is ResearchHubEvidence => !!item);
          const verifiedKey = researchDesignGuidanceKey({ ...prototypeContextBrief(verified.hub), evidence: ordered });
          if (ordered.length !== evidence.length || verifiedKey !== designGuidanceSourceKey) {
            acceptHubMetadata(verified.hub);
            setEvidence(ordered);
            setDesignGuidanceApproved(false);
            setDesignGuidanceError("The Hub evidence behind this guidance changed. Prepare and review the guidance again.");
            setError("Refresh the research-informed design guidance before creating this prototype.");
            return;
          }
          acceptHubMetadata(verified.hub);
          setEvidence(ordered);
          verifiedHandoffRevision = verified.hub.revision;
        }
        const prototypeTitle = prototypeChatTitle(title);
        const prototypePrompt = buildStudyPrototypePrompt(prototypeBuildBrief());
        if (designGuidanceApproved && verifiedHandoffRevision) {
          researchHandoff = {
            ids: evidence.map(item => item.id),
            revision: verifiedHandoffRevision,
            guidance: designGuidanceText,
            firstMessage: prototypePrompt,
          };
        }
        const chat = await api.newChat(account, {
          mode: "vibe",
          title: prototypeTitle,
          requiredAgentRole: "prototype",
          ...(researchHandoff ? { researchHandoff } : {}),
        });
        if (chat.mode !== "vibe" || chat.agentRole !== "prototype") {
          await api.deleteChat(account, chat.id).catch(() => {});
          setError("This workspace couldn't verify prototype-agent access. Ask a workspace owner to update or confirm your Researcher access.");
          return;
        }
        if (researchHandoff && chat.researchHandoff?.state !== "pending") {
          await api.deleteChat(account, chat.id).catch(() => {});
          setError("This server couldn't bind the Research Hub guidance to the prototype prompt. Ask an owner to update the server before trying again.");
          return;
        }
        setDraft(`chat:${chat.id}`, prototypePrompt);
        createdPrototypeRef.current = chat;
        setCreatedPrototype(chat);
        setCreatedPrototypePrompt(prototypePrompt);
        setPrototypeNotice(researchHandoff
          ? "Prototype workspace created. Review the bound build prompt and send it unchanged. Return here to revise the research handoff."
          : "Prototype workspace created. Review the build prompt, then send it when you're ready.");
        openPrototypeWorkspace(chat);
        return;
      }
      let resolvedEvidence: readonly ResearchHubEvidence[] = evidence;
      let resolvedHub: ResearchHubMetadata | undefined = hubState.kind === "available" ? hubState.hub : undefined;
      let resolvedPrototype = current.prototype;
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
        setEvidence(ordered);
        resolvedEvidence = ordered;
        resolvedHub = resolved.hub;
      }
      if (kind === "study" && prototypeMode === "existing" && selectedPrototype) {
        let latestPrototype: Chat | undefined;
        try {
          const library = await api.orgChats(account, setAccount);
          latestPrototype = studyPrototypeChats(library.mine, library.others).find(design => design.id === selectedPrototype.id);
        } catch (e) {
          setError(e instanceof ServerError ? e.message : "The selected prototype couldn't be verified. Try again.");
          return;
        }
        if (!latestPrototype) {
          setError("That prototype is no longer available or published. Choose another prototype with an active live preview, or create a new one.");
          return;
        }
        setSelectedPrototype(latestPrototype);
        resolvedPrototype = prototypeReference(latestPrototype, account.user.name);
      }
      const resolvedBrief = brief(resolvedEvidence, resolvedHub, resolvedPrototype);
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
      // The brief is now an unsent draft in the researcher chat: this form's draft is done.
      draftDone.current = true;
      pendingDraft.current = null;
      if (draftKey) void clearFormDraft(draftKey).catch(() => {});
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

  if (held && kind !== "study") return <View style={styles.root}>
    <Stack.Screen options={{ title: task.actionLabel }} />
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <PageTitle description={task.description}>{task.actionLabel}</PageTitle>
      <View style={styles.locked}>
        <View style={styles.lockedIcon}><AppIcon name="lock" size={22} color={colors.muted} /></View>
        <Text accessibilityRole="header" style={styles.lockedTitle}>Paused for the research pilot</Text>
        <Text style={styles.lockedBody}>This works through the Researcher Agent, which Research Studio isn't using during the pilot. You can still build a study plan and save a working draft.</Text>
        <Button label="Back to Research Studio" kind="secondary" onPress={() => router.replace("/research")} style={styles.lockedAction} />
      </View>
    </ScrollView>
  </View>;

  // During the pilot only a new prototype is sent anywhere (to the prototype agent, once you review it).
  const canSend = !held || (kind === "study" && prototypeMode === "new");

  return <View style={styles.root}>
    <Stack.Screen options={{ title: task.actionLabel }} />
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <PageTitle description={task.description}>{task.actionLabel}</PageTitle>
      {restoredAt !== null || draftSavedAt !== null ? <View style={styles.draftStatus}>
        <AppIcon name={restoredAt !== null ? "clock" : "check"} size={16} color={colors.muted} />
        <Text style={styles.draftStatusText}>{restoredAt !== null
          ? `Picked up where you left off (last saved ${whenInSentence(draftSavedAt ?? restoredAt)}). Your answers are saved on this device as you go.${held ? "" : " Research Hub evidence and design guidance aren't saved, so choose them again."}`
          : `Your answers are saved on this device as you go (last saved ${whenInSentence(draftSavedAt!)}).`}</Text>
        <Button label="Start over" kind="link" compact disabled={locked || designGuidanceBusy} onPress={() => setConfirming("start-over")} />
      </View> : null}
      {prototypeOffer ? <View accessibilityLiveRegion="polite" style={styles.offer}>
        <Text accessibilityRole="header" style={styles.offerTitle}>You have a study plan in progress</Text>
        <Text style={styles.offerBody}>{`“${title.trim() || "Untitled study plan"}”${restoredAt !== null ? `, last saved ${whenInSentence(restoredAt)}` : ""}. Use ${designTitle(prototypeOffer)} in this plan, or start a new study plan with it?`}</Text>
        <View style={styles.offerActions}>
          <Button label="Use it in this plan" compact disabled={locked} onPress={() => chooseStudyPrototype(prototypeOffer)} />
          <Button label="Start a new study plan" kind="secondary" compact disabled={locked} onPress={() => setConfirming("new-with-prototype")} />
        </View>
      </View> : null}
      <View style={styles.note}>
        <AppIcon name="sparkles" size={17} color={colors.blueDark} />
        <Text style={styles.noteText}>{held
          ? "Research pilot: this builds a study plan on this device, and can start a prototype from what your research found. Sending to the Researcher Agent and Research Hub evidence are paused."
          : kind === "study" && prototypeMode === "new"
          ? "Your answers become an unsent prototype build draft first. When the prototype is ready, return here to finish the study in a private researcher chat."
          : "Your answers and any selected prototype or evidence become an unsent draft in a private researcher chat. Review or edit the prompt before you send it."}</Text>
      </View>

      <Text accessibilityRole="header" style={styles.sectionTitle}>Name the work</Text>
      <View style={styles.field}>
        <Text style={styles.label}>Working title</Text>
        <TextInput value={title} onChangeText={setTitle} editable={!locked && !designGuidanceBusy} accessibilityLabel="Working title" placeholder="A short, recognizable name" placeholderTextColor={colors.muted}
          maxLength={Math.max(20, 80 - task.titlePrefix.length)} autoCapitalize="sentences" autoCorrect style={styles.input} />
      </View>

      {kind === "study" ? <View style={styles.methods}>
        <StudyMethodPicker activities={activities} otherMethods={otherMethods} disabled={locked || designGuidanceBusy}
          onActivities={next => { setActivities(next); setFileNotice(null); }} onOtherMethods={next => { setOtherMethods(next); setFileNotice(null); }} />
      </View> : null}

      <Text accessibilityRole="header" style={styles.sectionTitle}>Build the brief</Text>
      <Text style={styles.sectionDescription}>{held && prototypeMode === "new"
        ? "Required fields are marked. Your written answers will be drafted for the prototype agent, so use only public or made-up information."
        : held
        ? "Required fields are marked. Everything stays on this device unless you save a working draft."
        : kind === "study" && prototypeMode === "new"
        ? "Required fields are marked. Your written answers will be drafted for the prototype agent first, so use only public or made-up information. Raw Research Hub records stay with the restricted Researcher Agent; you can prepare and approve a generalized design brief below."
        : "Required fields are marked. Add only what is safe to share with your workspace's restricted Researcher agent."}</Text>
      {task.fields.map(field => {
        const suppliedByHub = kind === "synthesis" && field.id === "inputs" && evidence.length > 0;
        const required = !!field.required && !suppliedByHub;
        return <View key={field.id} style={styles.field}>
          <Text style={styles.label}>{field.label}{required ? " *" : ""}</Text>
          <TextInput value={answers[field.id] ?? ""} onChangeText={value => update(field.id, value)} editable={!locked && !designGuidanceBusy} accessibilityLabel={`${field.label}${required ? ", required" : ", optional"}`}
            placeholder={suppliedByHub ? "Optional — describe evidence outside Research Hub" : field.placeholder} placeholderTextColor={colors.muted} multiline={field.multiline} textAlignVertical={field.multiline ? "top" : "center"}
            autoCapitalize="sentences" autoCorrect style={[styles.input, field.multiline && styles.multiline]} />
        </View>;
      })}

      {kind === "study" ? <>
        <Text accessibilityRole="header" style={styles.sectionTitle}>Prototype for this study</Text>
        <Text style={styles.sectionDescription}>Optional — use a ready prototype or create one in a private prototype-agent chat before you finish the study plan. The resulting preview is viewable by anyone who has its unguessable link.</Text>
        <PrototypeModeOptions options={PROTOTYPE_OPTIONS} value={prototypeMode} disabled={locked} onChange={choosePrototypeMode} />

        {prototypeMode === "new" ? <View style={styles.prototypeDetail}>
          {createdPrototype ? <>
            <View style={styles.selectedPrototype}>
              <View style={styles.selectedPrototypeIcon}><AppIcon name="brush" size={19} color={colors.blueDark} /></View>
              <View style={styles.selectedPrototypeCopy}>
                <Text style={styles.selectedPrototypeTitle} numberOfLines={2}>{designTitle(createdPrototype)}</Text>
                <Text style={styles.selectedPrototypeMeta} numberOfLines={1}>{designStatus(createdPrototype)} · Prototype agent</Text>
                <Text style={styles.selectedPrototypePreview} numberOfLines={2}>{designStatus(createdPrototype) === "Published" ? "Finished live preview available" : "A finished live preview is required before this study can continue"}</Text>
              </View>
            </View>
            {prototypeBriefChanged ? <View style={styles.prototypeChangeWarning}>
              <AppIcon name="warning" size={17} color={colors.muted} />
              <Text style={styles.prototypeChangeWarningText}>The study details changed after this workspace was created. The existing prototype still reflects the earlier brief.</Text>
            </View> : null}
            {prototypeNotice ? <Text accessibilityLiveRegion="polite" style={styles.prototypeHelp}>{prototypeNotice}</Text> : null}
            {prototypeChecking ? <View style={styles.prototypeChecking}>
              <ActivityIndicator accessibilityLabel="Checking prototype status" accessibilityRole="progressbar" color={colors.blue} />
              <Text style={styles.prototypeHelp}>Checking prototype status…</Text>
            </View> : null}
            <Button label={prototypeBriefChanged ? "Open earlier prototype" : "Open prototype workspace"} kind="secondary" disabled={busy || prototypeChecking} onPress={() => openPrototypeWorkspace(createdPrototype)} />
            {prototypeBriefChanged ? <Button label="Create updated prototype" kind="secondary" disabled={busy || prototypeChecking} onPress={resetCreatedPrototype} /> : null}
            <Button label="Check status" kind="link" compact disabled={busy || prototypeChecking} onPress={() => { void refreshCreatedPrototype(); }} />
          </> : <>
            <Text style={styles.label}>Prototype purpose *</Text>
            <TextInput value={prototypePurpose} onChangeText={value => { setPrototypePurpose(value); setError(null); }} editable={!locked && !designGuidanceBusy} accessibilityLabel="Prototype purpose, required"
              placeholder="What should participants be able to do or react to?" placeholderTextColor={colors.muted} multiline textAlignVertical="top"
              maxLength={1000} autoCapitalize="sentences" autoCorrect style={[styles.input, styles.prototypePurpose]} />
            <Text nativeID="research-findings-label" style={styles.label}>What the research found (optional)</Text>
            <Text nativeID="research-findings-help" style={styles.prototypeHelp}>Summarize findings from any research in general terms: what people need, where they struggle, and what's still unknown. Leave out names, quotes, links, record IDs, dates and numbers. Only what you write here goes to the prototype agent; “What you already know” stays with the study plan.</Text>
            <TextInput value={researchFindings} onChangeText={value => { setResearchFindings(value); setError(null); }} editable={!locked && !designGuidanceBusy}
              accessibilityLabel="What the research found, optional" aria-describedby="research-findings-help"
              placeholder="For example: People weren't sure which recovery option fit their situation." placeholderTextColor={colors.muted} multiline textAlignVertical="top"
              maxLength={MAX_RESEARCH_FINDINGS_CHARS + 200} autoCapitalize="sentences" autoCorrect style={[styles.input, styles.findingsInput]} />
            {/* Always present, so screen readers announce problems as they appear. */}
            <View accessibilityLiveRegion="polite">
              {findingsProblems.length ? <View style={styles.findingsProblems}>
                <AppIcon name="warning" size={17} color={colors.muted} />
                <View style={styles.findingsProblemsCopy}>
                  <Text style={styles.findingsProblemsTitle}>Before this can go to the prototype agent</Text>
                  {findingsProblems.map(problem => <Text key={problem} style={styles.prototypeHelp}>{`\u2022 ${problem}`}</Text>)}
                </View>
              </View> : null}
            </View>
            <Text style={styles.prototypeHelp}>{held
              ? "Servant turns the study brief and your findings into an unsent prompt for the prototype agent, including the minimum testable interactions, realistic states, accessibility needs and safe test data. With findings, the agent suggests a few directions first and builds the one you choose."
              : "Servant will turn the study brief into an unsent prompt for the prototype agent, including the minimum testable interactions, realistic states, accessibility needs, safe test data, your findings, and any research-informed guidance you approve below. With findings or approved guidance, the agent suggests directions first and builds after you choose."}</Text>
            <Button label={showBuildPrompt ? "Hide the build prompt" : "Show the build prompt"} kind="secondary" compact
              accessibilityHint="Shows exactly what will go to the prototype agent. Nothing is sent."
              disabled={!prototypePurpose.trim() || findingsProblems.length > 0} onPress={() => setShowBuildPrompt(value => !value)} />
            {showBuildPrompt && prototypePurpose.trim() && !findingsProblems.length ? <View style={styles.buildPrompt}>
              <Text style={styles.findingsProblemsTitle}>The build prompt, exactly as it will go to the prototype agent</Text>
              <Text selectable style={styles.buildPromptText}>{buildStudyPrototypePrompt(prototypeBuildBrief())}</Text>
            </View> : null}
            {prototypeNotice ? <Text accessibilityLiveRegion="polite" style={styles.prototypeHelp}>{prototypeNotice}</Text> : null}
          </>}
        </View> : prototypeMode === "existing" ? <View style={styles.prototypeDetail}>
          {selectedPrototype ? <View style={styles.selectedPrototype}>
            <View style={styles.selectedPrototypeIcon}><AppIcon name="brush" size={19} color={colors.blueDark} /></View>
            <View style={styles.selectedPrototypeCopy}>
              <Text style={styles.selectedPrototypeTitle} numberOfLines={2}>{designTitle(selectedPrototype)}</Text>
              <Text style={styles.selectedPrototypeMeta} numberOfLines={1}>{designStatus(selectedPrototype)} · {selectedPrototype.author?.name || "Your prototype"}</Text>
              <Text style={styles.selectedPrototypePreview} numberOfLines={1}>Live preview available</Text>
            </View>
          </View> : <Text accessibilityLiveRegion="polite" style={styles.prototypeHelp}>Choose one active prototype with a live preview. Draft, building, and archived designs are left out.</Text>}
          {prototypeNotice ? <Text accessibilityLiveRegion="polite" style={styles.prototypeReadyNotice}>{prototypeNotice}</Text> : null}
          {createdPrototype && selectedPrototype?.id === createdPrototype.id && prototypeBriefChanged ? <>
            <View style={styles.prototypeChangeWarning}>
              <AppIcon name="warning" size={17} color={colors.muted} />
              <Text style={styles.prototypeChangeWarningText}>The selected prototype reflects an earlier version of this study brief.</Text>
            </View>
            <Button label="Create updated prototype" kind="secondary" disabled={locked} onPress={resetCreatedPrototype} />
          </> : null}
          <Button label={selectedPrototype ? "Change prototype" : "Choose prototype"} kind="secondary" disabled={locked} onPress={() => setPrototypeOpen(true)} />
        </View> : null}
      </> : null}

      {kind === "study" ? <View style={styles.activities}>
        <StudyActivities activities={activities} setup={studySetup} disabled={locked || designGuidanceBusy}
          studyPrototype={draftPrototype.mode === "existing" && selectedPrototype && draftPrototype.url ? { title: designTitle(selectedPrototype), url: draftPrototype.url } : null}
          onActivities={next => { setActivities(next); setFileNotice(null); }} onSetup={next => { setStudySetup(next); setFileNotice(null); }}
          otherMethods={otherMethods} onOtherMethods={next => { setOtherMethods(next); setFileNotice(null); }} />
        <View style={styles.studioFile}>
          <Text accessibilityRole="header" style={styles.label}>Working draft for Research Studio</Text>
          <Text style={styles.prototypeHelp}>Save a working draft (study and plan) to open with Import JSON in Civic Research Studio {SUPPORTED_RESEARCH_STUDIO_VERSION}'s builder. It's a draft to keep refining, not a finished or reviewed plan. It's made on this device from this form only and includes no Research Hub records. A chosen prototype is checked again just before saving. Write the welcome and consent text in Research Studio.</Text>
          <DraftChecklist problems={fileProblems} saveLabel="Save working draft" busy={savingFile} disabled={locked} notice={fileNotice} onSave={() => { void saveStudioFile(); }} />
        </View>
      </View> : null}

      {!held ? <>
      <Text accessibilityRole="header" style={styles.sectionTitle}>Research Hub evidence</Text>
      <Text style={styles.sectionDescription}>{kind === "study"
        ? prototypeMode === "new"
          ? "Optional — add prior evidence to sharpen the study gap and avoid duplicating known work. Selected sources can also become needs and pain points for prototype suggestions."
          : "Optional — add prior evidence to sharpen the study gap and avoid duplicating known work."
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
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${item.title}`} accessibilityState={{ disabled: busy }} disabled={locked}
            hitSlop={10} onPress={() => { setEvidence(currentEvidence => currentEvidence.filter(selected => selected.id !== item.id)); setError(null); }} style={styles.removeEvidence}>
            <AppIcon name="close" size={16} color={colors.muted} />
          </Pressable>
        </View>)}
        {evidence.length > 1 ? <Button label="Remove all evidence" kind="link" compact disabled={locked} onPress={() => { setEvidence([]); setError(null); }} style={styles.clearEvidence} /> : null}
      </View> : null}

      {hubState.kind === "checking" ? <View style={styles.hubStatus}>
        <ActivityIndicator accessibilityLabel="Checking Research Hub availability" accessibilityRole="progressbar" color={colors.blue} />
        <Text style={styles.hubStatusText}>Checking Research Hub…</Text>
      </View> : hubState.kind === "available" ? <View style={styles.hubAvailable}>
        <Button label={evidence.length ? "Change evidence selection" : "Choose Research Hub evidence"} kind="secondary" disabled={locked} onPress={() => setEvidenceOpen(true)} />
        <Text style={styles.hubMeta}>{hubState.hub.recordCount} {hubState.hub.recordCount === 1 ? "record" : "records"} · Generated {shortHubDate(hubState.hub.generatedAt)} · Review by {shortHubDate(hubState.hub.reviewBy)}</Text>
      </View> : <View style={styles.hubNotice}>
        <AppIcon name={hubState.kind === "forbidden" ? "lock" : "warning"} size={18} color={hubState.kind === "error" ? colors.red : colors.muted} />
        <View style={styles.hubNoticeCopy}>
          <Text accessibilityRole={hubState.kind === "error" ? "alert" : undefined} style={styles.hubNoticeText}>{hubState.message}</Text>
          <Button compact label={hubState.kind === "error" ? "Try again" : "Check again"} kind="secondary" disabled={locked} onPress={() => setHubAttempt(value => value + 1)} style={styles.hubRetry} />
        </View>
      </View>}

      {kind === "study" && prototypeMode === "new" && (evidence.length > 0 || !!designGuidanceText) ? <View style={styles.designGuidance}>
        <View style={styles.designGuidanceHeading}>
          <View style={styles.designGuidanceIcon}><AppIcon name="sparkles" size={18} color={colors.blueDark} /></View>
          <View style={styles.designGuidanceHeadingCopy}>
            <Text accessibilityRole="header" style={styles.designGuidanceTitle}>Research-informed design guidance</Text>
            <Text style={styles.designGuidanceDescription}>The restricted Researcher Agent drafts generalized needs, pain points, opportunities, and evidence limits. Raw records and citations stay out of the Prototype Agent.</Text>
          </View>
        </View>
        {designGuidanceBusy ? <View accessibilityLiveRegion="polite" style={styles.designGuidanceStatusRow}>
          <ActivityIndicator accessibilityLabel="Preparing research-informed design guidance" accessibilityRole="progressbar" color={colors.blue} />
          <Text style={styles.designGuidanceStatus}>Preparing needs and pain points…</Text>
        </View> : designGuidanceText ? <>
          <Text accessibilityLiveRegion="polite" style={[styles.designGuidanceStatus, designGuidanceApproved && !designGuidanceStale && styles.designGuidanceStatusApproved]}>
            {designGuidanceStale ? "Needs refresh — the study, evidence, or Hub snapshot changed."
              : designGuidanceApproved ? "Approved for the Prototype Agent"
                : "Ready for your review"}
          </Text>
          <TextInput value={designGuidanceText} editable={!locked && !designGuidanceBusy} onChangeText={value => {
            setDesignGuidanceText(value);
            setDesignGuidanceApproved(false);
            setDesignGuidanceError(null);
          }} accessibilityLabel="Research-informed design guidance to review before sharing with the Prototype Agent"
            multiline textAlignVertical="top" maxLength={6000} autoCapitalize="sentences" autoCorrect
            style={[styles.input, styles.designGuidanceInput]} />
          <Text style={styles.designGuidanceMeta}>{designGuidanceStale
            ? `Prepared from ${designGuidanceSourceCount} Hub ${designGuidanceSourceCount === 1 ? "source" : "sources"}; the current selection has ${evidence.length}. Refresh before using it.`
            : `Based on ${designGuidanceSourceCount} selected Hub ${designGuidanceSourceCount === 1 ? "source" : "sources"}.`} This AI-generated draft is not automatically cleared for sharing. Remove identifying, restricted, or source-specific details before approving. It is design context, not proof that a direction is validated.</Text>
          {!designGuidanceStale && !designGuidanceApproved ? <Button label="Use in prototype" kind="secondary" accessibilityHint="Shares only this reviewed text with the separate Prototype Agent" disabled={!designGuidanceText.trim() || busy} onPress={() => {
            setDesignGuidanceApproved(true);
            setDesignGuidanceError(null);
          }} /> : null}
          <Button label={designGuidanceStale ? "Refresh needs & pain points" : "Regenerate guidance"} kind="secondary" disabled={locked} onPress={() => { void prepareDesignGuidance(); }} />
          <Button label="Continue without Hub insights" kind="link" compact disabled={locked} onPress={discardDesignGuidance} />
        </> : <>
          <Text style={styles.designGuidanceMeta}>Review the generated handoff before deciding whether it is safe and useful to share with the Prototype Agent.</Text>
          <Button label="Prepare needs & pain points" kind="secondary" disabled={locked} onPress={() => { void prepareDesignGuidance(); }} />
        </>}
        {designGuidanceError ? <Text accessibilityRole="alert" style={styles.designGuidanceError}>{designGuidanceError}</Text> : null}
      </View> : null}
      </> : null}

      {kind === "design-review" && evidence.length === 0 ? <View style={styles.gapWarning}>
        <AppIcon name="warning" size={17} color={colors.muted} />
        <Text style={styles.gapWarningText}>No Hub evidence is selected. The draft will identify this as an evidence gap and limit conclusions to expert inspection.</Text>
      </View> : null}

      {!canSend ? <View style={styles.boundary}>
        <Text style={styles.boundaryTitle}>Paused for the research pilot</Text>
        <Text style={styles.boundaryBody}>This plan isn't sent to the Researcher Agent during the pilot. Save a working draft above to keep working on it in Civic Research Studio.</Text>
      </View> : null}
      {canSend ? <><View style={styles.boundary}>
        <Text style={styles.boundaryTitle}>What happens next</Text>
        <Text style={styles.boundaryBody}>{kind === "study" && prototypeMode === "new"
          ? createdPrototype
            ? held
              ? "Continue in the private prototype-agent chat. When it publishes a finished preview, Servant will select it here so you can add it to the working draft. The preview itself is viewable by anyone with its unguessable link. Nothing is sent or used to contact participants automatically."
              : "Continue in the private prototype-agent chat. When it publishes a finished preview, Servant will select it here so you can finish the study plan. The preview itself is viewable by anyone with its unguessable link. Nothing is sent or used to contact participants automatically."
            : held
            ? "Servant creates a private prototype-agent chat and places a build prompt from your written answers and findings in its composer. Nothing is sent until you review it and choose Send. The built preview will be viewable by anyone with its unguessable link."
            : "Servant creates a private prototype-agent chat and places a structured build prompt from your written answers in its composer. Raw Research Hub records stay out; only generalized design guidance you review and approve is included. When Hub guidance is included, the server binds it to that exact prompt; return here to revise it instead of editing the prompt. The built preview will be viewable by anyone with its unguessable link."
          : `Servant verifies selected evidence${kind === "study" && prototypeMode === "existing" ? " and the prototype" : ""} again, creates an ordinary titled researcher chat, and places a structured prompt in its composer. Nothing is sent, shared, published, or used to contact participants until you choose what to do next.`}</Text>
      </View>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <Button label={kind === "study" && prototypeMode === "new"
        ? createdPrototype ? prototypeBriefChanged ? "Start updated prototype" : "Open prototype workspace" : "Create prototype workspace"
        : "Review in researcher chat"} busy={busy || designGuidanceBusy} onPress={() => { void create(); }} style={styles.primary} /></> : null}
      {/* The form is saved as you go, so leaving keeps it ("Cancel" would suggest it doesn't). */}
      <Button label="Back to Research Studio" kind="link" disabled={locked} onPress={() => router.replace("/research")} />
    </ScrollView>
    {evidenceOpen && hubState.kind === "available" ? <ResearchEvidencePicker hub={hubState.hub} selected={evidence} onHubMetadata={acceptHubMetadata} onHubFailure={setHubState}
      onApply={items => { setEvidence(items); setEvidenceOpen(false); setError(null); }} onClose={() => setEvidenceOpen(false)} /> : null}
    <ConfirmDialog visible={confirming !== null}
      title={confirming === "new-with-prototype" ? "Start a new study plan?" : "Start over?"}
      confirmLabel={confirming === "new-with-prototype" ? "Start a new study plan" : "Start over"}
      description={`${confirming === "new-with-prototype" ? `This clears your answers to “${title.trim() || "Untitled study plan"}” on this device and starts a new plan with ${prototypeOffer ? designTitle(prototypeOffer) : "this prototype"}.` : "This clears your answers on this device."} Prototypes you created stay in Design Studio, and working drafts you saved aren't affected.`}
      onConfirm={() => {
        const offer = confirming === "new-with-prototype" ? prototypeOffer : null;
        startOver();
        if (offer) chooseStudyPrototype(offer);
      }} onCancel={() => setConfirming(null)} />
    {prototypeOpen && kind === "study" ? <ExistingPrototypePicker selected={selectedPrototype} onUnavailable={clearSelectedPrototype}
      onApply={design => { setSelectedPrototype(design); setPrototypeMode("existing"); setPrototypeOpen(false); setError(null); }} onClose={() => setPrototypeOpen(false)} /> : null}
  </View>;
}

function ExistingPrototypePicker({ selected, onUnavailable, onApply, onClose }: {
  selected: Chat | null;
  onUnavailable: () => void;
  onApply: (design: Chat) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account, setAccount } = useSession();
  const insets = useSafeAreaInsets();
  const [designs, setDesigns] = useState<Chat[] | null>(null);
  const [picked, setPicked] = useState<Chat | null>(selected);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const pickerRadios = useRadioGroup({ values: (designs ?? []).map(design => design.id), value: picked?.id ?? null, label: "Available prototypes",
    onChange: id => { const design = designs?.find(item => item.id === id); if (design) { setPicked(design); setSelectionNotice(null); } } });

  useEffect(() => {
    if (!account) return;
    let active = true;
    setDesigns(null);
    setLoadError(null);
    api.orgChats(account, setAccount).then(result => {
      if (!active) return;
      const available = studyPrototypeChats(result.mine, result.others);
      setDesigns(available);
      if (selected) {
        const current = available.find(item => item.id === selected.id);
        if (current) setPicked(current);
        else {
          onUnavailable();
          setSelectionNotice("The earlier prototype is no longer ready or available, so the selection was cleared.");
          setPicked(null);
        }
      }
    }).catch(e => {
      if (!active) return;
      setDesigns([]);
      setLoadError(e instanceof ServerError ? e.message : "Couldn't load Design Studio prototypes.");
    });
    return () => { active = false; };
  }, [account, loadAttempt, onUnavailable, selected, setAccount]);

  if (!account) return null;
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <KeyboardAvoidingView style={styles.pickerKeyboard} behavior={Platform.OS === "ios" ? "padding" : Platform.OS === "android" ? "height" : undefined}>
      <View style={[styles.pickerOverlay, { paddingTop: insets.top + space.side, paddingBottom: insets.bottom + space.side }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close prototype picker" style={StyleSheet.absoluteFill} onPress={onClose} />
        <View accessibilityViewIsModal testID="research-prototype-picker" style={styles.pickerCard}>
          <View style={styles.pickerHeader}>
            <View style={styles.pickerHeadingCopy}>
              <Text accessibilityRole="header" style={styles.pickerTitle}>Choose an existing prototype</Text>
              <Text style={styles.pickerSubtitle}>Choose from published Design Studio prototypes. Confirm participant readiness in the study plan.</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" hitSlop={12} onPress={onClose}>
              <AppIcon name="close" size={18} color={colors.muted} />
            </Pressable>
          </View>

          {selectionNotice ? <Text accessibilityRole="alert" style={styles.pickerRevisionNotice}>{selectionNotice}</Text> : null}
          <ScrollView style={styles.prototypePickerResults} contentContainerStyle={styles.pickerResultsContent} keyboardShouldPersistTaps="handled">
            {designs === null && !loadError ? <View style={styles.pickerLoading}>
              <ActivityIndicator accessibilityLabel="Loading prototypes" accessibilityRole="progressbar" color={colors.blue} />
              <Text style={styles.pickerLoadingText}>Loading prototypes…</Text>
            </View> : loadError ? <View style={styles.pickerEmpty}>
              <Text accessibilityRole="alert" style={styles.pickerError}>{loadError}</Text>
              <Button label="Try again" kind="secondary" compact onPress={() => setLoadAttempt(value => value + 1)} style={styles.pickerRetry} />
            </View> : !designs?.length ? <View style={styles.pickerEmpty}>
              <View style={styles.prototypeEmptyIcon}><AppIcon name="brush" size={24} color={colors.blueDark} /></View>
              <Text style={styles.pickerEmptyText}>No published prototypes are available. Choose “Create a new prototype” to open a prototype-agent workspace for this study.</Text>
            </View> : <View {...pickerRadios.group}>
              {designs.map((design, index) => {
              const checked = picked?.id === design.id;
              const author = design.author?.name ? ` · by ${design.author.name}` : " · yours";
              return <Pressable key={design.id} {...pickerRadios.radio(design.id, index)}
                accessibilityLabel={`${designTitle(design)}. Published${author}. Live preview available.`}
                style={({ pressed }) => [styles.prototypePickerRow, checked && styles.pickerRowSelected, pressed && styles.pickerRowPressed]}>
                <View style={styles.selectedPrototypeIcon}><AppIcon name="brush" size={19} color={colors.blueDark} /></View>
                <View style={styles.pickerRowCopy}>
                  <Text style={styles.pickerRowTitle}>{designTitle(design)}</Text>
                  <Text style={styles.pickerRowMeta}>Published{author}</Text>
                  <Text style={styles.prototypeLive}>Live preview available</Text>
                </View>
                <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.prototypeRadio, checked && styles.prototypeRadioSelected]}>
                  {checked ? <View style={styles.prototypeRadioDot} /> : null}
                </View>
              </Pressable>;
              })}
            </View>}
          </ScrollView>

          <View style={styles.pickerFooter}>
            <Button label="Use this prototype" disabled={!picked || !!loadError || designs === null} onPress={() => { if (picked) onApply(picked); }} style={styles.pickerApply} />
            <Button label="Cancel" kind="link" onPress={onClose} />
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
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
  draftStatus: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.xs, marginHorizontal: space.side, marginBottom: space.sm },
  draftStatusText: { ...typography.caption, color: colors.muted, flexShrink: 1, flexGrow: 1, flexBasis: 200 },
  offer: { gap: space.xs, marginHorizontal: space.side, marginBottom: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surface },
  offerTitle: { ...typography.bodyStrong, color: colors.ink },
  offerBody: { ...typography.caption, color: colors.ink },
  offerActions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.xs },
  noteText: { ...typography.caption, color: colors.ink, flex: 1 },
  sectionTitle: { ...typography.heading, color: colors.ink, marginTop: space.lg, marginHorizontal: space.side },
  sectionDescription: { ...typography.caption, color: colors.muted, marginTop: space.xxs, marginHorizontal: space.side, marginBottom: space.sm },
  field: { gap: space.xs, marginTop: space.md, marginHorizontal: space.side },
  label: { ...typography.bodyStrong, color: colors.ink },
  input: { ...typography.body, minHeight: 48, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, color: colors.ink, backgroundColor: colors.background },
  multiline: { minHeight: 104 },
  prototypeRadio: { width: 22, height: 22, borderRadius: radius.pill, borderWidth: 2, borderColor: colors.muted, alignItems: "center", justifyContent: "center", marginTop: 1 },
  prototypeRadioSelected: { borderColor: colors.blue },
  prototypeRadioDot: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: colors.blue },
  prototypeDetail: { gap: space.sm, marginHorizontal: space.side, marginTop: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface },
  prototypePurpose: { minHeight: 88 },
  findingsInput: { minHeight: 168 },
  buildPrompt: { gap: space.xs, padding: space.sm, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.background },
  buildPromptText: { ...typography.meta, color: colors.ink, fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) },
  findingsProblems: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, padding: space.sm, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.background },
  findingsProblemsCopy: { flex: 1, gap: 2 },
  findingsProblemsTitle: { ...typography.captionStrong, color: colors.ink },
  prototypeHelp: { ...typography.caption, color: colors.muted },
  activities: { marginTop: space.lg, marginHorizontal: space.side, gap: space.md },
  methods: { marginTop: space.lg, marginHorizontal: space.side },
  studioFile: { gap: space.xs, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  prototypeChecking: { flexDirection: "row", alignItems: "center", gap: space.sm },
  prototypeReadyNotice: { ...typography.captionStrong, color: colors.blueDark, padding: space.sm, borderRadius: radius.sm, backgroundColor: colors.blueSoft },
  prototypeChangeWarning: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, padding: space.sm, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.background },
  prototypeChangeWarningText: { ...typography.caption, color: colors.ink, flex: 1 },
  selectedPrototype: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: space.sm },
  selectedPrototypeIcon: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.blueSoft },
  selectedPrototypeCopy: { flex: 1, minWidth: 0 },
  selectedPrototypeTitle: { ...typography.bodyStrong, color: colors.ink },
  selectedPrototypeMeta: { ...typography.meta, color: colors.muted, marginTop: 2 },
  selectedPrototypePreview: { ...typography.meta, color: colors.blueDark, marginTop: 2 },
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
  designGuidance: { gap: space.sm, marginHorizontal: space.side, marginTop: space.md, padding: space.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surface },
  designGuidanceHeading: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  designGuidanceIcon: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.blueSoft },
  designGuidanceHeadingCopy: { flex: 1, minWidth: 0 },
  designGuidanceTitle: { ...typography.bodyStrong, color: colors.ink },
  designGuidanceDescription: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  designGuidanceStatusRow: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: space.sm },
  designGuidanceStatus: { ...typography.captionStrong, color: colors.ink },
  designGuidanceStatusApproved: { color: colors.blueDark },
  designGuidanceInput: { minHeight: 240 },
  designGuidanceMeta: { ...typography.caption, color: colors.muted },
  designGuidanceError: { ...typography.caption, color: colors.red },
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
  prototypePickerResults: { flexShrink: 1, minHeight: 220, marginTop: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  pickerResultsContent: { flexGrow: 1, paddingVertical: space.xs },
  pickerLoading: { flex: 1, minHeight: 180, alignItems: "center", justifyContent: "center", gap: space.sm },
  pickerLoadingText: { ...typography.caption, color: colors.muted },
  pickerEmpty: { flex: 1, minHeight: 180, alignItems: "center", justifyContent: "center", padding: space.lg },
  pickerEmptyText: { ...typography.body, color: colors.muted, textAlign: "center" },
  pickerError: { ...typography.body, color: colors.red, textAlign: "center" },
  pickerRetry: { minWidth: 120, marginTop: space.md },
  pickerRow: { minHeight: 112, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.sm, paddingVertical: space.sm, borderRadius: radius.md },
  prototypePickerRow: { minHeight: 80, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.sm, paddingVertical: space.sm, borderRadius: radius.md },
  pickerRowSelected: { backgroundColor: colors.blueSoft },
  pickerRowDisabled: { opacity: 0.5 },
  pickerRowPressed: { backgroundColor: colors.surface },
  pickerRowCopy: { flex: 1, minWidth: 0 },
  pickerRowTitle: { ...typography.bodyStrong, color: colors.ink },
  pickerRowMeta: { ...typography.meta, color: colors.muted, marginTop: 2 },
  pickerRowSummary: { ...typography.caption, color: colors.ink, marginTop: space.xxs },
  pickerRowMetric: { ...typography.meta, color: colors.muted, marginTop: space.xxs },
  prototypeLive: { ...typography.meta, color: colors.blueDark, marginTop: space.xxs },
  prototypeEmptyIcon: { width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: colors.blueSoft, marginBottom: space.sm },
  pickerCheck: { width: 24, height: 24, borderRadius: 4, borderWidth: 1.5, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  pickerCheckOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  pickerFooter: { paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  pickerApply: { width: "100%" },
}));
