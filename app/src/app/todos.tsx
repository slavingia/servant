import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { TodoList } from "../components/TodoList";
import { Toggle } from "../components/Toggle";
import { todoFilterSummary } from "../lib/todo-list";
import { Button } from "../components/Button";
import { useProjects } from "../lib/projects-store";
import { accountId, api, ServerError, type Account, type TodoItem } from "../lib/server";
import { useSession } from "../lib/session";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

// Every to-do you can see, newest plans first: yours, the ones for you, and your projects'. Filter by project
// or release, add your own, tag them, send them to the agent. ?project= and ?release= open a filtered view
// (a project page links here).
type Scope = "mine" | "all";
const EMPTY = "No to-dos yet. Type one below, or record a meeting and its follow-ups appear here.";

export default function Todos() {
  const { account } = useSession();
  const params = useLocalSearchParams<{ id?: string; project?: string; release?: string }>();
  return account ? <TodoScreen key={`${accountId(account)}:${account.token}:${params.id ?? ""}:${params.project ?? ""}:${params.release ?? ""}`} account={account} params={params} /> : null;
}

function TodoScreen({ account, params }: { account: Account; params: { id?: string; project?: string; release?: string } }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const projects = useProjects();
  const [scope, setScope] = useState<Scope>("all");
  const [project, setProject] = useState<string | undefined>(params.project);
  const [release, setRelease] = useState<string | undefined>(params.release);
  const [showDone, setShowDone] = useState(false);
  const [selectedId, setSelectedId] = useState(params.id);
  const [todos, setTodos] = useState<TodoItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [writing, setWriting] = useState(false);
  const version = useRef(0);
  const loading = useRef(false);
  const mutating = useRef(false);
  const focused = useRef(false);

  const load = useCallback(async () => {
    if (mutating.current) return;
    const request = ++version.current;
    loading.current = true;
    try {
      const rows = selectedId ? [(await api.todo(account, selectedId)).todo]
        : (await api.todos(account, { project, release, status: showDone ? "all" : "open", mine: scope === "mine" })).todos;
      if (request === version.current) { setTodos(rows); setError(null); }
    } catch (e) {
      if (request === version.current) {
        setError(e instanceof ServerError ? e.message : "Couldn't load your to-dos");
        setTodos([]);
      }
    } finally { if (request === version.current) loading.current = false; }
  }, [account, project, release, scope, showDone, selectedId]);
  // The agent ticks items off while this is open.
  useFocusEffect(useCallback(() => {
    focused.current = true;
    void load();
    const timer = setInterval(() => { if (AppState.currentState === "active" && !loading.current && !mutating.current) void load(); }, 5000);
    return () => { focused.current = false; version.current++; loading.current = false; clearInterval(timer); };
  }, [load]));
  const onBusyChange = useCallback((value: boolean) => {
    mutating.current = value;
    setWriting(value);
    // A read begun before a write must never restore the old state afterward.
    version.current++;
    loading.current = false;
    if (!value && focused.current) void load();
  }, [load]);
  const onChange = useCallback((change: (current: TodoItem[]) => TodoItem[]) => {
    setTodos(current => change(current ?? []));
  }, []);

  const list = projects?.list ?? [];
  const current = list.find(p => p.id === project);
  const chip = (label: string, on: boolean, press: () => void) => (
    <Pressable key={label} accessibilityRole="radio" accessibilityState={{ checked: on, disabled: writing }} aria-checked={on} accessibilityLabel={label} disabled={writing} onPress={press} style={[styles.chip, on && styles.chipOn]}>
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
  // The filters are out of the way until asked for: the list's options hold them, and the line above the list
  // says which are on.
  const filters = selectedId ? undefined : <View testID="todo-filters">
    <Text style={styles.label}>Show</Text>
    <View accessibilityRole="radiogroup" accessibilityLabel="Whose to-dos" style={styles.group}>
      {chip("Everyone's", scope === "all", () => setScope("all"))}
      {chip("Mine", scope === "mine", () => setScope("mine"))}
    </View>
    {list.length ? <>
      <Text style={styles.label}>Project</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Project" style={styles.group}>
        {chip("All projects", !project, () => { setProject(undefined); setRelease(undefined); })}
        {list.map(p => chip(p.name, project === p.id, () => { setProject(p.id); setRelease(undefined); }))}
      </View>
    </> : null}
    {current?.releases.length ? <>
      <Text style={styles.label}>Release</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Release" style={styles.group}>
        {chip("Any release", !release, () => setRelease(undefined))}
        {current.releases.map(r => chip(r.name, release === r.id, () => setRelease(r.id)))}
      </View>
    </> : null}
    {/* A switch of its own, not one more choice: it says whether finished to-dos are listed too. */}
    <View style={styles.doneRow}>
      <Text style={styles.doneLabel}>Show done</Text>
      <Toggle value={showDone} label="Show done" disabled={writing} onValueChange={setShowDone} />
    </View>
  </View>;
  const summary = todoFilterSummary({ mine: scope === "mine", project: current?.name, release: current?.releases.find(r => r.id === release)?.name, done: showDone });
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} tintColor={colors.blue} />}>
      <Stack.Screen options={{ title: current ? `${current.name} to-dos` : "To-dos" }} />
      {selectedId ? <Button label="All to-dos" kind="link" disabled={writing} onPress={() => setSelectedId(undefined)} /> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {todos === null ? <ActivityIndicator style={{ marginTop: space.xl }} color={colors.blue} />
        : <TodoList account={account} todos={todos} allowAdd={!selectedId} filters={filters} filterSummary={summary} onChange={onChange} onBusyChange={onBusyChange} onReload={() => void load()} empty={selectedId ? "This to-do is no longer available." : EMPTY} />}
    </ScrollView>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.side, paddingBottom: space.xxl, maxWidth: 720, width: "100%", alignSelf: "center" },
  label: { ...typography.label, color: colors.muted, marginTop: space.sm, marginBottom: space.xs },
  group: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  chip: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.sm, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background, maxWidth: 220 },
  chipOn: { backgroundColor: colors.blueSoft, borderColor: colors.blue },
  chipText: { ...typography.label, color: colors.ink },
  chipTextOn: { color: colors.blueDark },
  doneRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44, marginTop: space.md },
  doneLabel: { ...typography.body, color: colors.ink },
  error: { ...typography.caption, color: colors.red, backgroundColor: colors.redSoft, padding: space.sm, borderRadius: radius.sm, marginVertical: space.xs },
}));
