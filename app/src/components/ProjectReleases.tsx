import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { AppIcon } from "./AppIcon";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { Avatar } from "./Messaging";
import { useWideLayout } from "../lib/layout";
import { DATE_SHAPE, STATUSES, STATUS_LABEL, myTodos, orderReleases, releaseDate, releaseProgress, shortStage, type Todo } from "../lib/releases";
import { api, ServerError, type Account, type Project, type ProjectRelease, type ReleaseItem, type StageCell, type StageStatus } from "../lib/server";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

// The Releases tab: what ships when, each item's track through the project's stages, and the
// cells assigned to you. Phones show an item as a card with a chip per stage; wide screens show
// a table of items by stages. Tapping a cell sets its status, owner and note.
type Props = { account: Account; project: Project; onChange: (project: Project) => void };
type CellRef = { releaseId: string; itemId: string; stage: string };

// Save a change, then show the project the server sends back.
function useRun(onChange: (project: Project) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<Project>, fallback: string) => {
    if (busy) return false;
    setBusy(true); setError(null);
    try { onChange(await work()); return true; }
    catch (e) { setError(e instanceof ServerError ? e.message : fallback); return false; }
    finally { setBusy(false); }
  };
  return { busy, error, setError, run };
}

// Status colors with their words: done green, doing IRS blue, blocked red, to do neutral.
function useTones() {
  const { colors } = useTheme();
  return {
    todo: { bg: colors.surface, border: colors.line, fg: colors.muted },
    doing: { bg: colors.blueSoft, border: colors.blueSoft, fg: colors.blueDark },
    done: { bg: colors.greenSoft, border: colors.greenSoft, fg: colors.greenDark },
    blocked: { bg: colors.redSoft, border: colors.redSoft, fg: colors.red },
  } satisfies Record<StageStatus, { bg: string; border: string; fg: string }>;
}

export function ProjectReleases({ account, project, onChange }: Props) {
  const styles = useStyles();
  const { colors } = useTheme();
  const wide = useWideLayout();
  const [release, setRelease] = useState<ProjectRelease | "new" | null>(null);
  const [item, setItem] = useState<{ release: ProjectRelease; item: ReleaseItem | null } | null>(null);
  const [cell, setCell] = useState<CellRef | null>(null);
  const { upcoming, past } = orderReleases(project.releases);
  const todos = myTodos(project, account.user.id);
  const { canWrite, canEdit, stages } = project;
  const openTodo = (t: Todo) => setCell({ releaseId: t.release.id, itemId: t.item.id, stage: t.stage });
  const block = (r: ProjectRelease) => <ReleaseBlock key={r.id} release={r} stages={stages} wide={wide} canWrite={canWrite}
    onEdit={() => setRelease(r)} onAddItem={() => setItem({ release: r, item: null })} onEditItem={i => setItem({ release: r, item: i })}
    onCell={(i, stage) => setCell({ releaseId: r.id, itemId: i.id, stage })} />;
  return (
    <ScrollView contentContainerStyle={styles.content}>
      {project.releases.length ? <View style={styles.todos}>
        <Text accessibilityRole="header" style={styles.todosTitle}>My to-dos</Text>
        {todos.length ? todos.map(t => <Pressable key={`${t.release.id}:${t.item.id}:${t.stage}`} accessibilityRole="button" accessibilityLabel={`${t.item.title}, ${t.stage}, ${t.release.name}, ${releaseDate(t.release.date)}: ${STATUS_LABEL[t.cell.status]}. Change`}
          onPress={() => openTodo(t)} style={({ pressed }) => [styles.todoRow, pressed && { opacity: 0.7 }]}>
          <Text style={styles.todoText} numberOfLines={1}>{t.item.title} · {t.stage} · {releaseDate(t.release.date)}</Text>
          <StatusPill status={t.cell.status} />
        </Pressable>) : <Text style={styles.todosEmpty}>Nothing is assigned to you right now.</Text>}
      </View> : null}
      {!stages.length && project.releases.length ? <Text style={styles.hint}>{canEdit ? "This project has no stages yet. Add them in About (like Build, Design, QA) and every item gets a track to follow, with an owner for each step." : "This project has no stages yet, so items have no track to follow. An owner can add stages in About."}</Text> : null}

      {project.releases.length ? <View style={styles.sectionRow}>
        <Text accessibilityRole="header" style={styles.section}>{upcoming.length ? "Upcoming" : "Releases"}</Text>
        {canWrite ? <Pressable accessibilityRole="button" accessibilityLabel="Add release" onPress={() => setRelease("new")} hitSlop={8} style={styles.sectionAction}><Text style={styles.link}>Add release</Text></Pressable> : null}
      </View> : <View style={styles.empty}>
        <AppIcon name="project" size={32} color={colors.blue} />
        <Text accessibilityRole="header" style={styles.emptyTitle}>No releases yet</Text>
        <Text style={styles.emptyBody}>{canWrite ? "A release is a date and the items shipping in it. Each item moves through the project's stages, with a person on each step." : "When someone plans a release, what ships when and who owns each step shows up here."}</Text>
        {canWrite ? <Button label="Add release" onPress={() => setRelease("new")} style={styles.emptyAction} /> : null}
      </View>}
      {upcoming.map(block)}
      {upcoming.length && past.length ? <View style={styles.sectionRow}><Text accessibilityRole="header" style={styles.section}>Past</Text></View> : null}
      {past.map(block)}

      {release ? <ReleaseDialog account={account} project={project} release={release} onClose={() => setRelease(null)} onChange={onChange} /> : null}
      {item ? <ItemDialog account={account} project={project} release={item.release} item={item.item} onClose={() => setItem(null)} onChange={onChange} /> : null}
      {cell ? <CellEditor account={account} project={project} target={cell} onClose={() => setCell(null)} onChange={onChange} /> : null}
    </ScrollView>
  );
}

function ReleaseBlock({ release, stages, wide, canWrite, onEdit, onAddItem, onEditItem, onCell }: { release: ProjectRelease; stages: string[]; wide: boolean; canWrite: boolean; onEdit: () => void; onAddItem: () => void; onEditItem: (item: ReleaseItem) => void; onCell: (item: ReleaseItem, stage: string) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { done, total } = releaseProgress(release, stages);
  const when = releaseDate(release.date);
  const meta = total ? `${when} · ${done} of ${total} done` : when;
  const table = wide && stages.length > 0;
  return (
    <View style={styles.release}>
      <Pressable accessibilityRole={canWrite ? "button" : undefined} accessibilityLabel={canWrite ? `${release.name}, ${meta}. Change` : `${release.name}, ${meta}`} disabled={!canWrite} onPress={onEdit}
        style={({ pressed }) => [styles.releaseHead, pressed && { opacity: 0.7 }]}>
        <View style={styles.releaseCopy}>
          <Text style={styles.releaseName}>{release.name}</Text>
          <Text style={styles.releaseMeta}>{meta}</Text>
        </View>
        {canWrite ? <AppIcon name="chevronRight" size={16} color={colors.muted} /> : null}
      </Pressable>
      {release.items.length === 0 ? <Text style={styles.noItems}>{canWrite ? "No items yet. Add the features shipping in this release." : "No items yet."}</Text>
        : table ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tableScroll}>
          <View style={styles.table}>
            <View style={styles.tableRow}>
              <Text style={[styles.th, styles.itemCol]}>Item</Text>
              {stages.map(s => <Text key={s} numberOfLines={1} style={[styles.th, styles.stageCol]}>{s}</Text>)}
            </View>
            {release.items.map(item => <View key={item.id} style={styles.tableRow}>
              <Pressable accessibilityRole={canWrite ? "button" : undefined} accessibilityLabel={canWrite ? `${item.title}. Rename or remove` : item.title} disabled={!canWrite} onPress={() => onEditItem(item)} style={styles.itemCol}>
                <Text style={styles.itemTitle} numberOfLines={2}>{item.title}</Text>
              </Pressable>
              {stages.map(s => <View key={s} style={styles.stageCol}>
                <CellChip cell={item.stages[s]} stage={s} label={`${item.title}, ${s}`} onPress={() => onCell(item, s)} />
                {item.stages[s]?.note ? <Text style={styles.cellNote} numberOfLines={1}>{item.stages[s]!.note}</Text> : null}
              </View>)}
            </View>)}
          </View>
        </ScrollView>
        : release.items.map(item => <View key={item.id} style={styles.card}>
          <Pressable accessibilityRole={canWrite ? "button" : undefined} accessibilityLabel={canWrite ? `${item.title}. Rename or remove` : item.title} disabled={!canWrite} onPress={() => onEditItem(item)} style={styles.cardHead}>
            <Text style={styles.itemTitle}>{item.title}</Text>
            {canWrite ? <AppIcon name="more" size={16} color={colors.muted} /> : null}
          </Pressable>
          {stages.length ? <View style={styles.chips}>{stages.map(s => <CellChip key={s} compact cell={item.stages[s]} stage={s} label={`${item.title}, ${s}`} onPress={() => onCell(item, s)} />)}</View> : null}
          {stages.filter(s => item.stages[s]?.note).map(s => <Text key={s} style={styles.cellNote}>{shortStage(s)}: {item.stages[s]!.note}</Text>)}
        </View>)}
      {canWrite ? <Pressable accessibilityRole="button" accessibilityLabel={`Add item to ${release.name}`} onPress={onAddItem} style={({ pressed }) => [styles.addItem, pressed && { backgroundColor: colors.surface }]}>
        <AppIcon name="plus" size={16} color={colors.blue} />
        <Text style={styles.link}>Add item</Text>
      </Pressable> : null}
    </View>
  );
}

// One stage of one item. Wide: the status word plus who owns it. Compact (phones): the stage too.
function CellChip({ cell, stage, label, compact = false, onPress }: { cell?: StageCell; stage: string; label: string; compact?: boolean; onPress: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const status = cell?.status ?? "todo";
  const tone = useTones()[status];
  const owner = cell?.ownerName || "";
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${STATUS_LABEL[status]}, ${owner || "nobody yet"}${cell?.note ? `. ${cell.note}` : ""}. Change`} onPress={onPress}
      style={({ pressed }) => [styles.chip, { backgroundColor: tone.bg, borderColor: tone.border }, pressed && { opacity: 0.7 }]}>
      <Text numberOfLines={1} style={[styles.chipText, { color: tone.fg }]}>{compact ? `${shortStage(stage)} · ${STATUS_LABEL[status]}` : STATUS_LABEL[status]}</Text>
      {cell?.owner ? <Avatar name={owner} userId={cell.owner} size={22} /> : <View style={styles.nobody}><AppIcon name="user" size={12} color={colors.muted} /></View>}
    </Pressable>
  );
}

function StatusPill({ status }: { status: StageStatus }) {
  const styles = useStyles();
  const tone = useTones()[status];
  return <View style={[styles.pill, { backgroundColor: tone.bg, borderColor: tone.border }]}><Text style={[styles.chipText, { color: tone.fg }]}>{STATUS_LABEL[status]}</Text></View>;
}

// Set a cell: its status, who owns it, and a note. The owner or anyone who can write; others can look.
function CellEditor({ account, project, target, onClose, onChange }: { account: Account; project: Project; target: CellRef; onClose: () => void; onChange: (project: Project) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const tones = useTones();
  const { busy, error, run } = useRun(onChange);
  const release = project.releases.find(r => r.id === target.releaseId);
  const item = release?.items.find(i => i.id === target.itemId);
  const cell = item?.stages[target.stage];
  const [note, setNote] = useState(cell?.note ?? "");
  if (!release || !item) return null;
  const canChange = project.canWrite || cell?.owner === account.user.id;
  const people = project.people.filter(p => p.id);
  const set = (change: { status?: StageStatus; owner?: string | null; note?: string }) => void run(() => api.setStageCell(account, project.id, release.id, item.id, { stage: target.stage, ...change }), "Couldn't save that");
  const saveNote = () => { if (canChange && note.trim() !== (cell?.note ?? "")) set({ note: note.trim() }); };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.fill}>
      <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={onClose}>
        <Pressable accessibilityViewIsModal style={styles.sheet} onPress={() => {}}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text accessibilityRole="header" style={styles.sheetTitle}>{item.title} · {target.stage}</Text>
            <Text style={styles.sheetMeta}>{release.name} · {releaseDate(release.date)}</Text>
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            {!canChange ? <Text style={styles.help}>{cell?.ownerName ? `Only ${cell.ownerName}, or someone who can write, can change this.` : "Only someone who can write can change this."}</Text> : null}
            <Text style={styles.label}>Status</Text>
            <View style={styles.choices}>
              {STATUSES.map(s => { const on = (cell?.status ?? "todo") === s; return <Pressable key={s} accessibilityRole="button" accessibilityState={{ selected: on, disabled: !canChange }} disabled={!canChange || busy} onPress={() => { if (!on) set({ status: s }); }}
                style={[styles.choice, on && { backgroundColor: tones[s].bg, borderColor: tones[s].fg }]}>
                <Text style={[styles.choiceText, on && { color: tones[s].fg }]}>{STATUS_LABEL[s]}</Text>
              </Pressable>; })}
            </View>
            <Text style={styles.label}>Owner</Text>
            <Pressable accessibilityRole="button" accessibilityState={{ selected: !cell?.owner, disabled: !canChange }} disabled={!canChange || busy} onPress={() => { if (cell?.owner) set({ owner: null }); }} style={styles.personRow}>
              <View style={styles.nobodyBig}><AppIcon name="user" size={16} color={colors.muted} /></View>
              <Text style={styles.personName}>Nobody yet</Text>
              {!cell?.owner ? <AppIcon name="check" size={18} color={colors.blue} /> : null}
            </Pressable>
            {people.map(p => <Pressable key={p.key} accessibilityRole="button" accessibilityState={{ selected: cell?.owner === p.id, disabled: !canChange }} disabled={!canChange || busy} onPress={() => { if (cell?.owner !== p.id) set({ owner: p.id! }); }} style={styles.personRow}>
              <Avatar name={p.name} size={28} userId={p.id} />
              <Text style={styles.personName} numberOfLines={1}>{p.id === account.user.id ? `${p.name} (you)` : p.name}</Text>
              {cell?.owner === p.id ? <AppIcon name="check" size={18} color={colors.blue} /> : null}
            </Pressable>)}
            {people.length === 0 ? <Text style={styles.help}>Add people to the project in About to assign this.</Text> : null}
            <Text style={styles.label}>Note</Text>
            <TextInput accessibilityLabel="Note" editable={canChange} value={note} onChangeText={setNote} onBlur={saveNote} maxLength={200} placeholder="Why it's blocked, what's left, a link" placeholderTextColor={colors.muted} style={[styles.input, !canChange && styles.readonly]} />
            <Button label="Done" kind="secondary" busy={busy} onPress={() => { saveNote(); onClose(); }} style={styles.doneButton} />
          </ScrollView>
        </Pressable>
      </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// Add a release, or rename, move or delete one.
function ReleaseDialog({ account, project, release, onClose, onChange }: { account: Account; project: Project; release: ProjectRelease | "new"; onClose: () => void; onChange: (project: Project) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { busy, error, setError, run } = useRun(onChange);
  const adding = release === "new";
  const [name, setName] = useState(adding ? "" : release.name);
  const [date, setDate] = useState(adding ? "" : release.date);
  const [confirm, setConfirm] = useState(false);
  const save = async () => {
    const body = { name: name.trim(), date: date.trim() };
    if (!body.name) return setError("Name the release");
    if (!DATE_SHAPE.test(body.date)) return setError("Dates look like 2026-11-17");
    if (await run(() => adding ? api.addRelease(account, project.id, body) : api.updateRelease(account, project.id, release.id, body), "Couldn't save the release")) onClose();
  };
  const remove = async () => { if (!adding && await run(() => api.deleteRelease(account, project.id, release.id), "Couldn't delete the release")) onClose(); };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.fill}>
      <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={onClose}>
        <Pressable accessibilityViewIsModal style={styles.sheet} onPress={() => {}}>
          <Text accessibilityRole="header" style={styles.sheetTitle}>{adding ? "Add release" : "Release"}</Text>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Text style={styles.label}>Name</Text>
          <TextInput accessibilityLabel="Release name" autoFocus={adding} value={name} onChangeText={setName} maxLength={60} placeholder="e.g. November 17" placeholderTextColor={colors.muted} style={styles.input} />
          <Text style={styles.label}>Date</Text>
          <TextInput accessibilityLabel="Release date, year-month-day" value={date} onChangeText={setDate} onSubmitEditing={() => void save()} maxLength={10} keyboardType="numbers-and-punctuation" autoCorrect={false}
            placeholder="2026-11-17" placeholderTextColor={colors.muted} style={styles.input} />
          <Text style={styles.help}>Year, month, day.</Text>
          <View style={styles.actions}>
            {adding ? <Button label="Cancel" kind="secondary" onPress={onClose} style={{ flex: 1 }} /> : <Button label="Delete" kind="danger" onPress={() => setConfirm(true)} style={{ flex: 1 }} />}
            <Button label={adding ? "Add release" : "Save"} busy={busy} disabled={!name.trim() || !date.trim()} onPress={() => void save()} style={{ flex: 1 }} />
          </View>
          <ConfirmDialog visible={confirm} title="Delete this release?" description="Its items and who owns each step go with it. This can't be undone." confirmLabel="Delete release" busy={busy} error={error}
            onCancel={() => setConfirm(false)} onConfirm={() => void remove()} />
        </Pressable>
      </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// Add an item to a release, or rename or remove one.
function ItemDialog({ account, project, release, item, onClose, onChange }: { account: Account; project: Project; release: ProjectRelease; item: ReleaseItem | null; onClose: () => void; onChange: (project: Project) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { busy, error, setError, run } = useRun(onChange);
  const [title, setTitle] = useState(item?.title ?? "");
  const save = async () => {
    const next = title.trim();
    if (!next) return setError("Give the item a name");
    if (await run(() => item ? api.updateReleaseItem(account, project.id, release.id, item.id, next) : api.addReleaseItem(account, project.id, release.id, next), "Couldn't save the item")) onClose();
  };
  const remove = async () => { if (item && await run(() => api.deleteReleaseItem(account, project.id, release.id, item.id), "Couldn't remove the item")) onClose(); };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.fill}>
      <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={onClose}>
        <Pressable accessibilityViewIsModal style={styles.sheet} onPress={() => {}}>
          <Text accessibilityRole="header" style={styles.sheetTitle}>{item ? "Item" : "Add item"}</Text>
          <Text style={styles.sheetMeta}>{release.name} · {releaseDate(release.date)}</Text>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Text style={styles.label}>Name</Text>
          <TextInput accessibilityLabel="Item name" autoFocus value={title} onChangeText={setTitle} onSubmitEditing={() => void save()} returnKeyType="done" maxLength={80} placeholder="e.g. Guest mode" placeholderTextColor={colors.muted} style={styles.input} />
          {!item && project.stages.length ? <Text style={styles.help}>It starts at "To do" in every stage: {project.stages.join(", ")}.</Text> : null}
          <View style={styles.actions}>
            {item ? <Button label="Remove" kind="danger" busy={busy} onPress={() => void remove()} style={{ flex: 1 }} /> : <Button label="Cancel" kind="secondary" onPress={onClose} style={{ flex: 1 }} />}
            <Button label={item ? "Save" : "Add item"} busy={busy} disabled={!title.trim()} onPress={() => void save()} style={{ flex: 1 }} />
          </View>
        </Pressable>
      </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  content: { paddingBottom: space.xxl },
  error: { ...typography.caption, color: colors.red, marginTop: space.sm },
  hint: { ...typography.caption, color: colors.muted, marginHorizontal: space.side, marginTop: space.md },
  // My to-dos: the cells assigned to you, soonest release first. A neutral card, so every status tint shows on it.
  todos: { marginHorizontal: space.side, marginTop: space.md, paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: radius.lg },
  todosTitle: { ...typography.bodyStrong, color: colors.brandText, paddingVertical: space.xxs },
  todosEmpty: { ...typography.caption, color: colors.muted, paddingVertical: space.xxs },
  todoRow: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: space.sm },
  todoText: { ...typography.body, color: colors.ink, flex: 1, minWidth: 0 },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.lg, paddingLeft: space.side, paddingRight: space.xs },
  section: { ...typography.label, color: colors.muted },
  sectionAction: { minHeight: 44, paddingHorizontal: space.sm, justifyContent: "center" },
  link: { ...typography.bodyStrong, color: colors.blue },
  // One release: a header, then its items.
  release: { marginTop: space.sm, marginHorizontal: space.side, borderWidth: 1, borderColor: colors.line, borderRadius: radius.lg, overflow: "hidden" },
  releaseHead: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: colors.surface },
  releaseCopy: { flex: 1, minWidth: 0 },
  releaseName: { ...typography.heading, color: colors.ink },
  releaseMeta: { ...typography.caption, color: colors.muted, marginTop: 2 },
  noItems: { ...typography.caption, color: colors.muted, paddingHorizontal: space.md, paddingVertical: space.sm },
  // Phones: a card per item with a chip per stage.
  card: { paddingHorizontal: space.md, paddingTop: space.xs, paddingBottom: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  cardHead: { minHeight: 32, flexDirection: "row", alignItems: "center", gap: space.xs },
  itemTitle: { ...typography.bodyStrong, color: colors.ink, flex: 1, minWidth: 0 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginTop: space.xxs },
  chip: { minHeight: 32, flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: space.sm, paddingRight: 5, borderRadius: radius.pill, borderWidth: 1 },
  chipText: { ...typography.captionStrong, flexShrink: 1 },
  pill: { minHeight: 26, justifyContent: "center", paddingHorizontal: space.sm, borderRadius: radius.pill, borderWidth: 1 },
  nobody: { width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  nobodyBig: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  cellNote: { ...typography.meta, color: colors.muted, marginTop: space.xxs },
  // Wide screens: items down, stages across.
  tableScroll: { minWidth: "100%" },
  table: { flexGrow: 1 },
  tableRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  th: { ...typography.label, color: colors.muted, paddingVertical: space.xs },
  itemCol: { flex: 1, minWidth: 160, paddingVertical: space.sm, paddingHorizontal: space.xxs, justifyContent: "center" },
  stageCol: { width: 140, paddingVertical: 6, paddingHorizontal: space.xxs, justifyContent: "center" },
  addItem: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  empty: { marginTop: space.xl, alignItems: "center", paddingHorizontal: space.lg },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center", marginTop: space.md },
  emptyBody: { ...typography.body, color: colors.muted, textAlign: "center", marginTop: space.xs, maxWidth: 360 },
  emptyAction: { width: "100%", maxWidth: 360, marginTop: space.lg },
  // Editors: a centered card on every screen size.
  fill: { flex: 1 },
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: space.side, backgroundColor: "rgba(17,46,81,0.42)" },
  sheet: { width: "100%", maxWidth: 440, maxHeight: "90%", backgroundColor: colors.background, borderRadius: radius.lg, padding: space.side },
  sheetTitle: { ...typography.heading, color: colors.ink },
  sheetMeta: { ...typography.caption, color: colors.muted, marginTop: 2 },
  label: { ...typography.label, color: colors.muted, marginTop: space.md, marginBottom: space.xs },
  help: { ...typography.caption, color: colors.muted, marginTop: space.xs },
  input: { ...typography.body, color: colors.ink, minHeight: 48, paddingHorizontal: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
  readonly: { color: colors.muted, backgroundColor: colors.surface },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  // Four of these fit one row on a phone.
  choice: { minHeight: 40, paddingHorizontal: space.sm, justifyContent: "center", borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderStrong },
  choiceText: { ...typography.bodyStrong, color: colors.ink },
  personRow: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm },
  personName: { ...typography.body, color: colors.ink, flex: 1, minWidth: 0 },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.lg },
  doneButton: { marginTop: space.lg },
}));
