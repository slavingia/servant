import { Radio } from "./Radio";
import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { AppIcon } from "./AppIcon";
import { Button } from "./Button";
import { CheckBox } from "./CheckBox";
import { ConfirmDialog } from "./ConfirmDialog";
import { Avatar } from "./Messaging";
import { useWideLayout } from "../lib/layout";
import { DATE_SHAPE, STATUSES, STATUS_LABEL, featureDone, myTodos, orderReleases, ownsCell, releaseDate, releaseProgress, shortStage, stageReviewers, type Todo } from "../lib/releases";
import { api, ServerError, type Account, type Project, type ProjectRelease, type ReleaseItem, type ReleasePart, type Reviewer, type StageCell, type StageStatus } from "../lib/server";
import { radius, space, typography, useTheme, createThemedStyles, linkUnderline } from "../lib/theme";

// The Releases tab: what ships when, each feature's checklist (its stages and its parts), and the
// cells assigned to you. A release's last row is the Shipped box: it stays locked until every feature is checked. Phones show an item as a card with a chip per stage; wide screens show
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

// Status colors with their words: done green, doing brand blue, blocked red, to do neutral.
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
  const [part, setPart] = useState<{ release: ProjectRelease; item: ReleaseItem; part: ReleasePart | null } | null>(null);
  const { busy, error, run } = useRun(onChange);
  const { upcoming, past } = orderReleases(project.releases);
  const todos = myTodos(project, account.user.id);
  const { canWrite, stages } = project;
  const openTodo = (t: Todo) => setCell({ releaseId: t.release.id, itemId: t.item.id, stage: t.stage });
  const block = (r: ProjectRelease) => <ReleaseBlock key={r.id} release={r} stages={stages} reviewers={project} wide={wide} canWrite={canWrite}
    onEdit={() => setRelease(r)} onAddItem={() => setItem({ release: r, item: null })} onEditItem={i => setItem({ release: r, item: i })}
    onCell={(i, stage) => setCell({ releaseId: r.id, itemId: i.id, stage })} busy={busy}
    onAddPart={i => setPart({ release: r, item: i, part: null })} onEditPart={(i, x) => setPart({ release: r, item: i, part: x })}
    onTickItem={(i, done) => void run(() => api.setReleaseItemDone(account, project.id, r.id, i.id, done), "Couldn't save that")}
    onTickPart={(i, x) => void run(() => api.updateReleasePart(account, project.id, r.id, i.id, x.id, { done: !x.done }), "Couldn't save that")}
    onShip={shipped => void run(() => api.setReleaseShipped(account, project.id, r.id, shipped), "Couldn't save that")} />;
  return (
    <ScrollView contentContainerStyle={styles.content}>
      {project.releases.length ? <View style={styles.todos}>
        <Text accessibilityRole="header" style={styles.todosTitle}>My to-dos</Text>
        {todos.length ? todos.map(t => <Pressable key={`${t.release.id}:${t.item.id}:${t.stage}`} accessibilityRole="button" accessibilityLabel={`${t.item.title}, ${t.stage}, ${t.release.name}, ${releaseDate(t.release.date)}: ${STATUS_LABEL[t.cell.status]}. Change`}
          onPress={() => openTodo(t)} style={({ pressed }) => [styles.todoRow, pressed && { opacity: 0.7 }]}>
          <Text style={styles.todoText}>{t.item.title} · {t.stage} · {releaseDate(t.release.date)}</Text>
          <StatusPill status={t.cell.status} />
        </Pressable>) : <Text style={styles.todosEmpty}>No assignments</Text>}
      </View> : null}
      {error ? <Text accessibilityRole="alert" style={[styles.error, styles.hint]}>{error}</Text> : null}

      {project.releases.length ? <View style={styles.sectionRow}>
        <Text accessibilityRole="header" style={styles.section}>{upcoming.length ? "Upcoming" : "Releases"}</Text>
        {canWrite ? <Pressable accessibilityRole="button" accessibilityLabel="Add release" onPress={() => setRelease("new")} style={styles.sectionAction}><Text style={styles.link}>Add release</Text></Pressable> : null}
      </View> : <View style={styles.empty}>
        <AppIcon name="project" size={32} color={colors.blue} />
        <Text accessibilityRole="header" style={styles.emptyTitle}>No releases</Text>
        {canWrite ? <Button label="Add release" onPress={() => setRelease("new")} style={styles.emptyAction} /> : null}
      </View>}
      {upcoming.map(block)}
      {upcoming.length && past.length ? <View style={styles.sectionRow}><Text accessibilityRole="header" style={styles.section}>Past</Text></View> : null}
      {past.map(block)}

      {release ? <ReleaseDialog account={account} project={project} release={release} onClose={() => setRelease(null)} onChange={onChange} /> : null}
      {item ? <ItemDialog account={account} project={project} release={item.release} item={item.item} onClose={() => setItem(null)} onChange={onChange} /> : null}
      {part ? <PartDialog account={account} project={project} release={part.release} item={part.item} part={part.part} onClose={() => setPart(null)} onChange={onChange} /> : null}
      {cell ? <CellEditor account={account} project={project} target={cell} onClose={() => setCell(null)} onChange={onChange} /> : null}
    </ScrollView>
  );
}

type BlockProps = {
  release: ProjectRelease; stages: string[]; reviewers: Pick<Project, "reviewers">; wide: boolean; canWrite: boolean; busy: boolean;
  onEdit: () => void; onAddItem: () => void; onEditItem: (item: ReleaseItem) => void; onCell: (item: ReleaseItem, stage: string) => void;
  onTickItem: (item: ReleaseItem, done: boolean) => void; onAddPart: (item: ReleaseItem) => void; onEditPart: (item: ReleaseItem, part: ReleasePart) => void;
  onTickPart: (item: ReleaseItem, part: ReleasePart) => void; onShip: (shipped: boolean) => void;
};

function ReleaseBlock({ release, stages, reviewers, wide, canWrite, busy, onEdit, onAddItem, onEditItem, onCell, onTickItem, onAddPart, onEditPart, onTickPart, onShip }: BlockProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { done, total, ready } = releaseProgress(release, stages);
  const when = releaseDate(release.date);
  const shipped = release.shipped ?? null;
  const meta = shipped ? `${when} · Shipped` : total ? `${when} · ${done} of ${total} checked` : when;
  const table = wide && stages.length > 0;
  // The feature's own box, its title (tap to rename or remove), then its parts and an Add part link.
  const head = (item: ReleaseItem) => {
    const on = featureDone(item, stages);
    return <View style={styles.featureRow}>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: !canWrite || busy }} aria-checked={on}
        accessibilityLabel={`${item.title}: ${on ? "checked" : "not checked"}${stages.length || item.parts?.length ? ". Checking it marks every step done" : ""}`}
        disabled={!canWrite || busy} onPress={() => onTickItem(item, !on)} style={styles.boxTarget}>
        <CheckBox on={on} tone="done" />
      </Pressable>
      <Pressable accessibilityRole={canWrite ? "button" : undefined} accessibilityLabel={canWrite ? `${item.title}. Rename or remove` : item.title} disabled={!canWrite} onPress={() => onEditItem(item)} style={styles.featureTitle}>
        <Text style={[styles.itemTitle, on && styles.doneText]}>{item.title}</Text>
        {canWrite && !table ? <AppIcon name="more" size={16} color={colors.muted} /> : null}
      </Pressable>
    </View>;
  };
  const partsOf = (item: ReleaseItem) => <View style={styles.parts}>
    {(item.parts ?? []).map(x => <View key={x.id} style={styles.partRow}>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: x.done, disabled: !canWrite || busy }} aria-checked={x.done} accessibilityLabel={`${item.title}, ${x.title}: ${x.done ? "checked" : "not checked"}`}
        disabled={!canWrite || busy} onPress={() => onTickPart(item, x)} style={styles.boxTarget}>
        <CheckBox on={x.done} tone="done" />
      </Pressable>
      <Pressable accessibilityRole={canWrite ? "button" : undefined} accessibilityLabel={canWrite ? `${x.title}. Rename or remove` : x.title} disabled={!canWrite} onPress={() => onEditPart(item, x)} style={styles.partTitle}>
        <Text style={[styles.partText, x.done && styles.doneText]}>{x.title}</Text>
      </Pressable>
    </View>)}
    {canWrite ? <Pressable accessibilityRole="button" accessibilityLabel={`Add part to ${item.title}`} onPress={() => onAddPart(item)} style={styles.addPart}>
      <View style={styles.boxTarget}><AppIcon name="plus" size={14} color={colors.blue} /></View>
      <Text style={styles.smallLink}>Add part</Text>
    </Pressable> : null}
  </View>;
  return (
    <View style={styles.release}>
      <Pressable accessibilityRole={canWrite ? "button" : undefined} accessibilityLabel={canWrite ? `${release.name}, ${meta}. Change` : `${release.name}, ${meta}`} disabled={!canWrite} onPress={onEdit}
        style={({ pressed }) => [styles.releaseHead, pressed && { opacity: 0.7 }]}>
        <View style={styles.releaseCopy}>
          <Text style={styles.releaseName}>{release.name}</Text>
          <Text style={styles.releaseMeta}>{meta}</Text>
          {total ? <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.bar}><View style={[styles.barFill, { width: `${Math.round(done / total * 100)}%` }]} /></View> : null}
        </View>
        {canWrite ? <AppIcon name="chevronRight" size={16} color={colors.muted} /> : null}
      </Pressable>
      {release.items.length === 0 ? <Text style={styles.noItems}>No features</Text>
        : table ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tableScroll}>
          <View style={styles.table}>
            <View style={styles.tableRow}>
              <Text style={[styles.th, styles.itemCol]}>Feature</Text>
              {stages.map(s => <Text key={s} style={[styles.th, styles.stageCol]}>{s}</Text>)}
            </View>
            {release.items.map(item => <View key={item.id} style={[styles.tableRow, styles.tableTop]}>
              <View style={styles.itemCol}>{head(item)}{partsOf(item)}</View>
              {stages.map(s => <View key={s} style={[styles.stageCol, styles.stageCell]}>
                <CellChip cell={item.stages[s]} stage={s} reviewers={stageReviewers(reviewers, s)} label={`${item.title}, ${s}`} onPress={() => onCell(item, s)} />
                {item.stages[s]?.note ? <Text style={[styles.cellNote, styles.tableNote]}>{item.stages[s]!.note}</Text> : null}
              </View>)}
            </View>)}
          </View>
        </ScrollView>
        : release.items.map(item => <View key={item.id} style={styles.card}>
          {head(item)}
          {stages.length ? <View style={styles.chips}>{stages.map(s => <CellChip key={s} compact cell={item.stages[s]} stage={s} reviewers={stageReviewers(reviewers, s)} label={`${item.title}, ${s}`} onPress={() => onCell(item, s)} />)}</View> : null}
          {stages.filter(s => item.stages[s]?.note).map(s => <Text key={s} style={styles.cellNote}>{shortStage(s)}: {item.stages[s]!.note}</Text>)}
          {partsOf(item)}
        </View>)}
      {canWrite ? <Pressable accessibilityRole="button" accessibilityLabel={`Add feature to ${release.name}`} onPress={onAddItem} style={({ pressed }) => [styles.addItem, pressed && { backgroundColor: colors.surface }]}>
        <AppIcon name="plus" size={16} color={colors.blue} />
        <Text style={styles.link}>Add feature</Text>
      </Pressable> : null}
      <ShipRow release={release} ready={ready} canWrite={canWrite} busy={busy} left={total - done} onShip={onShip} />
    </View>
  );
}

// The final box. Locked (with a lock and how many features are left) until every feature is checked;
// then anyone who can write ticks it. Unticking is always allowed.
function ShipRow({ release, ready, canWrite, busy, left, onShip }: { release: ProjectRelease; ready: boolean; canWrite: boolean; busy: boolean; left: number; onShip: (shipped: boolean) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const shipped = release.shipped ?? null;
  const locked = !shipped && !ready;
  const sub = shipped ? (shipped.byName ? `Checked by ${shipped.byName}` : "Checked")
    : !release.items.length ? "Add a feature first"
    : locked ? (left === 1 ? "Check the last feature first" : `Check the other ${left} features first`)
    : "Every feature is checked";
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: !!shipped, disabled: locked || !canWrite || busy }} aria-checked={!!shipped}
      accessibilityLabel={`Shipped: ${shipped ? "checked" : locked ? "locked" : "not checked"}. ${sub}`}
      disabled={locked || !canWrite || busy} onPress={() => onShip(!shipped)} style={[styles.shipRow, shipped && styles.shipDone]}>
      <View style={styles.boxTarget}>
        {locked ? <View style={styles.lockBox}><AppIcon name="lock" size={14} color={colors.muted} /></View> : <CheckBox on={!!shipped} tone="done" />}
      </View>
      <View style={styles.releaseCopy}>
        <Text style={[styles.itemTitle, locked && styles.lockedText]}>Shipped</Text>
        <Text style={styles.releaseMeta}>{sub}</Text>
      </View>
    </Pressable>
  );
}

// One stage of one item. Wide: the status word plus who owns it. Compact (phones): the stage too.
function CellChip({ cell, stage, label, compact = false, reviewers = [], onPress }: { cell?: StageCell; stage: string; label: string; compact?: boolean; reviewers?: Reviewer[]; onPress: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const status = cell?.status ?? "todo";
  const tone = useTones()[status];
  // With no owner of its own, the cell is its stage's reviewers'.
  const lead = !cell?.owner ? reviewers[0] : undefined;
  const owner = cell?.ownerName || reviewers.map(r => r.id ? r.name : `@${r.github ?? r.key}`).join(" and ");
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${STATUS_LABEL[status]}, ${owner || "nobody yet"}${cell?.note ? `. ${cell.note}` : ""}. Change`} onPress={onPress}
      style={({ pressed }) => [styles.chipTarget, pressed && { opacity: 0.7 }]}>
      <View style={[styles.chip, { backgroundColor: tone.bg, borderColor: tone.border }]}>
        <Text numberOfLines={1} style={[styles.chipText, { color: tone.fg }]}>{compact ? `${shortStage(stage)} · ${STATUS_LABEL[status]}` : STATUS_LABEL[status]}</Text>
        {cell?.owner ? <Avatar name={owner} userId={cell.owner} size={22} />
          : lead ? <Avatar name={lead.name} userId={lead.id} size={22} />
          : <View style={styles.nobody}><AppIcon name="user" size={12} color={colors.muted} /></View>}
        {lead && reviewers.length > 1 ? <Text style={[styles.chipText, styles.more, { color: tone.fg }]}>+{reviewers.length - 1}</Text> : null}
      </View>
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
  const reviewers = stageReviewers(project, target.stage);
  const canChange = project.canWrite || ownsCell(project, cell, target.stage, account.user.id);
  const people = project.people.filter(p => p.id);
  const reviewerNames = reviewers.map(r => r.id ? r.name : `@${r.github ?? r.key}`).join(", ");
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
            {reviewers.length ? <Text style={styles.sheetMeta}>{reviewers.length === 1 ? "Reviewer" : "Reviewers"}: {reviewerNames}</Text> : null}
            {!canChange ? <Text style={styles.help}>{cell?.ownerName ? `Only ${cell.ownerName}, or someone who can write, can change this.` : reviewers.length ? `Only ${reviewerNames}, or someone who can write, can change this.` : "Only someone who can write can change this."}</Text> : null}
            <Text style={styles.label}>Status</Text>
            <View accessibilityRole="radiogroup" accessibilityLabel="Status" style={styles.choices}>
              {STATUSES.map(s => { const on = (cell?.status ?? "todo") === s; return <Radio key={s} accessibilityState={{ checked: on, disabled: !canChange }} aria-checked={on} disabled={!canChange || busy} onPress={() => { if (!on) set({ status: s }); }}
                style={[styles.choice, on && { backgroundColor: tones[s].bg, borderColor: tones[s].fg }]}>
                <Text style={[styles.choiceText, on && { color: tones[s].fg }]}>{STATUS_LABEL[s]}</Text>
              </Radio>; })}
            </View>
            <Text style={styles.label}>Owner</Text>
            <View accessibilityRole="radiogroup" accessibilityLabel="Owner">
            <Radio accessibilityState={{ checked: !cell?.owner, disabled: !canChange }} aria-checked={!cell?.owner} disabled={!canChange || busy} onPress={() => { if (cell?.owner) set({ owner: null }); }} style={styles.personRow}>
              <View style={styles.nobodyBig}><AppIcon name="user" size={16} color={colors.muted} /></View>
              <Text style={styles.personName}>{reviewers.length ? `${target.stage} ${reviewers.length === 1 ? "reviewer" : "reviewers"}: ${reviewerNames}` : "Unassigned"}</Text>
              {!cell?.owner ? <AppIcon name="check" size={18} color={colors.blue} /> : null}
            </Radio>
            {people.map(p => <Radio key={p.key} accessibilityState={{ checked: cell?.owner === p.id, disabled: !canChange }} aria-checked={cell?.owner === p.id} disabled={!canChange || busy} onPress={() => { if (cell?.owner !== p.id) set({ owner: p.id! }); }} style={styles.personRow}>
              <Avatar name={p.name} size={28} userId={p.id} />
              <Text style={styles.personName}>{p.id === account.user.id ? `${p.name} (you)` : p.name}</Text>
              {cell?.owner === p.id ? <AppIcon name="check" size={18} color={colors.blue} /> : null}
            </Radio>)}
            </View>
            {people.length === 0 ? <Text style={styles.help}>Add people to the project in About to assign this.</Text> : null}
            <Text style={styles.label}>Note</Text>
            <TextInput accessibilityLabel="Note" editable={canChange} value={note} onChangeText={setNote} onBlur={saveNote} maxLength={200} placeholder="Optional note" placeholderTextColor={colors.muted} style={[styles.input, !canChange && styles.readonly]} />
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
          <Text style={styles.label}>Date (YYYY-MM-DD)</Text>
          <TextInput accessibilityLabel="Release date, year-month-day" value={date} onChangeText={setDate} onSubmitEditing={() => void save()} maxLength={10} keyboardType="numbers-and-punctuation" autoCorrect={false}
            placeholder="2026-11-17" placeholderTextColor={colors.muted} style={styles.input} />
          <View style={styles.actions}>
            {adding ? <Button label="Cancel" kind="secondary" onPress={onClose} style={{ flex: 1 }} /> : <Button label="Delete" kind="danger" onPress={() => setConfirm(true)} style={{ flex: 1 }} />}
            <Button label={adding ? "Add release" : "Save"} busy={busy} disabled={!name.trim() || !date.trim()} onPress={() => void save()} style={{ flex: 1 }} />
          </View>
          <ConfirmDialog visible={confirm} title="Delete this release?" description="Its features and who owns each step go with it. This can't be undone." confirmLabel="Delete release" busy={busy} error={error}
            onCancel={() => setConfirm(false)} onConfirm={() => void remove()} />
        </Pressable>
      </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// Add a feature to a release, or rename or remove one.
function ItemDialog({ account, project, release, item, onClose, onChange }: { account: Account; project: Project; release: ProjectRelease; item: ReleaseItem | null; onClose: () => void; onChange: (project: Project) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { busy, error, setError, run } = useRun(onChange);
  const [title, setTitle] = useState(item?.title ?? "");
  const save = async () => {
    const next = title.trim();
    if (!next) return setError("Give the feature a name");
    if (await run(() => item ? api.updateReleaseItem(account, project.id, release.id, item.id, next) : api.addReleaseItem(account, project.id, release.id, next), "Couldn't save the feature")) onClose();
  };
  const remove = async () => { if (item && await run(() => api.deleteReleaseItem(account, project.id, release.id, item.id), "Couldn't remove the feature")) onClose(); };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.fill}>
      <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={onClose}>
        <Pressable accessibilityViewIsModal style={styles.sheet} onPress={() => {}}>
          <Text accessibilityRole="header" style={styles.sheetTitle}>{item ? "Feature" : "Add feature"}</Text>
          <Text style={styles.sheetMeta}>{release.name} · {releaseDate(release.date)}</Text>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Text style={styles.label}>Name</Text>
          <TextInput accessibilityLabel="Feature name" autoFocus value={title} onChangeText={setTitle} onSubmitEditing={() => void save()} returnKeyType="done" maxLength={80} placeholder="e.g. Guest mode" placeholderTextColor={colors.muted} style={styles.input} />
          <View style={styles.actions}>
            {item ? <Button label="Remove" kind="danger" busy={busy} onPress={() => void remove()} style={{ flex: 1 }} /> : <Button label="Cancel" kind="secondary" onPress={onClose} style={{ flex: 1 }} />}
            <Button label={item ? "Save" : "Add feature"} busy={busy} disabled={!title.trim()} onPress={() => void save()} style={{ flex: 1 }} />
          </View>
        </Pressable>
      </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// Add a part to a feature, or rename or remove one.
function PartDialog({ account, project, release, item, part, onClose, onChange }: { account: Account; project: Project; release: ProjectRelease; item: ReleaseItem; part: ReleasePart | null; onClose: () => void; onChange: (project: Project) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { busy, error, setError, run } = useRun(onChange);
  const [title, setTitle] = useState(part?.title ?? "");
  const save = async () => {
    const next = title.trim();
    if (!next) return setError("Give the part a name");
    if (await run(() => part ? api.updateReleasePart(account, project.id, release.id, item.id, part.id, { title: next }) : api.addReleasePart(account, project.id, release.id, item.id, next), "Couldn't save the part")) onClose();
  };
  const remove = async () => { if (part && await run(() => api.deleteReleasePart(account, project.id, release.id, item.id, part.id), "Couldn't remove the part")) onClose(); };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.fill}>
      <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={onClose}>
        <Pressable accessibilityViewIsModal style={styles.sheet} onPress={() => {}}>
          <Text accessibilityRole="header" style={styles.sheetTitle}>{part ? "Part" : "Add part"}</Text>
          <Text style={styles.sheetMeta}>{item.title} · {release.name}</Text>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Text style={styles.label}>Name</Text>
          <TextInput accessibilityLabel="Part name" autoFocus value={title} onChangeText={setTitle} onSubmitEditing={() => void save()} returnKeyType="done" maxLength={80} placeholder="e.g. Spanish strings" placeholderTextColor={colors.muted} style={styles.input} />
          <View style={styles.actions}>
            {part ? <Button label="Remove" kind="danger" busy={busy} onPress={() => void remove()} style={{ flex: 1 }} /> : <Button label="Cancel" kind="secondary" onPress={onClose} style={{ flex: 1 }} />}
            <Button label={part ? "Save" : "Add part"} busy={busy} disabled={!title.trim()} onPress={() => void save()} style={{ flex: 1 }} />
          </View>
        </Pressable>
      </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  content: { paddingBottom: space.xxl },
  error: { ...typography.caption, color: colors.red, marginTop: space.sm },
  hint: { ...typography.caption, color: colors.muted, marginHorizontal: space.side, marginTop: space.md },
  // My to-dos: the cells assigned to you, soonest release first. A neutral card, so every status tint shows on it.
  todos: { marginHorizontal: space.side, marginTop: space.md, paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: radius.lg },
  todosTitle: { ...typography.bodyStrong, color: colors.brandText, paddingVertical: space.xxs },
  todosEmpty: { ...typography.caption, color: colors.muted, paddingVertical: space.xxs },
  todoRow: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm },
  todoText: { ...typography.body, color: colors.ink, flex: 1, minWidth: 0 },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.lg, paddingLeft: space.side, paddingRight: space.xs },
  section: { ...typography.label, color: colors.muted },
  sectionAction: { minHeight: 44, paddingHorizontal: space.sm, justifyContent: "center" },
  link: { ...typography.bodyStrong, color: colors.blue, ...linkUnderline },
  // One release: a header, then its items.
  release: { marginTop: space.sm, marginHorizontal: space.side, borderWidth: 1, borderColor: colors.line, borderRadius: radius.lg, overflow: "hidden" },
  releaseHead: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: colors.surface },
  releaseCopy: { flex: 1, minWidth: 0 },
  releaseName: { ...typography.heading, color: colors.ink },
  releaseMeta: { ...typography.caption, color: colors.muted, marginTop: 2 },
  noItems: { ...typography.caption, color: colors.muted, paddingHorizontal: space.md, paddingVertical: space.sm },
  // Phones: a card per item with a chip per stage.
  card: { paddingHorizontal: space.md, paddingBottom: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  cardHead: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.xs },
  itemTitle: { ...typography.bodyStrong, color: colors.ink, flex: 1, minWidth: 0 },
  chips: { flexDirection: "row", flexWrap: "wrap", columnGap: space.xs },
  // The pill is 32 points; the control around it is 44 (hit slop does nothing in a browser).
  chipTarget: { minHeight: 44, maxWidth: "100%", justifyContent: "center" },
  chip: { minHeight: 32, flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: space.sm, paddingRight: 5, borderRadius: radius.pill, borderWidth: 1 },
  chipText: { ...typography.captionStrong, flexShrink: 1 },
  more: { paddingRight: space.xs },
  pill: { minHeight: 26, justifyContent: "center", paddingHorizontal: space.sm, borderRadius: radius.pill, borderWidth: 1 },
  nobody: { width: 22, height: 22, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  nobodyBig: { width: 28, height: 28, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  cellNote: { ...typography.meta, color: colors.muted, marginTop: space.xxs },
  tableNote: { marginTop: 0, marginBottom: space.xs },
  // Wide screens: items down, stages across.
  tableScroll: { minWidth: "100%" },
  table: { flexGrow: 1 },
  tableRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  th: { ...typography.label, color: colors.muted, paddingVertical: space.xs },
  itemCol: { flex: 1, minWidth: 160, paddingVertical: space.sm, paddingHorizontal: space.xxs, justifyContent: "center" },
  stageCol: { width: 140, paddingHorizontal: space.xxs, justifyContent: "center" },
  // A feature: its box and name, then its parts indented under the name.
  featureRow: { minHeight: 44, flexDirection: "row", alignItems: "center" },
  featureTitle: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.xs },
  boxTarget: { width: 44, minHeight: 44, marginLeft: -space.xs, alignItems: "center", justifyContent: "center" },
  doneText: { color: colors.muted },
  parts: { marginLeft: space.xl, paddingBottom: space.xxs },
  partRow: { minHeight: 44, flexDirection: "row", alignItems: "center" },
  partTitle: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: "center" },
  partText: { ...typography.body, color: colors.ink },
  addPart: { minHeight: 44, flexDirection: "row", alignItems: "center", alignSelf: "flex-start" },
  smallLink: { ...typography.caption, color: colors.blue, ...linkUnderline },
  bar: { height: space.xxs, marginTop: space.xs, borderRadius: radius.pill, backgroundColor: colors.line, overflow: "hidden" },
  barFill: { height: space.xxs, borderRadius: radius.pill, backgroundColor: colors.green },
  tableTop: { alignItems: "flex-start" },
  stageCell: { minHeight: 44, paddingTop: space.sm },
  // The Shipped box: the release's last row.
  shipRow: { minHeight: 56, flexDirection: "row", alignItems: "center", paddingHorizontal: space.md, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.surface },
  shipDone: { backgroundColor: colors.greenSoft },
  lockBox: { width: 24, height: 24, borderRadius: radius.sm, borderWidth: 2, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  lockedText: { color: colors.muted },
  addItem: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  empty: { marginTop: space.xl, alignItems: "center", paddingHorizontal: space.lg },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center", marginTop: space.md },
  emptyAction: { width: "100%", maxWidth: 360, marginTop: space.lg },
  // Editors: a centered card on every screen size.
  fill: { flex: 1 },
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: space.side, backgroundColor: colors.scrim },
  sheet: { width: "100%", maxWidth: 440, maxHeight: "90%", backgroundColor: colors.background, borderRadius: radius.lg, padding: space.side },
  sheetTitle: { ...typography.heading, color: colors.ink },
  sheetMeta: { ...typography.caption, color: colors.muted, marginTop: 2 },
  label: { ...typography.label, color: colors.muted, marginTop: space.md, marginBottom: space.xs },
  help: { ...typography.caption, color: colors.muted, marginTop: space.xs },
  input: controls.input,
  readonly: { color: colors.muted, backgroundColor: colors.surface },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  // Four of these fit one row on a phone.
  choice: { minHeight: 44, paddingHorizontal: space.sm, justifyContent: "center", borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderStrong },
  choiceText: { ...typography.bodyStrong, color: colors.ink },
  personRow: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm },
  personName: { ...typography.body, color: colors.ink, flex: 1, minWidth: 0 },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.lg },
  doneButton: { marginTop: space.lg },
}));
