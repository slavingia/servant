import { useEffect, useState } from "react";
import { Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { request, type Attachment, type Upload } from "../lib/server";
import { useSession } from "../lib/session";
import { colors, radius, space, typography } from "../lib/theme";

export type DraftAttachment = Upload & { uri: string; size: number; mime: string };
const MAX_FILE = 5 * 1024 * 1024;

async function readFile(uri: string, size?: number, blob?: Blob) {
  if (size && size > MAX_FILE) throw new Error("Choose files under 5 MB each");
  if (Platform.OS !== "web") {
    const file = new File(uri);
    if (file.size > MAX_FILE) throw new Error("Choose files under 5 MB each");
    return { data: await file.base64(), size: file.size };
  }
  const file = blob ?? await (await fetch(uri)).blob();
  if (file.size > MAX_FILE) throw new Error("Choose files under 5 MB each");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]!);
    reader.onerror = () => reject(new Error("Couldn't read this file"));
    reader.readAsDataURL(file);
  });
  return { data, size: file.size };
}

export async function pickAttachments(photos: boolean): Promise<DraftAttachment[]> {
  if (photos) {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: 4, quality: 0.85 });
    if (result.canceled) return [];
    if (result.assets.length > 4) throw new Error("Attach up to 4 files");
    return Promise.all(result.assets.map(async a => ({ name: a.fileName || "photo.jpg", uri: a.uri, mime: a.mimeType || "image/jpeg", ...await readFile(a.uri, a.fileSize, a.file) })));
  }
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (result.canceled) return [];
  if (result.assets.length > 4) throw new Error("Attach up to 4 files");
  return Promise.all(result.assets.map(async a => ({ name: a.name, uri: a.uri, mime: a.mimeType || "application/octet-stream", ...await readFile(a.uri, a.size, a.file) })));
}

export function DraftAttachments({ files, onRemove, disabled }: { files: DraftAttachment[]; onRemove: (index: number) => void; disabled: boolean }) {
  return <ScrollView horizontal accessibilityLabel="Selected attachments" contentContainerStyle={styles.drafts}>
    {files.map((file, i) => <View key={i} style={styles.draft}>
      {file.mime.startsWith("image/") ? <Image source={{ uri: file.uri }} accessibilityLabel={file.name} style={styles.draftImage} resizeMode="cover" /> : <View style={styles.draftFile}><Text style={styles.fileType}>File</Text></View>}
      <Text numberOfLines={1} style={styles.draftName}>{file.name}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${file.name}`} accessibilityState={{ disabled }} disabled={disabled} onPress={() => onRemove(i)} style={styles.remove}><Text style={styles.removeText}>Remove</Text></Pressable>
    </View>)}
  </ScrollView>;
}

function AttachmentItem({ file }: { file: Attachment }) {
  const { account } = useSession();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<string>();
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const isImage = file.mime.startsWith("image/");
  useEffect(() => {
    if (!account || !isImage) return;
    let active = true;
    request(account, `/v1/attachments/${file.id}`).then(r => r.json()).then(r => { if (active) setData(r.data); }).catch(() => { if (active) setError("Couldn't load image. Tap to retry"); });
    return () => { active = false; };
  }, [account, file.id, isImage]);
  const open = async () => {
    if (!account || busy) return;
    setBusy(true);
    setError("");
    try {
      const content = data ?? (await (await request(account, `/v1/attachments/${file.id}`)).json()).data as string;
      if (isImage) { setData(content); setExpanded(true); return; }
      if (Platform.OS === "web") {
        const bytes = Uint8Array.from(atob(content), c => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
        const link = document.createElement("a");
        link.href = url; link.download = file.name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } else {
        const local = new File(Paths.cache, `${file.id}-${file.name}`);
        try {
          local.write(content, { encoding: "base64" });
          await Sharing.shareAsync(local.uri, { mimeType: file.mime, dialogTitle: file.name });
        } finally { if (local.exists) local.delete(); }
      }
    } catch { setError("Couldn't open attachment. Tap to retry"); }
    finally { setBusy(false); }
  };
  const uri = data ? `data:${file.mime};base64,${data}` : undefined;
  return <View style={styles.attachment}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${file.name}, ${Math.max(1, Math.round(file.size / 1024))} kilobytes`} accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={open} style={({ pressed }) => [styles.file, pressed && { backgroundColor: colors.blueSoft }]}>
      {isImage && uri ? <Image source={{ uri }} accessibilityLabel={file.name} resizeMode="contain" style={styles.image} onError={() => setError("Image preview unavailable")} /> : null}
      <Text style={styles.filename} numberOfLines={2}>{busy ? "Opening…" : file.name}</Text>
      <Text style={styles.fileMeta}>{isImage ? "Image" : "File"} · {Math.max(1, Math.round(file.size / 1024))} KB</Text>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    </Pressable>
    <Modal visible={expanded} transparent onRequestClose={() => setExpanded(false)}>
      <View accessibilityViewIsModal style={[styles.preview, { paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.md }]}>
        <Pressable accessibilityRole="button" onPress={() => setExpanded(false)} style={styles.close}><Text style={styles.closeText}>Close preview</Text></Pressable>
        {uri ? <Image source={{ uri }} accessibilityLabel={file.name} resizeMode="contain" style={{ flex: 1 }} /> : null}
      </View>
    </Modal>
  </View>;
}

export function Attachments({ files }: { files: Attachment[] }) {
  return <View>{files.map(file => <AttachmentItem key={file.id} file={file} />)}</View>;
}

const styles = StyleSheet.create({
  drafts: { padding: space.sm, gap: space.sm },
  draft: { width: 136, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, borderRadius: radius.md, overflow: "hidden" },
  draftImage: { width: "100%", height: 80 },
  draftFile: { height: 80, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center" },
  fileType: { ...typography.label, color: colors.blueDark },
  draftName: { ...typography.caption, marginTop: space.xs, paddingHorizontal: space.xs, color: colors.ink },
  remove: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.xs },
  removeText: { ...typography.captionStrong, color: colors.blue },
  attachment: { marginTop: space.xs },
  file: { minHeight: 64, padding: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  image: { width: "100%", height: 200, borderRadius: radius.sm, backgroundColor: colors.surface, marginBottom: space.xs },
  filename: { ...typography.label, color: colors.blue },
  fileMeta: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  error: { ...typography.caption, color: colors.red, marginTop: space.xs },
  preview: { flex: 1, backgroundColor: "#000E", paddingHorizontal: space.lg },
  close: { minHeight: 48, justifyContent: "center", alignSelf: "flex-start", paddingHorizontal: space.xs },
  closeText: { ...typography.label, color: colors.white },
});
