import { useState } from "react";
import { ActivityIndicator, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { AppIcon } from "./AppIcon";
import { Button } from "./Button";
import { ProjectReadme } from "./ProjectReadme";
import { ConfirmDialog } from "./ConfirmDialog";
import { Avatar } from "./Messaging";
import { forgetProject } from "../lib/projects-store";
import { api, ServerError, type Account, type Person, type Project, type ProjectLevel, type ProjectPerson } from "../lib/server";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

const MAX_FILE = 20 * 1024 * 1024;
const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
// Plain words for each access level and each way of working.
const LEVELS: ProjectLevel[] = ["read", "write", "merge"];
export const LEVEL_LABEL: Record<ProjectLevel, string> = { read: "Can read", write: "Can write", merge: "Can merge" };
export const WORKFLOWS: { key: Project["workflow"]; label: string; detail: string }[] = [
  { key: "main", label: "Straight to main", detail: "Commit and push to main. No branches or pull requests." },
  { key: "pr", label: "Pull requests", detail: "Work on a branch and open a pull request. Merge after the checks pass and someone has reviewed it." },
];
const personName = (p: ProjectPerson) => p.id ? p.name : `GitHub: ${p.github ?? p.name}`;
const lines = (list: string[]) => list.join("\n");

// The About tab: what the project is, how the team works (workflow, repo, rules, stages), the shared
// notes and files every chat in it sees, and who is in it. Mount it fresh per project (key by id).
export function ProjectAbout({ account, project, onChange }: { account: Account; project: Project; onChange: (project: Project) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [adding, setAdding] = useState(false);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [login, setLogin] = useState("");
  const [editing, setEditing] = useState<ProjectPerson | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // What's being typed; saved on blur, so a re-read of the project never overwrites it.
  const [fields, setFields] = useState({ name: project.name, description: project.description, repo: project.repo, path: project.path, rules: lines(project.rules), stages: lines(project.stages), notes: project.notes });
  const field = (key: keyof typeof fields) => (value: string) => setFields(f => ({ ...f, [key]: value }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<void>, fallback: string) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await work(); } catch (e) { setError(e instanceof ServerError || e instanceof Error ? e.message : fallback); }
    finally { setBusy(false); }
  };
  const save = (change: Parameters<typeof api.updateProject>[2], fallback = "Couldn't save that") => void run(async () => onChange(await api.updateProject(account, project.id, change)), fallback);
  const saveText = (key: "name" | "description" | "repo" | "path" | "notes") => () => {
    const next = key === "notes" ? fields.notes : fields[key].trim();
    if (next === project[key]) return;
    if (key === "name" && !next) { setFields(f => ({ ...f, name: project.name })); return; }
    save({ [key]: next });
  };
  const saveLines = (key: "rules" | "stages") => () => {
    const next = fields[key].split("\n").map(r => r.trim()).filter(Boolean);
    if (lines(next) !== lines(project[key])) save({ [key]: next });
  };
  const addFile = () => void run(async () => {
    const picked = await DocumentPicker.getDocumentAsync({ type: "*/*", multiple: false, copyToCacheDirectory: true });
    if (picked.canceled) return;
    const asset = picked.assets[0]!;
    const bytes = asset.size ?? asset.file?.size ?? 0;
    if (bytes > MAX_FILE) throw new Error("Choose files under 20 MB each");
    let data: string;
    if (Platform.OS === "web") {
      const blob = asset.file ?? await (await fetch(asset.uri)).blob();
      data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]!);
        reader.onerror = () => reject(new Error("Couldn't read this file"));
        reader.readAsDataURL(blob);
      });
    } else data = await new File(asset.uri).base64();
    onChange(await api.addProjectFile(account, project.id, asset.name, data));
  }, "Couldn't add the file");
  const openAdd = () => {
    setError(null); setAdding(true); setPeople(null); setLogin("");
    api.people(account).then(d => setPeople(d.people.filter(p => p.id !== d.me)), () => setPeople([]));
  };
  // Teammates start out able to write (notes and files); a GitHub login starts read only. Owners adjust per person.
  const addPerson = (who: { userId?: string; github?: string }, level: ProjectLevel) => void run(async () => {
    onChange(await api.setProjectPerson(account, project.id, who, level));
    setLogin("");
    if (who.userId) setAdding(false);
  }, "Couldn't add that person");
  const setAccess = (person: ProjectPerson, level: ProjectLevel, owner?: boolean) => void run(async () => {
    const next = await api.setProjectPerson(account, project.id, { key: person.key }, level, owner);
    onChange(next);
    setEditing(next.people.find(p => p.key === person.key) ?? null);
  }, "Couldn't change that");
  const removePerson = (person: ProjectPerson) => void run(async () => {
    const r = await api.removeProjectPerson(account, project.id, person.key);
    if (r.project) onChange(r.project);
    setEditing(null);
  }, "Couldn't remove that person");
  const leave = () => void run(async () => {
    await api.removeProjectPerson(account, project.id, "me");
    setConfirmLeave(false);
    forgetProject(project.id);
    router.back();
  }, "Couldn't leave the project");
  const remove = () => void run(async () => {
    await api.deleteProject(account, project.id);
    setConfirmDelete(false);
    forgetProject(project.id);
    router.back();
  }, "Couldn't delete the project");

  const { canEdit, canWrite } = project;
  const workflow = WORKFLOWS.find(w => w.key === project.workflow) ?? WORKFLOWS[0]!;
  const hasRepo = !!(project.repo || project.path);
  const inProject = !!project.access || project.people.some(p => p.id === account.user.id);
  const teammates = project.people.filter(p => p.id && p.id !== account.user.id).length > 0;
  const repoUrl = project.repo ? `https://github.com/${project.repo}` : "";
  return (
    <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={{ paddingBottom: space.xxl }}>
      {error && !adding && !editing && !confirmLeave && !confirmDelete ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <Text style={styles.label}>Name</Text>
      <TextInput accessibilityLabel="Project name" editable={canEdit} value={fields.name} onChangeText={field("name")} onBlur={saveText("name")} maxLength={60} placeholderTextColor={colors.muted} style={[styles.input, !canEdit && styles.readonly]} />
      {canEdit || project.description ? <>
        <Text style={styles.label}>Description</Text>
        <TextInput accessibilityLabel="Project description" editable={canEdit} value={fields.description} onChangeText={field("description")} onBlur={saveText("description")} maxLength={200}
          placeholder="What this project is, in a line" placeholderTextColor={colors.muted} style={[styles.input, !canEdit && styles.readonly]} />
      </> : null}

      <ProjectReadme account={account} project={project} />

      {canEdit || hasRepo || project.rules.length || project.stages.length ? <>
        <View style={styles.sectionRow}><Text accessibilityRole="header" style={styles.section}>How we work</Text></View>
        {canEdit ? <View style={styles.workflowRow}>
          {WORKFLOWS.map(w => <Pressable key={w.key} accessibilityRole="button" accessibilityState={{ selected: w.key === project.workflow }} disabled={busy} onPress={() => { if (w.key !== project.workflow) save({ workflow: w.key }, "Couldn't change the workflow"); }}
            style={[styles.workflowChoice, w.key === project.workflow && styles.workflowChosen]}>
            <Text style={[styles.workflowChoiceText, w.key === project.workflow && styles.workflowChosenText]}>{w.label}</Text>
          </Pressable>)}
        </View> : hasRepo ? <View style={styles.badgeRow}><View style={styles.badge}><Text style={styles.badgeText}>{workflow.label}</Text></View></View> : null}
        {canEdit || hasRepo ? <Text style={styles.help}>{workflow.detail}</Text> : null}
        {canEdit ? <>
          <Text style={styles.label}>GitHub repo</Text>
          <TextInput accessibilityLabel="GitHub repo" value={fields.repo} onChangeText={field("repo")} onBlur={saveText("repo")} autoCapitalize="none" autoCorrect={false} maxLength={100}
            placeholder="owner/name" placeholderTextColor={colors.muted} style={styles.input} />
          <Text style={styles.label}>Where the agent works on it</Text>
          <TextInput accessibilityLabel="Local path" value={fields.path} onChangeText={field("path")} onBlur={saveText("path")} autoCapitalize="none" autoCorrect={false} maxLength={300}
            placeholder="~/project" placeholderTextColor={colors.muted} style={styles.input} />
        </> : null}
        {repoUrl ? <Pressable accessibilityRole="link" accessibilityLabel={`Open ${project.repo} on GitHub`} onPress={() => void Linking.openURL(repoUrl)} style={({ pressed }) => [styles.linkRow, pressed && { backgroundColor: colors.surface }]}>
          <AppIcon name="code" size={18} color={colors.muted} />
          <View style={styles.fileCopy}>
            <Text style={styles.link} numberOfLines={1}>{project.repo}</Text>
            {project.path && !canEdit ? <Text style={styles.fileMeta} numberOfLines={1}>{project.path}</Text> : null}
          </View>
          <AppIcon name="chevronRight" size={16} color={colors.muted} />
        </Pressable> : project.path && !canEdit ? <Text style={styles.help}>Lives at {project.path}</Text> : null}
        {project.pages ? <Pressable accessibilityRole="link" accessibilityLabel="Open the published site" onPress={() => void Linking.openURL(project.pages)} style={({ pressed }) => [styles.linkRow, pressed && { backgroundColor: colors.surface }]}>
          <AppIcon name="hash" size={18} color={colors.muted} />
          <Text style={[styles.link, styles.fileCopy]} numberOfLines={1}>{project.pages.replace(/^https:\/\//, "")}</Text>
          <AppIcon name="chevronRight" size={16} color={colors.muted} />
        </Pressable> : null}
        <Text style={styles.label}>Rules</Text>
        {canEdit ? <>
          <TextInput accessibilityLabel="Project rules, one per line" value={fields.rules} onChangeText={field("rules")} onBlur={saveLines("rules")} multiline textAlignVertical="top"
            placeholder={"One rule per line, e.g.\nNever enable a feature flag just because the tests pass"} placeholderTextColor={colors.muted}
            style={[styles.input, styles.rules, { minHeight: Math.min(480, 48 + 22 * Math.max(3, 1 + fields.rules.split("\n").reduce((n, r) => n + Math.max(1, Math.ceil(r.length / 40)), 0))) }]} />
          <Text style={styles.help}>Everyone in the project sees these, and the agent follows them in every chat here.</Text>
        </> : project.rules.length ? <View style={styles.ruleList}>{project.rules.map((rule, i) => <View key={i} style={styles.rule}><Text style={styles.bullet}>•</Text><Text style={styles.ruleText}>{rule}</Text></View>)}</View>
          : <Text style={styles.help}>No rules yet.</Text>}
        {/* Stages: the track every release item follows. Each stage of each item gets an owner and a status. */}
        {canEdit || project.stages.length ? <Text style={styles.label}>Stages</Text> : null}
        {canEdit ? <>
          <TextInput accessibilityLabel="Release stages, one per line, in order" value={fields.stages} onChangeText={field("stages")} onBlur={saveLines("stages")} multiline textAlignVertical="top"
            placeholder={"One stage per line, in order, e.g.\nBuild\nDesign\nQA"} placeholderTextColor={colors.muted}
            style={[styles.input, styles.rules, { minHeight: 48 + 22 * Math.max(3, 1 + fields.stages.split("\n").length) }]} />
          <Text style={styles.help}>Every item in a release goes through these, in order. Each stage of each item gets an owner and a status: that's the to-do list in Releases.</Text>
        </> : project.stages.length ? <Text style={styles.stages}>{project.stages.join("  →  ")}</Text> : null}
      </> : null}

      <Text style={styles.label}>Notes for every chat in this project</Text>
      <TextInput accessibilityLabel="Project notes" editable={canWrite} value={fields.notes} onChangeText={field("notes")} onBlur={saveText("notes")} multiline maxLength={8000} textAlignVertical="top"
        placeholder="Who it's for, what it does, how it should sound" placeholderTextColor={colors.muted} style={[styles.input, styles.notes, !canWrite && styles.readonly]} />
      <Text style={styles.help}>{canWrite ? "The agent reads these notes in every reply, for everyone in this project." : "You can read this project. Ask an owner for write access to change the notes and files."}</Text>

      <View style={styles.sectionRow}>
        <Text accessibilityRole="header" style={styles.section}>People</Text>
        {canEdit ? <Pressable accessibilityRole="button" accessibilityLabel="Add people to this project" disabled={busy} onPress={openAdd} hitSlop={8} style={styles.sectionAction}>
          <Text style={styles.link}>Add people</Text>
        </Pressable> : null}
      </View>
      {project.people.map(p => <Pressable key={p.key} accessibilityRole={canEdit ? "button" : undefined} accessibilityLabel={canEdit ? `${personName(p)}, ${LEVEL_LABEL[p.level].toLowerCase()}${p.owner ? ", owner" : ""}. Change` : undefined} disabled={!canEdit || busy} onPress={() => setEditing(p)}
        style={({ pressed }) => [styles.personRow, pressed && { backgroundColor: colors.surface }]}>
        <Avatar name={p.name} size={32} userId={p.id} />
        <View style={styles.fileCopy}>
          <Text style={styles.personName} numberOfLines={1}>{personName(p)}</Text>
          {p.owner || (p.id && p.github) ? <Text style={styles.fileMeta} numberOfLines={1}>{[p.owner ? "Owner" : null, p.id && p.github ? `GitHub: ${p.github}` : null].filter(Boolean).join(" · ")}</Text> : null}
        </View>
        <View style={[styles.chip, styles[`${p.level}Chip`]]}><Text style={[styles.chipText, styles[`${p.level}ChipText`]]}>{LEVEL_LABEL[p.level]}</Text></View>
        {canEdit ? <AppIcon name="chevronRight" size={16} color={colors.muted} /> : null}
      </Pressable>)}
      <Text style={styles.empty}>{project.people.length <= 1 ? "Only you. Add people so they use the same notes and files. They only see their own chats unless they share one."
        : "Everyone here shares the notes, files and rules. You each see only your own chats, unless someone shares one with the project."}</Text>

      <View style={styles.sectionRow}>
        <Text accessibilityRole="header" style={styles.section}>Files</Text>
        {canWrite ? <Pressable accessibilityRole="button" accessibilityLabel="Add a file to this project" disabled={busy} onPress={addFile} hitSlop={8} style={styles.sectionAction}>
          <Text style={styles.link}>Add a file</Text>
        </Pressable> : null}
      </View>
      {project.files.length === 0 ? <Text style={styles.empty}>{canWrite ? "Add briefs, specs or research. Every chat in this project can use them." : "No files yet."}</Text> : null}
      {project.files.map(file => <View key={file.id} style={styles.fileRow}>
        <AppIcon name="paperclip" size={18} color={colors.muted} />
        <View style={styles.fileCopy}>
          <Text style={styles.fileName} numberOfLines={1}>{file.name}</Text>
          <Text style={styles.fileMeta}>{size(file.size)}</Text>
        </View>
        {canWrite ? <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${file.name}`} disabled={busy} hitSlop={8} style={styles.remove}
          onPress={() => void run(async () => onChange(await api.removeProjectFile(account, project.id, file.id)), "Couldn't remove the file")}>
          <AppIcon name="close" size={16} color={colors.muted} />
        </Pressable> : null}
      </View>)}

      <View style={styles.footer}>
        {canEdit ? <Button label="Delete project" kind="danger" onPress={() => setConfirmDelete(true)} />
          : inProject ? <Button label="Leave project" kind="danger" onPress={() => setConfirmLeave(true)} /> : null}
      </View>

      <Modal visible={adding} transparent animationType="fade" onRequestClose={() => setAdding(false)}>
        <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={() => setAdding(false)}>
          <Pressable accessibilityViewIsModal style={styles.card} onPress={() => {}}>
            <Text accessibilityRole="header" style={styles.cardTitle}>Add people</Text>
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            {people === null ? <ActivityIndicator color={colors.blue} style={{ margin: space.lg }} /> : (() => {
              const here = new Set(project.people.map(p => p.id).filter(Boolean));
              const choices = people.filter(p => !here.has(p.id) && !p.agent);
              return choices.length === 0 ? <Text style={styles.empty}>Everyone on this server is already here.</Text>
                : <ScrollView style={{ maxHeight: 280 }}>{choices.map(p => <Pressable key={p.id} accessibilityRole="button" accessibilityLabel={`Add ${p.name}`} disabled={busy} onPress={() => addPerson({ userId: p.id }, "write")}
                  style={({ pressed }) => [styles.personRow, pressed && { backgroundColor: colors.surface }]}>
                  <Avatar name={p.name} size={32} userId={p.id} />
                  <Text style={styles.personName} numberOfLines={1}>{p.name}</Text>
                </Pressable>)}</ScrollView>;
            })()}
            <Text style={styles.help}>People you add can write. Tap a person afterwards to change what they can do.</Text>
            <Text style={styles.label}>Or a GitHub username</Text>
            <View style={styles.loginRow}>
              <TextInput accessibilityLabel="GitHub username" value={login} onChangeText={setLogin} autoCapitalize="none" autoCorrect={false} maxLength={40} returnKeyType="done"
                onSubmitEditing={() => { if (login.trim()) addPerson({ github: login.trim() }, "read"); }} placeholder="octocat" placeholderTextColor={colors.muted} style={[styles.input, styles.loginInput]} />
              <Button label="Add" compact disabled={!login.trim()} busy={busy} onPress={() => addPerson({ github: login.trim() }, "read")} />
            </View>
            <Button label="Done" kind="secondary" onPress={() => setAdding(false)} style={{ marginTop: space.md, marginHorizontal: space.side }} />
          </Pressable>
        </Pressable>
      </Modal>
      <Modal visible={!!editing} transparent animationType="fade" onRequestClose={() => setEditing(null)}>
        <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={() => setEditing(null)}>
          <Pressable accessibilityViewIsModal style={styles.card} onPress={() => {}}>
            {editing ? <>
              <Text accessibilityRole="header" style={styles.cardTitle}>{personName(editing)}</Text>
              {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
              {LEVELS.map(level => <Pressable key={level} accessibilityRole="button" accessibilityState={{ selected: editing.level === level }} disabled={busy} onPress={() => { if (level !== editing.level) setAccess(editing, level); }}
                style={({ pressed }) => [styles.personRow, pressed && { backgroundColor: colors.surface }]}>
                <View style={styles.fileCopy}>
                  <Text style={styles.personName}>{LEVEL_LABEL[level]}</Text>
                  <Text style={styles.fileMeta}>{level === "read" ? "Sees the project and chats in it" : level === "write" ? "Also changes notes and files, and pushes" : "Also merges"}</Text>
                </View>
                {editing.level === level ? <AppIcon name="check" size={18} color={colors.blue} /> : null}
              </Pressable>)}
              <View style={styles.switchRow}>
                <View style={styles.fileCopy}>
                  <Text style={styles.personName}>Owner</Text>
                  <Text style={styles.fileMeta}>Owners change the rules and who is in the project.</Text>
                </View>
                <Switch accessibilityLabel={`${personName(editing)} is an owner`} value={editing.owner} disabled={busy} onValueChange={next => setAccess(editing, editing.level, next)}
                  trackColor={{ true: colors.blue, false: colors.borderStrong }} thumbColor="#FFFFFF" {...(Platform.OS === "web" ? { activeThumbColor: "#FFFFFF" } : {})} />
              </View>
              <View style={styles.cardActions}>
                <Button label="Remove" kind="danger" busy={busy} onPress={() => removePerson(editing)} style={{ flex: 1 }} />
                <Button label="Done" kind="secondary" onPress={() => setEditing(null)} style={{ flex: 1 }} />
              </View>
            </> : null}
          </Pressable>
        </Pressable>
      </Modal>
      <ConfirmDialog visible={confirmLeave} title="Leave this project?" destructive
        description="You stop seeing its notes and files. Your chats stay, they just leave the project."
        confirmLabel="Leave project" busy={busy} error={error}
        onCancel={() => setConfirmLeave(false)} onConfirm={leave} />
      <ConfirmDialog visible={confirmDelete} title="Delete this project?"
        description={teammates ? "The notes, files, releases and rules are deleted for everyone in it. Everyone's chats stay, they just leave the project." : "The notes, files, releases and rules are deleted. Your chats stay, they just leave the project."}
        confirmLabel="Delete project" busy={busy} error={error}
        onCancel={() => setConfirmDelete(false)} onConfirm={remove} />
    </ScrollView>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  error: { ...typography.caption, color: colors.red, marginHorizontal: space.side, marginVertical: space.sm },
  label: { ...typography.label, color: colors.muted, marginHorizontal: space.side, marginTop: space.md, marginBottom: space.xs },
  input: { ...typography.body, color: colors.ink, marginHorizontal: space.side, minHeight: 48, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background },
  notes: { minHeight: 120, paddingTop: space.sm },
  rules: { minHeight: 96, paddingTop: space.sm },
  stages: { ...typography.body, color: colors.ink, marginHorizontal: space.side },
  help: { ...typography.caption, color: colors.muted, marginHorizontal: space.side, marginTop: space.xs },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.lg, paddingLeft: space.side, paddingRight: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  section: { ...typography.label, color: colors.muted },
  sectionAction: { minHeight: 44, paddingHorizontal: space.sm, justifyContent: "center" },
  link: { ...typography.bodyStrong, color: colors.blue },
  linkRow: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.xs, paddingHorizontal: space.side },
  empty: { ...typography.caption, color: colors.muted, marginHorizontal: space.side, marginVertical: space.md },
  // How we work: the owner picks one; everyone else sees a badge.
  workflowRow: { flexDirection: "row", gap: space.xs, marginHorizontal: space.side, marginTop: space.md },
  workflowChoice: { minHeight: 40, paddingHorizontal: space.md, justifyContent: "center", borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderStrong },
  workflowChosen: { backgroundColor: colors.primary, borderColor: colors.primary },
  workflowChoiceText: { ...typography.bodyStrong, color: colors.ink },
  workflowChosenText: { color: colors.onPrimary },
  badgeRow: { flexDirection: "row", marginHorizontal: space.side, marginTop: space.md },
  badge: { minHeight: 32, paddingHorizontal: space.sm, justifyContent: "center", borderRadius: radius.pill, backgroundColor: colors.primary },
  badgeText: { ...typography.captionStrong, color: colors.onPrimary },
  ruleList: { marginHorizontal: space.side, marginTop: space.xxs, gap: space.xs },
  rule: { flexDirection: "row", gap: space.xs },
  bullet: { ...typography.body, color: colors.muted },
  ruleText: { ...typography.body, color: colors.ink, flex: 1 },
  fileRow: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.side, paddingRight: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  fileCopy: { flex: 1, minWidth: 0 },
  fileName: { ...typography.body, color: colors.ink },
  fileMeta: { ...typography.caption, color: colors.muted },
  remove: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  readonly: { color: colors.muted, backgroundColor: colors.surface },
  personRow: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.side, paddingRight: space.sm },
  personName: { ...typography.body, flex: 1, minWidth: 0, color: colors.ink },
  // Read / Write / Merge chips: the more someone can do, the stronger the chip.
  chip: { minHeight: 28, paddingHorizontal: space.sm, justifyContent: "center", borderRadius: radius.pill },
  chipText: { ...typography.captionStrong },
  readChip: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, readChipText: { color: colors.muted },
  writeChip: { backgroundColor: colors.blueSoft }, writeChipText: { color: colors.blueDark },
  mergeChip: { backgroundColor: colors.primary }, mergeChipText: { color: colors.onPrimary },
  switchRow: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.side, marginTop: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  loginRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingRight: space.side },
  loginInput: { flex: 1, marginRight: 0 },
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: space.side, backgroundColor: "rgba(17,46,81,0.42)" },
  card: { width: "100%", maxWidth: 420, backgroundColor: colors.background, borderRadius: radius.lg, paddingVertical: space.side },
  cardTitle: { ...typography.heading, color: colors.ink, paddingHorizontal: space.side, marginBottom: space.xs },
  cardActions: { flexDirection: "row", gap: space.sm, marginTop: space.md, marginHorizontal: space.side },
  footer: { marginTop: space.xl, alignItems: "center" },
}));
