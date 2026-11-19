import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { AppIcon } from "../components/AppIcon";
import { documentReader } from "../components/Attachments";
import { Button } from "../components/Button";
import { dropFile, dropStatus, type DropItem } from "../lib/file-drop";
import { formatFileSize, MAX_DOCUMENT_BYTES } from "../lib/media";
import { uploadPost, type LocalDocument } from "../lib/server";
import { useSession } from "../lib/session";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

type Queued = DropItem & { document: LocalDocument };

// File drop (server/file-drop.mjs): the owner drops files here, or chooses them, and each lands in one folder on the
// server's own computer. A file already there is never replaced; the new one is saved beside it under a numbered name.
export default function FileDropScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account, setAccount } = useSession();
  const [items, setItems] = useState<Queued[]>([]);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const sending = useRef(false);
  const queue = useRef<Queued[]>([]);
  const offered = account?.fileDrop === true;

  const patch = useCallback((key: string, change: Partial<Queued>) => setItems(list => list.map(item => item.key === key ? { ...item, ...change } : item)), []);

  // One file at a time, in the order they were dropped.
  const run = useCallback(async () => {
    if (sending.current || !account) return;
    sending.current = true;
    try {
      for (let next = queue.current.shift(); next; next = queue.current.shift()) {
        const { key } = next;
        patch(key, { state: "sending", progress: 0, error: undefined });
        try {
          const saved = await dropFile({ name: next.name, size: next.size, read: documentReader(next.document), post: uploadPost(account, setAccount), onProgress: progress => patch(key, { progress }) });
          patch(key, { state: "saved", progress: 1, saved });
        } catch (e) {
          patch(key, { state: "failed", error: e instanceof Error && e.message ? e.message : "Couldn't send this file. Try again" });
        }
      }
    } finally { sending.current = false; }
  }, [account, setAccount, patch]);

  const add = useCallback((files: { name: string; document: LocalDocument }[]) => {
    setError(null);
    const fresh: Queued[] = [];
    for (const [i, file] of files.entries()) {
      const item: Queued = { key: `${Date.now()}-${i}-${file.name}`, name: file.name, size: file.document.size, document: file.document, state: "waiting", progress: 0 };
      if (!item.size) Object.assign(item, { state: "failed", error: "Couldn't read this file. Folders can't be dropped; zip the folder first" });
      else if (item.size > MAX_DOCUMENT_BYTES) Object.assign(item, { state: "failed", error: "This file is over 100 MB. Choose files under 100 MB each" });
      else queue.current.push(item);
      fresh.push(item);
    }
    setItems(list => [...fresh, ...list]);
    void run();
  }, [run]);

  const retry = (item: Queued) => { queue.current.push(item); patch(item.key, { state: "waiting", error: undefined }); void run(); };

  // In the browser and the Mac app, a file dropped anywhere on this screen's window is taken.
  useEffect(() => {
    if (Platform.OS !== "web" || !offered) return;
    const hasFiles = (event: DragEvent) => !!event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files");
    let depth = 0;
    const enter = (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); depth++; setOver(true); };
    const move = (event: DragEvent) => { if (hasFiles(event)) event.preventDefault(); };
    const leave = (event: DragEvent) => { if (!hasFiles(event)) return; depth = Math.max(0, depth - 1); if (!depth) setOver(false); };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault(); depth = 0; setOver(false);
      add(Array.from(event.dataTransfer!.files).map(blob => ({ name: blob.name, document: { uri: URL.createObjectURL(blob), size: blob.size, blob } })));
    };
    window.addEventListener("dragenter", enter); window.addEventListener("dragover", move);
    window.addEventListener("dragleave", leave); window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", move);
      window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop);
    };
  }, [add, offered]);

  const choose = async () => {
    setChoosing(true); setError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: "*/*", multiple: true, copyToCacheDirectory: true });
      if (result.canceled) return;
      add(result.assets.map(asset => ({ name: asset.name, document: { uri: asset.uri, size: asset.size ?? asset.file?.size ?? (Platform.OS !== "web" ? new File(asset.uri).size : 0), blob: asset.file } })));
    } catch { setError("Couldn't open the file picker. Try again"); }
    finally { setChoosing(false); }
  };

  if (!account) return null;
  if (!offered) return <View style={[styles.root, styles.center]}>
    <Text accessibilityRole="header" style={styles.title}>File drop is off</Text>
    <Text style={styles.hint}>{account.user.role === "owner" ? "Set SERVANT_FILE_DROP_DIR on the server to the folder files should land in, then restart it." : "Only the owner can send files to the server's computer."}</Text>
  </View>;

  const web = Platform.OS === "web";
  return <View style={styles.root}>
    <ScrollView contentContainerStyle={styles.content}>
      <View testID="file-drop-zone" style={[styles.zone, over && styles.zoneOver]}>
        <AppIcon name="folder" size={28} color={over ? colors.blueDark : colors.muted} />
        <Text accessibilityRole="header" style={styles.title}>{over ? "Drop to send" : web ? "Drop files here" : "Send files to the server's computer"}</Text>
        <Text style={styles.hint}>Each file is saved to the file drop folder on the server&apos;s computer. Up to 100 MB each. Nothing there is replaced.</Text>
        <Button label="Choose files" kind={web ? "secondary" : "primary"} busy={choosing} onPress={() => void choose()} />
      </View>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {items.length ? <View style={styles.list}>
        {items.map(item => <View key={item.key} testID="file-drop-item" style={styles.row}>
          <View style={styles.copy}>
            <Text style={styles.name}>{item.name}</Text>
            <Text accessibilityLiveRegion="polite" accessibilityRole={item.state === "failed" ? "alert" : undefined} style={[styles.meta, item.state === "failed" && styles.failed]}>
              {item.state === "failed" ? dropStatus(item) : `${dropStatus(item)} · ${formatFileSize(item.size)}`}
            </Text>
          </View>
          {item.state === "saved" ? <AppIcon name="check" size={18} color={colors.green} />
            : item.state === "failed" && item.size > 0 && item.size <= MAX_DOCUMENT_BYTES ? <Button label="Try again" kind="secondary" compact onPress={() => retry(item)} /> : null}
        </View>)}
      </View> : null}
    </ScrollView>
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  center: { alignItems: "center", justifyContent: "center", gap: space.sm, padding: space.lg },
  content: { padding: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 760, alignSelf: "center", gap: space.md },
  zone: { alignItems: "center", gap: space.sm, padding: space.xl, borderRadius: radius.lg, borderWidth: 2, borderStyle: "dashed", borderColor: colors.line, backgroundColor: colors.surface },
  zoneOver: { borderColor: colors.blue, backgroundColor: colors.blueSoft },
  title: { ...typography.heading, color: colors.ink, textAlign: "center" },
  hint: { ...typography.caption, color: colors.muted, textAlign: "center" },
  error: { ...typography.body, color: colors.red },
  list: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 64, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  copy: { flex: 1, minWidth: 0 },
  name: { ...typography.label, color: colors.ink },
  meta: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  failed: { color: colors.red },
}));
