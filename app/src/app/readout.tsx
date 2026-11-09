import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, Stack } from "expo-router";
import { AppIcon } from "../components/AppIcon";
import { PageTitle } from "../components/Band";
import { Button } from "../components/Button";
import { CommentCoding } from "../components/CommentCoding";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DraftChecklist } from "../components/DraftChecklist";
import { GrowingTextInput } from "../components/GrowingTextInput";
import { checkboxKeys } from "../components/useRadioGroup";
import { DifferenceChart, QuestionChart, RatesChart, TimesChart } from "../components/ReadoutCharts";
import { clearFormDraft, formDraftKey, readFormDraft, writeFormDraft } from "../lib/form-drafts";
import { pickTextFile } from "../lib/pick-text-file";
import { EMPTY_CODING, themeCounts, type Coding, type Comment } from "../lib/readout-answers";
import { clearReadoutSession, keepReadoutSession, readoutSession } from "../lib/readout-session";
import {
  draftedPart,
  draftReadout,
  hiddenDesign,
  measureName,
  parseReadoutDraft,
  READOUT_SECTIONS,
  readoutDocx,
  SMALL_GROUP_MIN,
  readoutFileName,
  readoutHtml,
  readoutProblems,
  readoutResults,
  readStudyFile,
  updateReadout,
  type Drafted,
  type Readout,
  type ReadoutDraft,
  type ReadoutResults,
  type ReadoutStudy,
  type StaleField,
} from "../lib/readout";
import { saveTextFile } from "../lib/save-text-file";
import { api } from "../lib/server";
import { useSession } from "../lib/session";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";
import { whenInSentence } from "../lib/time-label";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
type Picked = { name: string; text: string };

// A study readout: a Civic Research Studio A/B study's Qualtrics results, read on
// this device, as charts and a report the researcher writes and checks. Only
// totals and the text are kept (on this device); the exports stay in memory
// while the page is open.
export default function ReadoutScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const [agentTier, setAgentTier] = useState<number | null | undefined>(undefined);
  // Files and comments loaded earlier in this app session, if the page was redrawn (e.g. a layout change).
  const [loaded] = useState(() => readoutSession(account ? formDraftKey(account, "readout") : null));
  const [study, setStudy] = useState<ReadoutStudy | null>(null);
  const [studyName, setStudyName] = useState("");
  const [survey2, setSurvey2] = useState<Picked | null>(loaded?.survey2 ?? null);
  const [survey1, setSurvey1] = useState<Picked | null>(loaded?.survey1 ?? null);
  // Qualtrics previews and test responses are left out unless the person asks for a practice run.
  const [includePreviews, setIncludePreviews] = useState(loaded?.includePreviews ?? false);
  const [previewsOnly, setPreviewsOnly] = useState(false);
  const [fileNames, setFileNames] = useState<{ survey2: string; survey1: string | null } | null>(null);
  const [results, setResults] = useState<ReadoutResults | null>(null);
  const [readout, setReadout] = useState<Readout | null>(null);
  // The drafted sections as last drafted (to tell edits from the draft), and edited ones written against earlier results.
  const [drafted, setDrafted] = useState<Drafted | null>(null);
  const [stale, setStale] = useState<StaleField[]>([]);
  // Written comments: in memory only, while the export is loaded. The coding is what's kept.
  const [comments, setComments] = useState<Comment[] | null>(loaded?.comments ?? null);
  const [coding, setCoding] = useState<Coding>(EMPTY_CODING);
  const [problems, setProblems] = useState<string[]>([]);
  const [studyProblem, setStudyProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<null | "start-over" | "redraft">(null);
  const [hydrated, setHydrated] = useState(false);
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const draftKey = account ? formDraftKey(account, "readout") : null;
  const pending = useRef<ReadoutDraft | null>(null);
  // Kept in memory (never saved) so a redraw of the page keeps the loaded files and comments.
  useEffect(() => { keepReadoutSession(draftKey, { survey2, survey1, includePreviews, comments }); }, [draftKey, survey2, survey1, includePreviews, comments]);

  useEffect(() => {
    if (!account) return;
    let active = true;
    api.projects(account).then(result => { if (active) setAgentTier(typeof result.agentTier === "number" ? result.agentTier : null); })
      .catch(() => { if (active) setAgentTier(null); });
    return () => { active = false; };
  }, [account]);

  // Put back a saved readout: the study, the totals and the text (the exports aren't kept).
  useEffect(() => {
    if (!draftKey || agentTier !== 4 || hydrated) return;
    let active = true;
    void readFormDraft(draftKey).catch(() => null).then(saved => {
      if (!active) return;
      const draft = saved ? parseReadoutDraft(saved.value) : null;
      const read = draft ? readStudyFile(JSON.stringify(draft.study)) : null;
      if (saved && draft && read && "study" in read) {
        setStudy(read.study);
        setStudyName(draft.studyName);
        setFileNames(draft.files);
        setResults(draft.results);
        setReadout(draft.readout);
        setDrafted(draft.drafted ?? null);
        setStale(draft.stale ?? []);
        setCoding(draft.coding ?? EMPTY_CODING);
        setRestoredAt(saved.savedAt);
        setSavedAt(saved.savedAt);
      }
      setHydrated(true);
    });
    return () => { active = false; };
  }, [draftKey, agentTier, hydrated]);

  // Saved as it changes (shortly after typing stops) and right away when leaving or closing the page.
  useEffect(() => {
    if (!hydrated || !draftKey) return;
    if (!study || !results || !readout || !fileNames) { pending.current = null; return; }
    const draft: ReadoutDraft = { version: 1, studyName, study: study.source, files: fileNames, results, readout, coding, ...(drafted ? { drafted } : {}), stale };
    pending.current = draft;
    const timer = setTimeout(() => {
      pending.current = null;
      const at = Date.now();
      void writeFormDraft(draftKey, draft, at).then(() => setSavedAt(at)).catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [hydrated, draftKey, study, studyName, fileNames, results, readout, coding, drafted, stale]);
  useEffect(() => {
    const flush = () => {
      const draft = pending.current;
      if (!draft || !draftKey) return;
      pending.current = null;
      void writeFormDraft(draftKey, draft).catch(() => {});
    };
    const web = Platform.OS === "web" && typeof window !== "undefined";
    if (web) { window.addEventListener("pagehide", flush); window.addEventListener("beforeunload", flush); }
    return () => {
      if (web) { window.removeEventListener("pagehide", flush); window.removeEventListener("beforeunload", flush); }
      flush();
    };
  }, [draftKey]);

  // Kept stable between keystrokes, so typing in the readout doesn't redraw the charts and comments.
  const hiddenIds = useMemo(() => results ? [...new Set(results.activities.flatMap(a => a.designs.map(d => d.id)))].filter(hiddenDesign(results)) : [], [results]);
  const commentQuestions = useMemo(() => (results?.commentQuestions ?? []).filter(q => q.designs.some(d => d.n)), [results]);
  const taskTitle = useCallback((taskId: string | null) => results?.activities.find(a => a.id === taskId)?.title ?? "After the tasks", [results]);
  // A change to the coding: counts follow the loaded comments, or keep what was saved for themes that remain.
  const changeCoding = useCallback((next: Coding) => setCoding(comments
    ? { ...next, counts: themeCounts(next, comments) }
    : { ...next, counts: next.counts.filter(c => next.themes.some(t => t.id === c.themeId)) }), [comments]);

  if (!account) return null;
  if (Platform.OS !== "web") return <Unavailable text="Study readouts work in a browser and the Mac app for now." />;
  if (agentTier === undefined) return <View style={styles.loading}><ActivityIndicator accessibilityLabel="Checking Researcher access" color={colors.blue} /></View>;
  if (agentTier !== 4) return <Unavailable text="Study readouts need the Researcher agent tier. Ask a workspace owner to grant it." />;

  const chooseStudy = async () => {
    setNotice(null);
    const file = await pickTextFile(["application/json", ".json"]).catch(() => null);
    if (!file) return;
    const read = readStudyFile(file.text);
    if ("problem" in read) { setStudyProblem(read.problem); return; }
    setStudyProblem(null);
    setStudy(read.study);
    setStudyName(file.name);
    // Results belong to a study: choosing another one starts its results again.
    if (results && results.studyId !== read.study.id) { setResults(null); setReadout(null); setDrafted(null); setStale([]); setFileNames(null); setComments(null); setCoding(EMPTY_CODING); }
    setProblems([]);
  };
  const chooseExport = async (which: 2 | 1) => {
    setNotice(null);
    const file = await pickTextFile(["text/csv", ".csv", "text/plain"]).catch(() => null);
    if (!file) return;
    if (which === 2) setSurvey2(file); else setSurvey1(file);
    setProblems([]);
  };
  const showResults = async () => {
    if (!study || !survey2 || busy) return;
    setBusy(true);
    setProblems([]);
    try {
      const r = await readoutResults(study, survey2.text, survey1?.text ?? "", { includePreviews });
      if ("problems" in r) { setProblems(r.problems); setPreviewsOnly(!!r.previewsOnly); return; }
      setPreviewsOnly(false);
      setComments(r.comments);
      // Counts follow the comments now loaded; codes for comments that aren't in this export don't count.
      setCoding(current => ({ ...current, counts: themeCounts(current, r.comments) }));
      const names = { survey2: survey2.name, survey1: survey1?.name ?? null };
      setFileNames(names);
      const fresh = draftReadout(study, r.results);
      if (!readout) {
        setReadout(fresh); setDrafted(draftedPart(fresh)); setStale([]);
      } else {
        // Sections still as drafted follow the new results; edited ones are kept, and flagged when the numbers changed.
        const changed = !results || JSON.stringify({ ...results, warnings: [] }) !== JSON.stringify({ ...r.results, warnings: [] });
        const next = updateReadout(readout, drafted, fresh, { resultsChanged: changed, stale });
        setReadout(next.readout); setDrafted(next.drafted); setStale(next.stale);
      }
      setResults(r.results);
    } catch (e) {
      setProblems([e instanceof Error ? `These files couldn't be read: ${e.message}` : "These files couldn't be read."]);
    } finally {
      setBusy(false);
    }
  };
  const redraft = () => {
    if (!study || !results || !readout) return;
    const fresh = draftReadout(study, results);
    setReadout({ ...readout, findings: fresh.findings, limitations: fresh.limitations });
    setDrafted(current => ({ ...(current ?? draftedPart(readout)), findings: fresh.findings, limitations: fresh.limitations }));
    setStale(current => current.filter(f => f !== "findings" && f !== "limitations"));
    setConfirming(null);
  };
  const startOver = () => {
    if (draftKey) void clearFormDraft(draftKey).catch(() => {});
    clearReadoutSession();
    pending.current = null;
    setStudy(null); setStudyName(""); setSurvey1(null); setSurvey2(null); setFileNames(null);
    setResults(null); setReadout(null); setDrafted(null); setStale([]); setProblems([]); setStudyProblem(null); setNotice(null);
    setComments(null); setCoding(EMPTY_CODING);
    setRestoredAt(null); setSavedAt(null); setConfirming(null);
  };
  const shareProblems = readout && results ? readoutProblems(readout, results, coding, stale) : [];
  const saveWord = async () => {
    if (!readout || !results || shareProblems.length || saving) return;
    setSaving(true);
    try {
      const name = readoutFileName(readout.title);
      await saveTextFile(name, readoutDocx(readout, results, { author: account.user.name, coding }), DOCX);
      setNotice(`Saved ${name}.`);
    } catch (e) {
      setNotice(e instanceof Error ? `Couldn't save the document: ${e.message}` : "Couldn't save the document.");
    } finally {
      setSaving(false);
    }
  };
  // The PDF: the readout as a printable page, printed from a hidden frame so the
  // person can choose Save as PDF (or a printer) in their print window.
  const printPdf = () => {
    if (!readout || !results || shareProblems.length) return;
    const html = readoutHtml(readout, results, { author: account.user.name, coding });
    try {
      document.querySelectorAll("iframe[data-readout-print]").forEach(old => old.remove());
      const frame = document.createElement("iframe");
      frame.setAttribute("data-readout-print", "");
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("title", "Readout for printing");
      frame.tabIndex = -1;
      frame.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0";
      frame.onload = () => {
        const view = frame.contentWindow;
        if (!view) return;
        view.focus();
        view.print();
      };
      frame.srcdoc = html;
      document.body.appendChild(frame);
      setNotice("In the print window, choose Save as PDF to save the readout as a PDF.");
    } catch {
      // No print window here: save the printable page instead.
      void saveTextFile(readoutFileName(readout.title, "html"), html, "text/html")
        .then(() => setNotice("Saved the readout as a web page. Open it and print it to make a PDF."))
        .catch(() => setNotice("Couldn't open a print window."));
    }
  };
  const smallGroups = !!results && results.activities.some(a => a.designs.some(d => d.assigned < SMALL_GROUP_MIN));
  const questions = results?.questions ?? [];
  const general = questions.filter(q => q.taskId === null && q.designs.some(d => d.n));
  const edit = (field: keyof Readout, value: string) => setReadout(current => current ? { ...current, [field]: value } : current);
  const exportsMissing = !!results && !survey2;

  return <View style={styles.root}>
    <Stack.Screen options={{ title: "Study readout" }} />
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <PageTitle description="Turn a Civic Research Studio A/B study's Qualtrics results into a readout you can check and share.">Write a study readout</PageTitle>
      {restoredAt !== null || savedAt !== null ? <View style={styles.status}>
        <AppIcon name={restoredAt !== null ? "clock" : "check"} size={16} color={colors.muted} />
        <Text style={styles.statusText}>{restoredAt !== null
          ? `Picked up where you left off (last saved ${whenInSentence(savedAt ?? restoredAt)}). The readout is saved on this device as you go; the Qualtrics files aren't.`
          : `Your readout is saved on this device as you go (last saved ${whenInSentence(savedAt!)}).`}</Text>
        <Button label="Start over" kind="link" compact disabled={busy || saving} onPress={() => setConfirming("start-over")} />
      </View> : null}
      <View style={styles.note}>
        <AppIcon name="lock" size={17} color={colors.blueDark} />
        <Text style={styles.noteText}>Your files are read on this device and never sent anywhere. The readout keeps only totals, rates and ranges: no responses, response IDs or answers.</Text>
      </View>

      <Text accessibilityRole="header" style={styles.sectionTitle}>1. The study</Text>
      <View style={styles.card}>
        {study ? <>
          <Text style={styles.cardTitle}>{study.title}</Text>
          <Text style={styles.cardMeta}>{study.abActivities.length} A/B {study.abActivities.length === 1 ? "activity" : "activities"}{studyName ? ` · ${studyName}` : ""}</Text>
          <Button label="Choose another study" kind="secondary" compact disabled={busy} onPress={() => { void chooseStudy(); }} style={styles.cardAction} />
        </> : <>
          <Text style={styles.cardHelp}>The study's JSON file from Civic Research Studio, or a working draft saved here. It tells the readout which designs and activities to expect.</Text>
          <Button label="Choose the study file" kind="secondary" disabled={busy} onPress={() => { void chooseStudy(); }} style={styles.cardAction} />
        </>}
        {studyProblem ? <Text accessibilityRole="alert" style={styles.error}>{studyProblem}</Text> : null}
      </View>

      <Text accessibilityRole="header" style={styles.sectionTitle}>2. Qualtrics results</Text>
      <View style={styles.card}>
        <Text style={styles.label}>Follow-up survey export (Survey 2) *</Text>
        <Text style={styles.cardHelp}>The survey with Civic Research Studio's rs_ fields, exported from Qualtrics as CSV. Include incomplete responses to count people who left.</Text>
        <View style={styles.fileRow}>
          <Text style={styles.fileName} numberOfLines={1}>{survey2?.name ?? (exportsMissing ? `${fileNames!.survey2} (choose it again to update the results)` : "No file chosen")}</Text>
          <Button label={survey2 ? "Change" : "Choose file"} kind="secondary" compact disabled={busy || !study} onPress={() => { void chooseExport(2); }} />
        </View>
        <Text style={[styles.label, styles.labelSpaced]}>Intake survey export (Survey 1, optional)</Text>
        <Text style={styles.cardHelp}>Adds people who were assigned a design but never reached Survey 2, so drop-out can be counted.</Text>
        <View style={styles.fileRow}>
          <Text style={styles.fileName} numberOfLines={1}>{survey1?.name ?? "No file chosen"}</Text>
          {survey1 ? <Button label="Remove" kind="link" compact disabled={busy} onPress={() => setSurvey1(null)} /> : null}
          <Button label={survey1 ? "Change" : "Choose file"} kind="secondary" compact disabled={busy || !study} onPress={() => { void chooseExport(1); }} />
        </View>
        <Pressable accessibilityRole="checkbox" role="checkbox" aria-checked={includePreviews} accessibilityState={{ checked: includePreviews, disabled: busy }}
          accessibilityLabel="Include Qualtrics preview and test responses (a practice run)" disabled={busy}
          {...checkboxKeys(() => setIncludePreviews(value => !value), busy)}
          onPress={() => setIncludePreviews(value => !value)} style={({ pressed }) => [styles.toggle, pressed && { opacity: 0.75 }]}>
          <View style={[styles.checkbox, includePreviews && styles.checkboxChecked]}>
            {includePreviews ? <AppIcon name="check" size={14} color={colors.onPrimary} /> : null}
          </View>
          <Text style={styles.checkLabel}>Include Qualtrics preview and test responses (a practice run)</Text>
        </Pressable>
        <Text style={styles.cardHelp}>Study results leave previews and test responses out. Include them to try the readout before the study runs; it's then marked as a practice run, not study results.</Text>
        <Button label={results ? "Update the results" : "Show results"} busy={busy} disabled={!study || !survey2} onPress={() => { void showResults(); }} style={styles.cardAction} />
        {!study ? <Text style={styles.cardHelp}>Choose the study file first.</Text> : null}
        {problems.length ? <View accessibilityRole="alert" style={styles.problems}>{problems.map(p => <Text key={p} style={styles.error}>{p}</Text>)}</View> : null}
        {previewsOnly && !includePreviews ? <Button label="Include them and show a practice run" kind="secondary" compact disabled={busy}
          onPress={() => setIncludePreviews(true)} style={styles.cardAction} /> : null}
      </View>

      {results ? <>
        <Text accessibilityRole="header" style={styles.sectionTitle}>3. Results</Text>
        {results.practice ? <View style={styles.practice}>
          <AppIcon name="warning" size={17} color={colors.ink} />
          <Text style={styles.noteText}>Practice run: these come from Qualtrics preview and test responses, not from the study's participants. The readout and what you save from it say so.</Text>
        </View> : null}
        <Text style={styles.sectionDescription}>{results.responses} responses{results.survey1Provided ? `, and ${results.dropouts} people assigned who didn't finish` : ""}. Computed as Civic Research Studio computes them: each design's main measure counts everyone assigned, and ranges are 95% confidence intervals. No winner is declared.</Text>
        {results.warnings.length ? <View style={styles.warnings}>{results.warnings.map(w => <Text key={w} style={styles.warningText}>{`• ${w}`}</Text>)}</View> : null}
        {results.activities.map(activity => <View key={activity.id} style={styles.activity}>
          <Text accessibilityRole="header" style={styles.activityTitle}>{activity.title}</Text>
          <Text style={styles.activityMeta}>Main measure: {measureName(activity)}.</Text>
          <RatesChart activity={activity} />
          <DifferenceChart activity={activity} />
          <TimesChart activity={activity} />
          {questions.filter(q => q.taskId === activity.id && q.designs.some(d => d.n)).map(q => <QuestionChart key={q.questionId} question={q} hiddenIds={hiddenIds} />)}
          {activity.hypotheses.length ? <View style={styles.listCard}>
            <Text style={styles.listTitle}>Planned hypotheses</Text>
            {activity.hypotheses.map(h => <View key={h.n} style={styles.listItem}>
              <Text style={styles.listText}>{h.sentence}</Text>
              <Text style={styles.listMeta}>{h.text}{h.value ? ` ${h.value}` : ""}</Text>
            </View>)}
          </View> : null}
          <View style={styles.listCard}>
            <Text style={styles.listTitle}>Data checks</Text>
            {activity.checks.map(c => <View key={c.title} style={styles.check}>
              <AppIcon name={c.level === "warn" ? "warning" : c.level === "info" ? "eye" : "check"} size={16} color={c.level === "warn" ? colors.red : colors.muted} />
              <Text style={styles.checkText}><Text style={styles.checkTitle}>{c.title}{c.level === "warn" ? " (check)" : ""}: </Text>{c.text}</Text>
            </View>)}
          </View>
        </View>)}
      </> : null}

      {results && general.length ? <View style={styles.activity}>
        <Text accessibilityRole="header" style={styles.activityTitle}>Before and after the tasks</Text>
        {general.map(q => <QuestionChart key={q.questionId} question={q} hiddenIds={hiddenIds} />)}
      </View> : null}

      {results && commentQuestions.length ? <>
        <Text accessibilityRole="header" style={styles.sectionTitle}>4. What people said</Text>
        <Text style={styles.sectionDescription}>Give each comment one or more short themes, in your own words. To use someone&apos;s words in the readout, quote the comment and check it for identifying details first.</Text>
        <CommentCoding questions={commentQuestions} comments={comments} coding={coding} onChange={changeCoding} taskTitle={taskTitle} hiddenIds={hiddenIds} />
      </> : null}

      {results && readout ? <>
        <Text accessibilityRole="header" style={styles.sectionTitle}>{commentQuestions.length ? "5" : "4"}. The readout</Text>
        <Text style={styles.sectionDescription}>Drafted from the study and its results. Write the summary and edit everything into your own words; keep the numbers and ranges.</Text>
        <View style={styles.field}>
          <Text style={styles.label}>Title *</Text>
          <TextInput value={readout.title} onChangeText={value => edit("title", value)} accessibilityLabel="Title, required" maxLength={120} style={styles.input} />
        </View>
        {READOUT_SECTIONS.map(section => <View key={section.id} style={styles.field}>
          <Text style={styles.label}>{section.label}{section.required ? " *" : " (optional)"}</Text>
          <Text style={styles.cardHelp}>{section.hint}</Text>
          <GrowingTextInput value={readout[section.id]} onChangeText={value => edit(section.id, value)} accessibilityLabel={`${section.label}, ${section.required ? "required" : "optional"}`}
            autoCapitalize="sentences" autoCorrect minHeight={section.id === "summary" || section.id === "nextSteps" ? 96 : 160} style={styles.input} />
        </View>)}
        {stale.length ? <View accessibilityRole="alert" style={styles.stale}>
          <AppIcon name="warning" size={17} color={colors.ink} />
          <View style={styles.staleCopy}>
            <Text style={styles.noteText}>The results changed after you edited some sections, so their numbers may be out of date. Redraft the findings and limits, or check each number against the results above.</Text>
            <Button label="Numbers checked" kind="secondary" compact onPress={() => setStale([])} style={styles.cardAction} />
          </View>
        </View> : null}
        <Button label="Redraft findings and limits from the results" kind="link" compact onPress={() => setConfirming("redraft")} style={styles.redraft} />
        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.label}>Share</Text>
          <Text style={styles.cardHelp}>{`A Word document or a PDF with your text and each activity's results as tables${commentQuestions.length ? ", then your themes and quotes from what people said" : ""}; the PDF adds a chart for each activity. Check it before you send it on.`}</Text>
          {smallGroups ? <Text style={styles.cardHelp}>{`Designs with fewer than ${SMALL_GROUP_MIN} people are shown here but hidden in what you share.`}</Text> : null}
          <DraftChecklist problems={shareProblems} saveLabel="Save as Word document" busy={saving} notice={notice} onSave={() => { void saveWord(); }}
            listLabel="Needed before you can share the readout:" action={{ blocked: "Sharing is unavailable", announce: "before you can share the readout" }}
            secondary={{ label: "Print or save as PDF", onPress: printPdf }} />
        </View>
      </> : null}

      <Button label="Back to Research Studio" kind="link" onPress={() => router.replace("/research")} style={styles.back} />
    </ScrollView>
    <ConfirmDialog visible={confirming !== null}
      title={confirming === "redraft" ? "Redraft from the results?" : "Start over?"}
      confirmLabel={confirming === "redraft" ? "Redraft" : "Start over"}
      description={confirming === "redraft"
        ? "This replaces the findings and limits with a fresh draft from the results. Your summary, background and next steps stay as they are."
        : "This clears the readout on this device. Your Qualtrics files and study file aren't changed."}
      onConfirm={confirming === "redraft" ? redraft : startOver} onCancel={() => setConfirming(null)} />
  </View>;
}

function Unavailable({ text }: { text: string }) {
  const styles = useStyles();
  return <View style={styles.root}>
    <Stack.Screen options={{ title: "Study readout" }} />
    <ScrollView contentContainerStyle={styles.content}>
      <PageTitle>Write a study readout</PageTitle>
      <Text style={styles.sectionDescription}>{text}</Text>
      <Button label="Back to Research Studio" kind="link" onPress={() => router.replace("/research")} style={styles.back} />
    </ScrollView>
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  content: { paddingBottom: space.xl, width: "100%", maxWidth: 760, alignSelf: "center" },
  status: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.xs, marginHorizontal: space.side, marginBottom: space.sm },
  statusText: { ...typography.caption, color: colors.muted, flexShrink: 1, flexGrow: 1, flexBasis: 200 },
  note: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, marginHorizontal: space.side, padding: space.md, borderRadius: radius.md, backgroundColor: colors.blueSoft },
  noteText: { ...typography.caption, color: colors.ink, flex: 1 },
  sectionTitle: { ...typography.heading, color: colors.ink, marginHorizontal: space.side, marginTop: space.lg, marginBottom: space.xs },
  sectionDescription: { ...typography.caption, color: colors.muted, marginHorizontal: space.side, marginBottom: space.sm },
  card: { gap: space.xs, marginHorizontal: space.side, padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface },
  cardTitle: { ...typography.bodyStrong, color: colors.ink },
  cardMeta: { ...typography.caption, color: colors.muted },
  cardHelp: { ...typography.caption, color: colors.muted },
  cardAction: { marginTop: space.xs, alignSelf: "flex-start" },
  label: { ...typography.captionStrong, color: colors.ink },
  labelSpaced: { marginTop: space.sm },
  fileRow: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  fileName: { ...typography.caption, color: colors.ink, flexGrow: 1, flexShrink: 1, flexBasis: 160 },
  problems: { gap: space.xxs, marginTop: space.xs },
  error: { ...typography.caption, color: colors.red },
  warnings: { gap: space.xxs, marginHorizontal: space.side, marginBottom: space.sm },
  warningText: { ...typography.caption, color: colors.ink },
  activity: { gap: space.sm, marginHorizontal: space.side, marginBottom: space.md },
  activityTitle: { ...typography.bodyStrong, color: colors.ink },
  activityMeta: { ...typography.caption, color: colors.muted },
  listCard: { gap: space.xs, padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface },
  listTitle: { ...typography.captionStrong, color: colors.ink },
  listItem: { gap: 2 },
  listText: { ...typography.caption, color: colors.ink },
  listMeta: { ...typography.caption, color: colors.muted },
  check: { flexDirection: "row", alignItems: "flex-start", gap: space.xs },
  toggle: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.sm },
  checkLabel: { ...typography.caption, color: colors.ink, flex: 1 },
  checkbox: { width: 22, height: 22, borderRadius: radius.sm, borderWidth: 2, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  checkboxChecked: { borderColor: colors.blue, backgroundColor: colors.blue },
  practice: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, marginHorizontal: space.side, marginBottom: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surface },
  checkText: { ...typography.caption, color: colors.ink, flex: 1 },
  checkTitle: { ...typography.captionStrong, color: colors.ink },
  field: { gap: space.xxs, marginHorizontal: space.side, marginBottom: space.md },
  input: { ...typography.body, minHeight: 44, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.borderStrong, color: colors.ink, backgroundColor: colors.background },
  redraft: { marginHorizontal: space.side, marginBottom: space.md, alignSelf: "flex-start" },
  stale: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, marginHorizontal: space.side, marginBottom: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surface },
  staleCopy: { flex: 1, gap: space.xs },
  back: { marginTop: space.lg, alignSelf: "center" },
}));
