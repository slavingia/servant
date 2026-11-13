import { useEffect, useRef, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { randomUUID } from "expo-crypto";
import { Button, ButtonGroup } from "./Button";
import { CaseOwnerPicker, type CasePerson } from "./CaseOwnerPicker";
import { createInboxDraftId, inboxDueLabel, inboxOverdue, parseInboxDueDate, type InboxClient, type InboxTask, type InboxTaskPatch } from "../lib/secure-inbox";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

type Props = { client: InboxClient; id: string; tasks: readonly InboxTask[]; people: readonly CasePerson[]; peopleError: string; onChanged: () => void; active: boolean };

export function CaseTasks({ client, id, tasks, people, peopleError, onChanged, active }: Props) {
  const styles = useStyles();
  const [editing, setEditing] = useState<InboxTask | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const operation = useRef<{ key: string; requestId: string } | null>(null);
  const controller = useRef(new AbortController());
  useEffect(() => { controller.current = new AbortController(); return () => controller.current.abort(); }, []);
  const toggle = async (task: InboxTask) => {
    if (busy) return;
    const status = task.status === "open" ? "done" : "open";
    const key = `${task.id}:${status}`;
    if (operation.current?.key !== key) operation.current = { key, requestId: randomUUID() };
    setBusy(task.id); setError("");
    try {
      await client.updateTask(id, task.id, { status }, operation.current.requestId, controller.current.signal);
      if (controller.current.signal.aborted) return;
      operation.current = null; onChanged();
    } catch (cause) { if (!controller.current.signal.aborted) setError(cause instanceof Error ? cause.message : "Couldn't update this follow-up. Try again."); }
    finally { if (!controller.current.signal.aborted) setBusy(null); }
  };
  const open = tasks.filter(task => task.status === "open");
  const done = tasks.filter(task => task.status === "done");
  return <View style={[styles.root, !active && styles.hidden]} accessibilityElementsHidden={!active} importantForAccessibility={active ? "auto" : "no-hide-descendants"}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <View style={styles.heading}><Text accessibilityRole="header" style={styles.title}>Follow-ups</Text><Text style={styles.caption}>The next steps, who owns them and when they are due. Only your team sees these.</Text></View>
      {/* One line to add the next step. Who owns it and when it is due appear once you start, so the list stays in view. */}
      <View style={styles.formCard}><TaskForm client={client} id={id} people={people} peopleError={peopleError} onSaved={onChanged} /></View>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <Text style={styles.section}>{open.length} open</Text>
      {!open.length ? <Text style={styles.caption}>No open follow-ups. Add the next step above.</Text> : null}
      {open.map(task => <TaskRow key={task.id} task={task} busy={busy === task.id} disabled={!!busy} onToggle={() => void toggle(task)} onEdit={() => setEditing(task)} />)}
      {done.length ? <Text style={styles.section}>{done.length} completed</Text> : null}
      {done.map(task => <TaskRow key={task.id} task={task} busy={busy === task.id} disabled={!!busy} onToggle={() => void toggle(task)} onEdit={() => setEditing(task)} />)}
    </ScrollView>
    {editing ? <Modal visible transparent animationType="fade" onRequestClose={() => { if (!busy) setEditing(null); }}>
      <View style={styles.scrim}><View style={styles.dialog} accessibilityViewIsModal><ScrollView contentContainerStyle={styles.dialogContent} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.title}>Edit follow-up</Text>
        <TaskForm key={editing.id} client={client} id={id} task={editing} people={people} peopleError={peopleError} onBusy={value => setBusy(value ? editing.id : null)} onSaved={() => { setEditing(null); onChanged(); }} onCancel={() => setEditing(null)} />
      </ScrollView></View></View>
    </Modal> : null}
  </View>;
}

function TaskRow({ task, busy, disabled, onToggle, onEdit }: { task: InboxTask; busy: boolean; disabled: boolean; onToggle: () => void; onEdit: () => void }) {
  const styles = useStyles();
  const done = task.status === "done";
  return <View style={styles.task}>
    <View style={styles.taskCopy}>
      <Text style={[styles.taskText, done && styles.doneText]}>{task.text}</Text>
      <Text style={styles.caption}>{task.assigneeName || "Unassigned"} · <Text style={!done && inboxOverdue(task.dueDate) ? styles.overdue : undefined}>{inboxDueLabel(task.dueDate)}</Text></Text>
      <Text style={styles.meta}>{done ? `Completed ${task.completedAt ? new Date(task.completedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : ""}` : `Added by ${task.createdByName}`}</Text>
    </View>
    <ButtonGroup style={styles.taskActions}><Button label={done ? "Reopen" : "Complete"} accessibilityLabel={`${done ? "Reopen" : "Complete"} ${task.text}`} compact kind="secondary" busy={busy} disabled={disabled} onPress={onToggle} /><Button label="Edit" accessibilityLabel={`Edit ${task.text}`} compact kind="link" disabled={disabled} onPress={onEdit} /></ButtonGroup>
  </View>;
}

function TaskForm({ client, id, task, people, peopleError, onSaved, onCancel, onBusy }: { client: InboxClient; id: string; task?: InboxTask; people: readonly CasePerson[]; peopleError: string; onSaved: () => void; onCancel?: () => void; onBusy?: (busy: boolean) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [text, setText] = useState("");
  const [owner, setOwner] = useState<string | null>(task?.assigneeId ?? null);
  const [dueDate, setDueDate] = useState(task?.dueDate ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft] = useState(() => createInboxDraftId(randomUUID));
  const [started, setStarted] = useState(false);
  const whole = !!task || started || !!text || !!owner || !!dueDate;
  const controller = useRef(new AbortController());
  useEffect(() => { controller.current = new AbortController(); return () => controller.current.abort(); }, []);
  const clear = () => { draft.reset(); setText(""); setOwner(null); setDueDate(""); setError(""); setStarted(false); };
  const save = async () => {
    if (busy || (!task && !text.trim())) return;
    setError("");
    let due: string | null;
    try { due = parseInboxDueDate(dueDate); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Enter a due date as YYYY-MM-DD."); return; }
    setBusy(true); onBusy?.(true);
    try {
      const patch: InboxTaskPatch = { assigneeId: owner, dueDate: due };
      if (task) await client.updateTask(id, task.id, patch, draft.current(), controller.current.signal);
      else await client.addTask(id, { text: text.trim(), assigneeId: owner, dueDate: due }, draft.current(), controller.current.signal);
      if (controller.current.signal.aborted) return;
      clear(); onSaved();
    } catch (cause) { if (!controller.current.signal.aborted) setError(`${cause instanceof Error ? cause.message : "Couldn't save this follow-up."} Your details are kept. Try again.`); }
    finally { if (!controller.current.signal.aborted) { setBusy(false); onBusy?.(false); } }
  };
  return <View style={styles.form}>
    {task ? <Text style={styles.taskText}>{task.text}</Text> : <View style={styles.field}><Text style={styles.label}>Add a follow-up</Text><TextInput accessibilityLabel="Follow-up" value={text} onFocus={() => setStarted(true)} onChangeText={value => { setText(value); draft.reset(); }} maxLength={2000} editable={!busy} multiline style={[styles.input, whole && styles.taskInput]} placeholder="What needs to happen next?" placeholderTextColor={colors.muted} /></View>}
    {whole ? <>
      <View style={styles.fields}>
        <View style={styles.ownerField}><CaseOwnerPicker label="Owner" value={owner} people={people} error={peopleError} disabled={busy} onChange={value => { setOwner(value); draft.reset(); }} /></View>
        <View style={styles.dateField}><Text style={styles.label}>Due date (optional)</Text><TextInput accessibilityLabel="Due date" value={dueDate} onChangeText={value => { setDueDate(value); draft.reset(); }} maxLength={10} editable={!busy} placeholder="YYYY-MM-DD" placeholderTextColor={colors.muted} autoCapitalize="none" style={styles.input} /><Text style={styles.caption}>In UTC.</Text></View>
      </View>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <ButtonGroup align="end"><Button label="Cancel" kind="secondary" compact disabled={busy} onPress={onCancel ?? clear} /><Button label={task ? "Save follow-up" : "Add follow-up"} compact disabled={!task && !text.trim()} busy={busy} onPress={() => void save()} /></ButtonGroup>
    </> : null}
  </View>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  input: controls.input,
  root: { flex: 1, minHeight: 0 }, hidden: { display: "none" },
  content: { padding: space.side, paddingBottom: space.xxl, gap: space.sm },
  heading: { gap: space.xxs },
  title: { ...typography.heading, color: colors.ink },
  caption: { ...typography.caption, color: colors.muted },
  section: { ...typography.label, color: colors.muted, marginTop: space.sm },
  label: { ...typography.label, color: colors.ink },
  formCard: { padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface },
  form: { gap: space.sm },
  field: { gap: space.xxs },
  fields: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  ownerField: { flex: 1, minWidth: 150 },
  dateField: { flex: 1, minWidth: 150, gap: space.xxs },
  taskInput: { minHeight: 70, textAlignVertical: "top" },
  // The words and who and when on the left; Complete and Edit on the same line when there is room, under it when not.
  task: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.sm, rowGap: space.xs, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  taskCopy: { flexGrow: 1, flexShrink: 1, flexBasis: 240, minWidth: 0, gap: space.xxs },
  taskActions: { marginLeft: "auto" },
  taskText: { ...typography.bodyStrong, color: colors.ink },
  doneText: { color: colors.muted },
  overdue: { color: colors.red },
  meta: { ...typography.meta, color: colors.muted },
  error: { ...typography.caption, color: colors.red },
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", padding: space.lg, backgroundColor: colors.scrim },
  dialog: { width: "100%", maxWidth: 520, maxHeight: "90%", backgroundColor: colors.background, borderRadius: radius.lg },
  dialogContent: { padding: space.lg, gap: space.md },
}));
