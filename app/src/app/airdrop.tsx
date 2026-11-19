import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { useFocusEffect } from "expo-router";
import { File } from "expo-file-system";
import { AppIcon } from "../components/AppIcon";
import { Button } from "../components/Button";
import { contextMenuSupported } from "../components/ContextMenu";
import { documentReader } from "../components/Attachments";
import { uploadChunks } from "../lib/document-upload";
import { MAX_DOCUMENT_BYTES } from "../lib/media";
import { api, uploadPost, type LocalDocument } from "../lib/server";
import { useSession } from "../lib/session";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

type Sent = { key: string; name: string; state: "sending" | "saved" | "failed"; progress: number; savedAs?: string; error?: string };

// AirDrop: drop a file here (or choose one) and it lands on the server computer's Desktop.
// Uses the same chunked upload as chat attachments, so it works from a phone through the tunnel too.
export default function Airdrop() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account, setAccount } = useSession();
  const [folder, setFolder] = useState("Desktop");
  const [over, setOver] = useState(false);
  const [sent, setSent] = useState<Sent[]>([]);
  const queue = useRef(Promise.resolve());

  useEffect(() => { if (account) api.airdropFolder(account).then(setFolder, () => {}); }, [account]);

  const update = (key: string, patch: Partial<Sent>) => setSent(list => list.map(s => s.key === key ? { ...s, ...patch } : s));

  const send = useCallback((files: { name: string; document: LocalDocument }[]) => {
    if (!account) return;
    for (const file of files) {
      const key = `${Date.now()}-${Math.random()}`;
      setSent(list => [{ key, name: file.name, state: "sending", progress: 0 }, ...list]);
      // One at a time, in the order they were dropped.
      queue.current = queue.current.then(async () => {
        try {
          if (file.document.size > MAX_DOCUMENT_BYTES) throw new Error("Choose files under 100 MB each");
          if (!file.document.size) throw new Error("This file is empty");
          const { last } = await uploadChunks({ base: "/v1/airdrop", name: file.name, size: file.document.size, read: documentReader(file.document), post: uploadPost(account, setAccount),
            onProgress: progress => update(key, { progress }) });
          update(key, { state: "saved", progress: 1, savedAs: String(last?.saved ?? file.name) });
        } catch (e) {
          update(key, { state: "failed", error: e instanceof Error ? e.message : "Couldn't send this file" });
        }
      });
    }
  }, [account, setAccount]);

  // On the web (and the Mac app), the whole window is the drop zone while this screen is open.
  useFocusEffect(useCallback(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const enter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; setOver(true); };
    const overFn = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; };
    const leave = (e: DragEvent) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) setOver(false); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; setOver(false);
      const files = Array.from(e.dataTransfer!.files).filter(f => f.size > 0 || f.type);
      send(files.map(f => ({ name: f.name, document: { uri: "", size: f.size, blob: f } })));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", overFn);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", overFn);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [send]));

  const choose = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: "*/*", multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return;
    send(result.assets.map(asset => {
      const size = asset.size ?? asset.file?.size ?? (Platform.OS !== "web" ? new File(asset.uri).size : 0);
      return { name: asset.name, document: { uri: asset.uri, size, blob: asset.file } };
    }));
  };

  if (!account) return null;
  // Lead with dragging only where there's a mouse or trackpad; a phone browser can't drag files in.
  const web = contextMenuSupported();
  return <ScrollView style={styles.root} contentContainerStyle={styles.content}>
    <View accessibilityLabel={web ? `Drop files to send them to ${folder}` : undefined} style={[styles.zone, over && { borderColor: colors.blue, backgroundColor: colors.blueSoft }]}>
      <AppIcon name="upload" size={32} color={over ? colors.blue : colors.muted} />
      <Text accessibilityRole="header" style={styles.title}>{over ? "Drop to send" : web ? "Drop files here" : "Send files to the computer"}</Text>
      <Text style={styles.body}>They appear in {folder} on the computer running Servant</Text>
      <Button label={web ? "Or choose files" : "Choose files"} kind={web ? "secondary" : "primary"} onPress={() => void choose()} />
    </View>
    {sent.length ? <View style={styles.list}>
      {sent.map(s => <View key={s.key} style={styles.row}>
        <AppIcon name={s.state === "saved" ? "check" : s.state === "failed" ? "close" : "upload"} size={18} color={s.state === "failed" ? colors.red : s.state === "saved" ? colors.green : colors.muted} />
        <View style={styles.grow}>
          <Text style={styles.name}>{s.name}</Text>
          <Text accessibilityLiveRegion="polite" style={[styles.meta, s.state === "failed" && { color: colors.red }]}>
            {s.state === "sending" ? `Sending ${Math.floor(s.progress * 100)}%` : s.state === "saved" ? (s.savedAs && s.savedAs !== s.name ? `Saved as ${s.savedAs}` : `In ${folder}`) : s.error}
          </Text>
        </View>
      </View>)}
    </View> : null}
  </ScrollView>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.side, gap: space.lg, width: "100%", maxWidth: 760, alignSelf: "center" },
  zone: { alignItems: "center", justifyContent: "center", gap: space.sm, minHeight: 240, padding: space.xl, borderRadius: radius.lg, borderWidth: 2, borderStyle: "dashed", borderColor: colors.line },
  title: { ...typography.heading, color: colors.ink, textAlign: "center" },
  body: { ...typography.body, color: colors.muted, textAlign: "center", marginBottom: space.sm },
  list: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.sm, minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  grow: { flex: 1, minWidth: 0 },
  name: { ...typography.bodyStrong, color: colors.ink },
  meta: { ...typography.caption, color: colors.muted },
}));
