import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { AppIcon } from "../components/AppIcon";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { api, ServerError, type Chat, type Folder } from "../lib/server";
import { useSession } from "../lib/session";
import { shortTime as when } from "../lib/time-label";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

const MAX_FILE = 20 * 1024 * 1024;
const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

// One folder: shared notes and files that every chat in it sees, plus the chats.
export default function FolderScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account, setAccount } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [folder, setFolder] = useState<Folder | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [notes, setNotes] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    if (!account || !id) return;
    try {
      const [f, all] = await Promise.all([api.folder(account, String(id)), api.orgChats(account, setAccount)]);
      setFolder(f);
      setChats(all.mine.filter(c => c.folderId === f.id));
      // Don't overwrite what's being typed after the first load.
      if (!loaded.current) { setNotes(f.notes); setName(f.name); loaded.current = true; }
      setError(null);
    } catch (e) { setError(e instanceof ServerError ? e.message : "Couldn't load this folder"); }
  }, [account, id, setAccount]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  useEffect(() => { loaded.current = false; }, [id]);
  if (!account) return null;

  const run = async (work: () => Promise<void>, fallback: string) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await work(); } catch (e) { setError(e instanceof ServerError || e instanceof Error ? e.message : fallback); }
    finally { setBusy(false); }
  };
  const saveNotes = () => { if (folder && notes !== folder.notes) void run(async () => setFolder(await api.updateFolder(account, folder.id, { notes })), "Couldn't save the notes"); };
  const saveName = () => {
    const next = name.trim();
    if (!folder || next === folder.name) return;
    if (!next) { setName(folder.name); return; }
    void run(async () => { const f = await api.updateFolder(account, folder.id, { name: next }); setFolder(f); setName(f.name); }, "Couldn't rename the folder");
  };
  const addFile = () => void run(async () => {
    if (!folder) return;
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
    setFolder(await api.addFolderFile(account, folder.id, asset.name, data));
  }, "Couldn't add the file");
  const startChat = () => void run(async () => {
    if (!folder) return;
    const chat = await api.newChat(account, { folderId: folder.id });
    router.push({ pathname: "/chat/[id]", params: { id: chat.id, title: chat.title, compose: "1" } });
  }, "Couldn't start a chat");
  const remove = () => void run(async () => {
    if (!folder) return;
    await api.deleteFolder(account, folder.id);
    setConfirmDelete(false);
    router.back();
  }, "Couldn't delete the folder");

  if (!folder) return <View style={styles.root}><Stack.Screen options={{ title: "Folder" }} />
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : <ActivityIndicator style={{ marginTop: space.xxl }} color={colors.blue} />}
  </View>;

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: folder.name }} />
      <FlatList
        data={chats}
        keyExtractor={c => c.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: space.xxl }}
        ListHeaderComponent={<View>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Text style={styles.label}>Name</Text>
          <TextInput accessibilityLabel="Folder name" value={name} onChangeText={setName} onBlur={saveName} maxLength={60} placeholderTextColor={colors.muted} style={styles.input} />
          <Text style={styles.label}>Notes for every chat in this folder</Text>
          <TextInput accessibilityLabel="Folder notes" value={notes} onChangeText={setNotes} onBlur={saveNotes} multiline maxLength={8000} textAlignVertical="top"
            placeholder="Who it's for, what it does, how it should sound" placeholderTextColor={colors.muted} style={[styles.input, styles.notes]} />
          <Text style={styles.help}>The agent reads these notes at the start of every reply in this folder.</Text>

          <View style={styles.sectionRow}>
            <Text accessibilityRole="header" style={styles.section}>Files</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Add a file to this folder" disabled={busy} onPress={addFile} hitSlop={8} style={styles.sectionAction}>
              <Text style={styles.link}>Add a file</Text>
            </Pressable>
          </View>
          {folder.files.length === 0 ? <Text style={styles.empty}>Add briefs, specs or research. Every chat in this folder can use them.</Text> : null}
          {folder.files.map(file => <View key={file.id} style={styles.fileRow}>
            <AppIcon name="paperclip" size={18} color={colors.muted} />
            <View style={styles.fileCopy}>
              <Text style={styles.fileName} numberOfLines={1}>{file.name}</Text>
              <Text style={styles.fileMeta}>{size(file.size)}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${file.name}`} disabled={busy} hitSlop={8} style={styles.remove}
              onPress={() => void run(async () => setFolder(await api.removeFolderFile(account, folder.id, file.id)), "Couldn't remove the file")}>
              <AppIcon name="close" size={16} color={colors.muted} />
            </Pressable>
          </View>)}

          <View style={styles.sectionRow}>
            <Text accessibilityRole="header" style={styles.section}>Chats</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="New chat in this folder" disabled={busy} onPress={startChat} hitSlop={8} style={styles.sectionAction}>
              <Text style={styles.link}>New chat</Text>
            </Pressable>
          </View>
          {chats.length === 0 ? <Text style={styles.empty}>No chats yet. Start one here, or move an existing chat in from its options.</Text> : null}
        </View>}
        renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={item.title.replace(/`/g, "")}
          onPress={() => router.push({ pathname: "/chat/[id]", params: { id: item.id, title: item.title } })}
          style={({ pressed }) => [styles.chatRow, pressed && { backgroundColor: colors.surface }]}>
          <View style={styles.chatIcon}><AppIcon name={item.mode === "vibe" ? "code" : "sparkles"} size={18} color={colors.blueDark} /></View>
          <Text style={styles.chatTitle} numberOfLines={1}>{item.title.replace(/`/g, "")}</Text>
          <Text style={styles.when}>{when(item.updatedAt)}</Text>
        </Pressable>}
        ListFooterComponent={<View style={styles.footer}>
          <Button label="Delete folder" kind="danger" onPress={() => setConfirmDelete(true)} />
        </View>}
      />
      <ConfirmDialog visible={confirmDelete} title="Delete this folder?"
        description="The notes and files are deleted. Your chats stay, they just leave the folder."
        confirmLabel="Delete folder" busy={busy} error={error}
        onCancel={() => setConfirmDelete(false)} onConfirm={remove} />
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  error: { ...typography.caption, color: colors.red, marginHorizontal: space.side, marginVertical: space.sm },
  label: { ...typography.label, color: colors.muted, marginHorizontal: space.side, marginTop: space.md, marginBottom: space.xs },
  input: { ...typography.body, color: colors.ink, marginHorizontal: space.side, minHeight: 48, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background },
  notes: { minHeight: 120, paddingTop: space.sm },
  help: { ...typography.caption, color: colors.muted, marginHorizontal: space.side, marginTop: space.xs },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.lg, paddingLeft: space.side, paddingRight: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  section: { ...typography.label, color: colors.muted },
  sectionAction: { minHeight: 44, paddingHorizontal: space.sm, justifyContent: "center" },
  link: { ...typography.bodyStrong, color: colors.blue },
  empty: { ...typography.caption, color: colors.muted, marginHorizontal: space.side, marginVertical: space.md },
  fileRow: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.side, paddingRight: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  fileCopy: { flex: 1, minWidth: 0 },
  fileName: { ...typography.body, color: colors.ink },
  fileMeta: { ...typography.caption, color: colors.muted },
  remove: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  chatRow: { minHeight: 60, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.side, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  chatIcon: { width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center" },
  chatTitle: { ...typography.body, flex: 1, color: colors.ink },
  when: { ...typography.caption, color: colors.muted },
  footer: { marginTop: space.xl, alignItems: "center" },
}));
