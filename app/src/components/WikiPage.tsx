import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Button, ButtonGroup } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { MessageText } from "./MessageText";
import { ServerError, type Account } from "../lib/server";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";
import { wikiAskPlaceholder, wikiChange, wikiEditedLine, type WikiDraft, type WikiPage as Page } from "../lib/wiki";
import { wikiApi } from "../lib/wiki-api";

// One page of the wiki. A page is changed by asking Agent: the person says what they want, Agent returns the whole
// page with the change made, and the person reads it before choosing Save. Nobody types Markdown. Nothing is saved
// until Save, and a save made from an old copy is refused by the server rather than overwriting someone else's.
export function WikiPage({ account, id, header, fresh = false, onSaved, onDeleted }: {
  account: Account; id: string;
  /** What sits above the title: where the page is, and on a phone the way back to the list. */
  header?: ReactNode;
  /** A page that was just made: the box that asks Agent is ready to type in. */
  fresh?: boolean;
  onSaved: (page: Page) => void;
  onDeleted: (page: Page) => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [page, setPage] = useState<Page | null>(null);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // What Agent proposes, and the version of the page it was made from.
  const [draft, setDraft] = useState<WikiDraft | null>(null);
  const [request, setRequest] = useState("");
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  // Someone saved first: their version, shown under the draft so nothing is lost.
  const [theirs, setTheirs] = useState<Page | null>(null);
  const [removing, setRemoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    const controller = new AbortController();
    wikiApi.get(account, id, controller.signal).then(next => {
      if (!controller.signal.aborted) { setPage(next); setTheirs(null); }
    }).catch(reason => {
      if (!controller.signal.aborted) setLoadError(reason instanceof Error ? reason.message : "Couldn't load this page. Try again.");
    });
    return () => controller.abort();
  }, [account, id, attempt]);

  const ask = useCallback(async () => {
    const instruction = request.trim();
    if (!page || !instruction || asking) return;
    setAsking(true); setAskError(""); setSaveError("");
    try {
      // A second request carries on from the draft on screen, not from the saved page.
      const next = await wikiApi.draft(account, page.id, { instruction, ...(draft ? { draft: { title: draft.title, body: draft.body } } : {}) });
      if (!mounted.current) return;
      setDraft({ ...next.draft, version: draft?.version ?? next.version }); setRequest("");
    } catch (reason) {
      if (mounted.current) setAskError(reason instanceof Error ? reason.message : "Agent couldn't change this page. Try again.");
    } finally { if (mounted.current) setAsking(false); }
  }, [account, asking, draft, page, request]);

  const save = useCallback(async () => {
    if (!page || !draft || saving) return;
    const change = wikiChange({ ...page, version: draft.version }, draft);
    if (!change) { setDraft(null); return; }
    setSaving(true); setSaveError("");
    try {
      const next = await wikiApi.update(account, page.id, change);
      if (!mounted.current) return;
      setPage(next); setDraft(null); setTheirs(null); onSaved(next);
    } catch (reason) {
      if (!mounted.current) return;
      const newer = reason instanceof ServerError && reason.code === "stale" ? reason.details.page as Page | undefined : undefined;
      setTheirs(newer?.id === page.id ? newer : null);
      setSaveError(reason instanceof Error ? reason.message : "Couldn't save this page. Try again.");
    } finally { if (mounted.current) setSaving(false); }
  }, [account, draft, onSaved, page, saving]);

  const remove = async () => {
    if (!page || deleting) return;
    setDeleting(true); setRemoveError("");
    try {
      await wikiApi.remove(account, page.id);
      if (!mounted.current) return;
      setRemoving(false); onDeleted(page);
    } catch (reason) {
      if (mounted.current) setRemoveError(reason instanceof Error ? reason.message : "Couldn't delete this page. Try again.");
    } finally { if (mounted.current) setDeleting(false); }
  };

  if (!page) {
    return <View style={styles.content}>
      {header}
      {loadError
        ? <View style={styles.notice}><Text accessibilityRole="alert" style={styles.error}>{loadError}</Text><Button label="Try again" kind="secondary" compact onPress={() => { setLoadError(""); setAttempt(n => n + 1); }} /></View>
        : <ActivityIndicator accessibilityLabel="Loading page" color={colors.blue} style={styles.loading} />}
    </View>;
  }

  const shown = draft ?? page;
  return <ScrollView testID="wiki-page" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
    {header}
    {draft ? <View testID="wiki-draft-note" style={styles.draftNote}>
      <Text style={styles.draftText}>This is Agent&apos;s draft. Nothing is saved until you choose Save.</Text>
      <ButtonGroup>
        <Button testID="wiki-save" label="Save" compact busy={saving} onPress={() => void save()} />
        <Button label="Discard" kind="danger" compact disabled={saving} onPress={() => { if (theirs) setPage(theirs); setDraft(null); setSaveError(""); setTheirs(null); }} />
      </ButtonGroup>
      {saveError ? <Text accessibilityRole="alert" style={styles.error}>{saveError}</Text> : null}
    </View> : null}
    <Text testID="wiki-title" accessibilityRole="header" style={styles.title}>{shown.title}</Text>
    {draft ? null : <Text style={styles.meta}>{wikiEditedLine(page)}</Text>}
    {shown.body.trim()
      ? <View testID="wiki-body" style={styles.body}><MessageText text={shown.body} /></View>
      : <Text style={styles.empty}>{draft ? "Agent's draft is an empty page." : "This page is empty. Tell Agent below what it should say."}</Text>}
    {theirs ? <View testID="wiki-theirs" style={styles.theirs}>
      <Text style={styles.meta}>The saved page now reads as below. Discard drops the draft and shows it.</Text>
      <Text style={styles.theirsTitle}>{theirs.title}</Text>
      <MessageText text={theirs.body || "This page is empty."} />
    </View> : null}
    <View style={styles.ask}>
      <Text style={styles.askLabel}>{draft ? "Ask Agent for another change" : "Ask Agent to change this page"}</Text>
      <TextInput testID="wiki-ask-input" accessibilityLabel={draft ? "What else should change" : "What should change on this page"} placeholder={wikiAskPlaceholder(shown)} placeholderTextColor={colors.muted}
        value={request} onChangeText={setRequest} multiline maxLength={2000} editable={!asking} autoFocus={fresh} style={styles.askInput} />
      {askError ? <Text accessibilityRole="alert" style={styles.error}>{askError}</Text> : null}
      <ButtonGroup>
        <Button testID="wiki-ask" label="Ask Agent" kind={draft ? "secondary" : "primary"} busy={asking} disabled={!request.trim()} onPress={() => void ask()} />
        {!draft && page.canDelete ? <Button label="Delete page" kind="danger" onPress={() => { setRemoveError(""); setRemoving(true); }} /> : null}
      </ButtonGroup>
      {asking ? <Text style={styles.meta}>Agent is writing. This can take a minute.</Text> : null}
    </View>
    <ConfirmDialog visible={removing} title={`Delete ${page.title}?`} description="This removes the page for everyone on this server." confirmLabel="Delete page"
      onConfirm={() => void remove()} onCancel={() => setRemoving(false)} busy={deleting} error={removeError} />
  </ScrollView>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  content: { padding: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 840, alignSelf: "center", gap: space.sm },
  loading: { paddingVertical: space.lg },
  notice: { gap: space.sm, alignItems: "flex-start" },
  title: { ...typography.title, color: colors.ink },
  meta: { ...typography.caption, color: colors.muted },
  body: { paddingTop: space.xs },
  empty: { ...typography.body, color: colors.muted, paddingVertical: space.md },
  error: { ...typography.body, color: colors.red },
  draftNote: { gap: space.sm, padding: space.sm, borderRadius: radius.md, backgroundColor: colors.blueSoft },
  draftText: { ...typography.bodyStrong, color: colors.ink },
  ask: { gap: space.xs, marginTop: space.lg, paddingTop: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  askLabel: { ...typography.label, color: colors.muted },
  askInput: { ...controls.input, ...controls.inputMultiline, minHeight: 88 },
  theirsTitle: { ...typography.bodyStrong, color: colors.ink },
  theirs: { gap: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingTop: space.sm, marginTop: space.xs },
}));
