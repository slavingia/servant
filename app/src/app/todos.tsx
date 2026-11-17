import { useCallback, useRef, useState } from "react";
import { AppState, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { TodoList } from "../components/TodoList";
import { todoFilterSummary } from "../lib/todo-list";
import { Button } from "../components/Button";
import { useProjects } from "../lib/projects-store";
import { accountId, api, ServerError, type Account, type TodoItem } from "../lib/server";
import { useSession } from "../lib/session";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { ServeLoader } from "../components/ServeLoader";

// Every to-do you can see, as a board: To do, In progress and Done. Yours, the ones for you, and your projects'.
// Filter the board by project or release, add your own, tag them, give them a due date, send them to the agent.
// ?project= and ?release= open a filtered board (a project page links here).
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
  // Show one epic and the to-dos under it.
  const [epic, setEpic] = useState<{ id: string; text: string } | undefined>();
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
        : (await api.todos(account, { project, release, status: "all", mine: scope === "mine", epic: epic?.id })).todos;
      if (request === version.current) { setTodos(rows); setError(null); }
    } catch (e) {
      if (request === version.current) {
        setError(e instanceof ServerError ? e.message : "Couldn't load your to-dos");
        setTodos([]);
      }
    } finally { if (request === version.current) loading.current = false; }
  }, [account, project, release, scope, epic, selectedId]);
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
  const epics = (todos ?? []).filter(t => t.type === "epic");
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
    {epics.length || epic ? <>
      <Text style={styles.label}>Epic</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Epic" style={styles.group}>
        {chip("All epics", !epic, () => setEpic(undefined))}
        {epics.map(e => chip(e.text, epic?.id === e.id, () => setEpic({ id: e.id, text: e.text })))}
      </View>
    </> : null}
  </View>;
  const summary = [todoFilterSummary({ mine: scope === "mine", project: current?.name, release: current?.releases.find(r => r.id === release)?.name, done: false }),
    epic?.text].filter(Boolean).join(" · ");
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} tintColor={colors.blue} />}>
      <Stack.Screen options={{ title: current ? `${current.name} to-dos` : "To-dos" }} />
      {selectedId ? <Button label="All to-dos" kind="link" disabled={writing} onPress={() => setSelectedId(undefined)} /> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {todos === null ? <ServeLoader style={{ marginTop: space.xl }} />
        : <TodoList account={account} todos={todos} board={!selectedId} allowAdd={!selectedId} filters={filters} filterSummary={summary} onChange={onChange} onBusyChange={onBusyChange} onReload={() => void load()} empty={selectedId ? "This to-do is no longer available." : EMPTY} />}
    </ScrollView>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  // Wide enough for three columns side by side.
  content: { padding: space.side, paddingBottom: space.xxl, maxWidth: 1120, width: "100%", alignSelf: "center" },
  label: { ...typography.label, color: colors.muted, marginTop: space.sm, marginBottom: space.xs },
  group: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  chip: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.sm, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background, maxWidth: 220 },
  chipOn: { backgroundColor: colors.blueSoft, borderColor: colors.blue },
  chipText: { ...typography.label, color: colors.ink },
  chipTextOn: { color: colors.blueDark },
  error: { ...typography.caption, color: colors.red, backgroundColor: colors.redSoft, padding: space.sm, borderRadius: radius.sm, marginVertical: space.xs },
}));
