import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { LexiconEditor } from "./LexiconEditor";
import { lexiconApi, type LexiconEntry } from "../lib/lexicon-api";
import type { Account } from "../lib/server";
import { createThemedStyles, space, typography, useTheme } from "../lib/theme";
import { ServeLoader } from "./ServeLoader";

// The wiki's Abbreviations page: the shared abbreviations that are underlined in messages, with their meaning on hover. It is a page of the wiki
// to find and to read, but it stays a list of pairs (lexicon-api.ts), because each one has to be matched while typing.
export function WikiAbbreviations({ account, header }: { account: Account; header?: ReactNode }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [entries, setEntries] = useState<LexiconEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<LexiconEntry | "new" | null>(null);
  const [removing, setRemoving] = useState<LexiconEntry | null>(null);
  const [removeError, setRemoveError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const mounted = useRef(true);
  const pending = useRef<AbortController | null>(null);
  const deletingNow = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current?.abort(); };
  }, []);
  const load = useCallback(async () => {
    if (!mounted.current) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setRefreshing(true);
    try {
      const next = await lexiconApi.list(account, controller.signal);
      if (mounted.current && !controller.signal.aborted) { setEntries(next.entries); setError(""); }
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Couldn't load shortcuts. Try again.");
    } finally {
      if (mounted.current && !controller.signal.aborted) setRefreshing(false);
    }
  }, [account]);
  useFocusEffect(useCallback(() => { void load(); return () => pending.current?.abort(); }, [load]));
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return (entries ?? []).filter(entry => !search || `${entry.abbreviation} ${entry.fullName}`.toLowerCase().includes(search))
      .sort((a, b) => a.abbreviation.localeCompare(b.abbreviation) || a.fullName.localeCompare(b.fullName));
  }, [entries, query]);
  const saved = (entry: LexiconEntry) => {
    if (!mounted.current) return;
    setEntries(previous => [...(previous ?? []).filter(item => item.id !== entry.id), entry]);
    setEditing(null); setQuery("");
    void load();
  };
  // Keeping a guess saves the same words under a person's name, so it starts being underlined in messages and stops being a guess.
  const [keeping, setKeeping] = useState<string | null>(null);
  const keep = async (entry: LexiconEntry) => {
    if (keeping) return;
    setKeeping(entry.id); setError("");
    try { saved(await lexiconApi.update(account, entry.id, { fullName: entry.fullName })); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "Couldn't keep the guess. Try again."); }
    finally { if (mounted.current) setKeeping(null); }
  };
  const remove = async () => {
    if (!removing || deletingNow.current) return;
    deletingNow.current = true; setDeleting(true); setRemoveError("");
    try {
      await lexiconApi.remove(account, removing.id);
      if (!mounted.current) return;
      setEntries(previous => previous?.filter(entry => entry.id !== removing.id) ?? null);
      setRemoving(null);
      void load();
    } catch (reason) {
      if (mounted.current) setRemoveError(reason instanceof Error ? reason.message : "Couldn't delete the shortcut. Try again.");
    } finally { deletingNow.current = false; if (mounted.current) setDeleting(false); }
  };

  return <View style={styles.root}>
    <FlatList data={filtered} keyExtractor={entry => entry.id} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}
      refreshControl={<RefreshControl tintColor={colors.blue} refreshing={refreshing} onRefresh={() => void load()} />}
      ListHeaderComponent={<>
        {header}
        <Text style={styles.intro}>In messages, these are underlined with dots. Hover over one, or tap it on a phone, to see what it means. Everyone on this server shares them.</Text>
        <View style={styles.toolbar}>
          <TextInput testID="lexicon-search" accessibilityLabel="Search shortcuts" placeholder="Search shortcuts" placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} maxLength={200} style={styles.search} />
          <Button label="Add shortcut" compact onPress={() => setEditing("new")} />
          <Button label="Refresh" kind="link" compact busy={refreshing} onPress={() => void load()} />
        </View>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {filtered.length ? <View style={styles.heading}><Text style={[styles.label, styles.abbreviation]}>Abbreviation</Text><Text style={[styles.label, styles.replacement]}>Meaning</Text></View> : null}
      </>}
      ListEmptyComponent={!entries && refreshing ? <ServeLoader accessibilityLabel="Loading shortcuts" style={styles.empty} /> : !error ? <Text style={styles.empty}>{query.trim() ? "No matches" : "No shortcuts"}</Text> : undefined}
      renderItem={({ item: entry }) => <View testID={`lexicon-entry-${entry.id}`} style={styles.entry}>
        <View style={styles.columns}>
          <Text selectable style={[styles.body, styles.abbreviation]}>{entry.abbreviation}</Text>
          <View style={styles.replacement}>
            <Text selectable style={styles.body}>{entry.fullName}</Text>
            {entry.guessed ? <Text testID={`lexicon-guess-${entry.id}`} style={styles.guess}>Agent&apos;s guess. It is not underlined in messages until someone keeps or edits it.</Text> : null}
          </View>
        </View>
        {entry.canEdit ? <View style={styles.actions}>
          <Button label="Edit" accessibilityLabel={`Edit ${entry.abbreviation}`} kind="link" compact onPress={() => setEditing(entry)} />
          {entry.guessed ? <Button label="Keep" accessibilityLabel={`Keep Agent's guess for ${entry.abbreviation}`} kind="secondary" compact busy={keeping === entry.id} onPress={() => void keep(entry)} /> : null}
          <Button label="Delete" accessibilityLabel={`Delete ${entry.abbreviation}`} kind="danger" compact onPress={() => { setRemoveError(""); setRemoving(entry); }} />
        </View> : null}
      </View>} />
    {editing ? <LexiconEditor key={editing === "new" ? "new" : editing.id} account={account} entry={editing === "new" ? undefined : editing} onSaved={saved} onCancel={() => setEditing(null)} /> : null}
    <ConfirmDialog visible={!!removing} title={`Delete ${removing?.abbreviation ?? "shortcut"}?`} description="This removes the shortcut for everyone on this server." confirmLabel="Delete shortcut" onConfirm={() => void remove()} onCancel={() => setRemoving(null)} busy={deleting} error={removeError} />
  </View>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 840, alignSelf: "center" },
  body: { ...typography.body, color: colors.ink },
  label: { ...typography.label, color: colors.muted },
  intro: { ...typography.body, color: colors.muted, marginBottom: space.md },
  toolbar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs, marginBottom: space.md },
  search: { ...controls.input, flexGrow: 1, flexBasis: 220 },
  error: { ...typography.body, color: colors.red, marginBottom: space.sm },
  empty: { ...typography.body, color: colors.muted, paddingVertical: space.lg, textAlign: "center" },
  heading: { flexDirection: "row", gap: space.sm },
  // One wrapping row: the pair, then Edit and Delete on the same line when there is room for them.
  entry: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, paddingVertical: space.xs },
  columns: { flexDirection: "row", gap: space.sm, flexGrow: 1, flexBasis: 280, minWidth: 0, paddingVertical: space.xs },
  abbreviation: { width: 112 },
  replacement: { flex: 1, minWidth: 0 },
  guess: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  actions: { flexDirection: "row", alignItems: "center", gap: space.xs, marginLeft: "auto" },
}));
