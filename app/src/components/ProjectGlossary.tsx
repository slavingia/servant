import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { LexiconEditor } from "./LexiconEditor";
import { glossaryApi } from "../lib/glossary-api";
import type { GlossaryEntry } from "../lib/abbreviations";
import type { Account, Project } from "../lib/server";
import { space, typography, createThemedStyles, useTheme } from "../lib/theme";
import { ServeLoader } from "./ServeLoader";

export function ProjectGlossary({ account, project }: { account: Account; project: Project }) {
  return <ProjectShortcuts key={`${account.serverUrl}:${account.user.id}:${account.token}:${project.id}`} account={account} project={project} />;
}

function ProjectShortcuts({ account, project }: { account: Account; project: Project }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [entries, setEntries] = useState<GlossaryEntry[] | null>(null);
  const [writable, setWritable] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<GlossaryEntry | "new" | null>(null);
  const [removing, setRemoving] = useState<GlossaryEntry | null>(null);
  const [error, setError] = useState("");
  const [removeError, setRemoveError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    glossaryApi.list(account, project.id, controller.signal).then(result => {
      if (!controller.signal.aborted) { setEntries(result.entries); setWritable(result.canWrite); setError(""); }
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Couldn't load shortcuts. Try again.");
    });
    return () => controller.abort();
  }, [account, project.id, revision]);
  const canWrite = project.canWrite && writable;
  const search = query.trim().toLowerCase();
  const shown = (entries ?? []).filter(entry => !search || `${entry.abbreviation} ${entry.fullName}`.toLowerCase().includes(search));
  const remove = async () => {
    if (!removing || busy) return;
    setBusy(true); setRemoveError("");
    try {
      await glossaryApi.remove(account, project.id, removing.id);
      setEntries(previous => previous?.filter(entry => entry.id !== removing.id) ?? []); setRemoving(null);
    } catch (reason) { setRemoveError(reason instanceof Error ? reason.message : "Couldn't delete the shortcut. Try again."); }
    finally { setBusy(false); }
  };
  return <View testID="project-glossary" style={styles.root}>
    <View style={styles.actions}>
      <Text accessibilityRole="header" style={styles.heading}>Project shortcuts</Text>
      {canWrite ? <View testID="glossary-add"><Button label="Add shortcut" kind="link" compact onPress={() => setEditing("new")} /></View> : null}
    </View>
    {error ? <><Text accessibilityRole="alert" style={styles.error}>{error}</Text><Button label="Try again" kind="link" onPress={() => setRevision(value => value + 1)} /></> : null}
    {entries === null && !error ? <ServeLoader accessibilityLabel="Loading shortcuts" /> : null}
    {entries?.length ? <TextInput accessibilityLabel="Search project shortcuts" placeholder="Search shortcuts" value={query} onChangeText={setQuery} placeholderTextColor={colors.muted} autoCapitalize="none" style={styles.input} /> : null}
    {entries && !shown.length ? <Text style={styles.caption}>{entries.length ? "No matches" : "No shortcuts"}</Text> : null}
    {shown.map(entry => <View key={entry.id} testID={`glossary-entry-${entry.id}`} style={styles.row}>
      <View style={styles.pair}><Text style={styles.label}>{entry.abbreviation}</Text><Text selectable style={styles.body}>{entry.fullName}</Text></View>
      {canWrite ? <View style={styles.rowActions}>
        <Button label="Edit" accessibilityLabel={`Edit ${entry.abbreviation}`} compact kind="link" onPress={() => setEditing(entry)} />
        <Button label="Delete" accessibilityLabel={`Delete ${entry.abbreviation}`} compact kind="danger" onPress={() => { setRemoveError(""); setRemoving(entry); }} />
      </View> : null}
    </View>)}
    {editing ? <LexiconEditor key={editing === "new" ? "new" : editing.id} account={account} entry={editing === "new" ? undefined : { ...editing, canEdit: true }} saveEntry={async fields => {
      const entry = editing === "new" ? await glossaryApi.create(account, project.id, fields) : await glossaryApi.update(account, project.id, editing.id, fields);
      return { ...entry, canEdit: true };
    }} onSaved={entry => {
      setEntries(previous => [...(previous ?? []).filter(item => item.id !== entry.id), entry].sort((a, b) => a.abbreviation.localeCompare(b.abbreviation)));
      setEditing(null); setQuery("");
    }} onCancel={() => setEditing(null)} /> : null}
    <ConfirmDialog visible={!!removing} title={`Delete ${removing?.abbreviation ?? "shortcut"}?`} description={removing?.fullName ?? ""} confirmLabel="Delete shortcut" onConfirm={() => void remove()} onCancel={() => setRemoving(null)} busy={busy} error={removeError} />
  </View>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { marginTop: space.lg, paddingHorizontal: space.side, gap: space.sm },
  // A section title like Workflow, People and Files on the same tab.
  heading: { ...typography.label, color: colors.muted, flexGrow: 1 },
  // One wrapping row: the pair, then Edit and Delete on the same line when there is room for them.
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, paddingVertical: space.xs },
  pair: { flexDirection: "row", flexWrap: "wrap", gap: space.md, flexGrow: 1, flexBasis: 280, minWidth: 0, paddingVertical: space.xs },
  label: { ...typography.bodyStrong, color: colors.ink },
  body: { ...typography.body, color: colors.ink, flex: 1 },
  caption: { ...typography.caption, color: colors.muted },
  error: { ...typography.caption, color: colors.red },
  input: controls.input,
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: space.xs },
  rowActions: { flexDirection: "row", alignItems: "center", gap: space.xs, marginLeft: "auto" },
}));
