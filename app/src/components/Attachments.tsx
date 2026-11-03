import { useState } from "react";
import { ActivityIndicator, Image, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { Attachment, Upload } from "../lib/server";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { formatFileSize, isPreviewImage, isPreviewVideo, jpegPhotoUpload, MAX_FILE_BYTES, MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, uploadImageUri, uploadMediaMime, validateAttachmentSelection } from "../lib/media";
import { MediaGalleryProvider, useAttachmentContent, useMediaGallery } from "./MediaGallery";
import { DraftVideoPreview, VideoPreview } from "./VideoMedia";
import { AppIcon } from "./AppIcon";

export type DraftAttachment = Upload & { uri: string; size: number; mime: string };
class TooLarge extends Error {}
async function readFile(uri: string, size?: number, blob?: Blob, limit = MAX_FILE_BYTES, remaining = MAX_UPLOAD_BYTES) {
  const tooLarge = () => new TooLarge(limit === MAX_VIDEO_BYTES ? "Choose videos under 25 MB each" : "Choose photos and files under 5 MB each");
  const check = (bytes: number) => {
    if (bytes > limit) throw tooLarge();
    if (bytes > remaining) throw new TooLarge("Attachments must be under 30 MB total");
  };
  if (size) check(size);
  if (Platform.OS !== "web") {
    const file = new File(uri);
    check(file.size);
    return { data: await file.base64(), size: file.size };
  }
  const file = blob ?? await (await fetch(uri)).blob();
  check(file.size);
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]!);
    reader.onerror = () => reject(new Error("Couldn't read this file"));
    reader.readAsDataURL(file);
  });
  return { data, size: file.size };
}

// Screenshots and camera photos are often over 5 MB (and the agent's model
// refuses images over 5 MB), so shrink big photos instead of refusing them.
const SHRINK_STEPS = [[2560, 0.85], [2048, 0.8], [1600, 0.75], [1200, 0.7]] as const;
async function shrinkPhoto(uri: string, name: string | null | undefined, width?: number, height?: number, maxBytes = MAX_FILE_BYTES): Promise<DraftAttachment> {
  try {
    if (!width || !height) {
      const ref = await ImageManipulator.manipulate(uri).renderAsync();
      width = ref.width; height = ref.height;
    }
    for (const [edge, compress] of SHRINK_STEPS) {
      const context = ImageManipulator.manipulate(uri);
      if (Math.max(width, height) > edge) context.resize(width >= height ? { width: edge } : { height: edge });
      const image = await (await context.renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress, base64: true });
      const data = image.base64?.replace(/^data:[^,]*,/, "");
      if (!data) continue;
      try { return jpegPhotoUpload(name, data, maxBytes); } catch { /* still too big: try the next step */ }
    }
  } catch { /* fall through to the message below */ }
  throw new Error("Couldn't make this photo small enough to send. Try a smaller one.");
}
const shrinkable = (error: unknown) => error instanceof TooLarge || (error instanceof Error && /under 5 MB/.test(error.message));

export async function pickAttachments(mediaLibrary: boolean, existing: readonly DraftAttachment[] = [], { limit = 4, imagesOnly = false }: { limit?: 1 | 2 | 3 | 4; imagesOnly?: boolean } = {}): Promise<DraftAttachment[]> {
  const count = limit - existing.length;
  const limitMessage = limit === 1 ? "Attach one file" : `Attach up to ${limit} files`;
  if (count <= 0) throw new Error(limitMessage);
  const files: DraftAttachment[] = [];
  let remaining = MAX_UPLOAD_BYTES - existing.reduce((total, file) => total + file.size, 0);
  const add = (file: DraftAttachment) => {
    if (imagesOnly && !file.mime.startsWith("image/")) throw new Error("Choose an image");
    validateAttachmentSelection([...existing, ...files, file]);
    files.push(file); remaining -= file.size;
  };
  if (mediaLibrary) {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: imagesOnly ? ["images"] : ["images", "videos"], allowsMultipleSelection: limit > 1, selectionLimit: count, orderedSelection: limit > 1, quality: 0.85, base64: true });
    if (result.canceled) return [];
    if (result.assets.length > count) throw new Error(limitMessage);
    // Read one selection at a time, rejecting its size before creating base64.
    // Several large clips should never be decoded concurrently on a phone.
    for (const asset of result.assets) {
      const video = asset.type === "video" || asset.type === "pairedVideo" || asset.mimeType?.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(asset.fileName ?? asset.uri);
      if (video) {
        if (imagesOnly) throw new Error("Choose an image");
        const content = await readFile(asset.uri, asset.fileSize, asset.file, MAX_VIDEO_BYTES, remaining);
        const mime = uploadMediaMime(content.data);
        if (!mime || !isPreviewVideo({ mime })) throw new Error("Choose an MP4, MOV, or WebM video");
        const extension = mime === "video/quicktime" ? "mov" : mime === "video/webm" ? "webm" : "mp4";
        add({ name: asset.fileName || `video.${extension}`, uri: asset.uri, mime, ...content });
        continue;
      }
      const supported = /^image\/(png|jpeg|gif|webp)$/i.test(asset.mimeType ?? "") || (!asset.mimeType && /\.(png|jpe?g|gif|webp)$/i.test(asset.fileName ?? asset.uri));
      const shrink = () => shrinkPhoto(asset.uri, asset.fileName, asset.width, asset.height, Math.min(MAX_FILE_BYTES, remaining));
      if (!supported && asset.base64) {
        try { add(jpegPhotoUpload(asset.fileName, asset.base64, MAX_FILE_BYTES)); }
        catch (error) { if (!shrinkable(error)) throw error; add(await shrink()); }
        continue;
      }
      if (!supported) throw new Error("Couldn't prepare this photo. Choose a JPEG or PNG image.");
      let content: { data: string; size: number };
      try { content = await readFile(asset.uri, asset.fileSize, asset.file, MAX_FILE_BYTES, remaining); }
      catch (error) { if (!shrinkable(error)) throw error; add(await shrink()); continue; }
      const mime = uploadMediaMime(content.data);
      if (!mime || !/^image\/(png|jpeg|gif|webp)$/.test(mime)) {
        if (asset.base64) { add(jpegPhotoUpload(asset.fileName, asset.base64, MAX_FILE_BYTES)); continue; }
        throw new Error("Couldn't prepare this photo. Choose a JPEG or PNG image.");
      }
      add({ name: asset.fileName || "photo.jpg", uri: asset.uri, mime, ...content });
    }
    return files;
  }
  const result = await DocumentPicker.getDocumentAsync({ type: imagesOnly ? "image/*" : "*/*", multiple: limit > 1, copyToCacheDirectory: true });
  if (result.canceled) return [];
  if (result.assets.length > count) throw new Error(limitMessage);
  for (const asset of result.assets) {
    const mayBeVideo = asset.mimeType?.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(asset.name);
    const mayBePhoto = asset.mimeType?.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(asset.name);
    let content: { data: string; size: number };
    try { content = await readFile(asset.uri, asset.size, asset.file, mayBeVideo ? MAX_VIDEO_BYTES : MAX_FILE_BYTES, remaining); }
    catch (error) {
      if (!mayBePhoto || !shrinkable(error)) throw error;
      add(await shrinkPhoto(asset.uri, asset.name, undefined, undefined, Math.min(MAX_FILE_BYTES, remaining)));
      continue;
    }
    add({ name: asset.name, uri: asset.uri, mime: uploadMediaMime(content.data) || "application/octet-stream", ...content });
  }
  return files;
}

export function DraftAttachments({ files, onRemove, disabled }: { files: DraftAttachment[]; onRemove: (index: number) => void; disabled: boolean }) {
  const styles = useStyles();
  return <ScrollView horizontal accessibilityLabel="Selected attachments" contentContainerStyle={styles.drafts}>
    {files.map((file, i) => <View key={i} style={styles.draft}>
      {isPreviewVideo(file) ? <View style={styles.draftImage}><DraftVideoPreview uri={file.uri} name={file.name} /></View> : file.mime.startsWith("image/") ? <Image source={{ uri: file.uri }} accessibilityLabel={file.name} style={styles.draftImage} resizeMode="cover" /> : <View style={styles.draftFile}><Text style={styles.fileType}>File</Text></View>}
      <Text numberOfLines={1} style={styles.draftName}>{file.name}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${file.name}`} accessibilityState={{ disabled }} disabled={disabled} onPress={() => onRemove(i)} style={styles.remove}><Text style={styles.removeText}>Remove</Text></Pressable>
    </View>)}
  </ScrollView>;
}

function ImageAttachment({ file, tiled }: { file: Attachment; tiled: boolean }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const content = useAttachmentContent(file);
  const gallery = useMediaGallery();
  const [aspect, setAspect] = useState(4 / 3);
  const [decodeError, setDecodeError] = useState(false);
  const failed = !!content.error || decodeError;
  const retry = () => { setDecodeError(false); content.retry(); };
  return <View style={tiled ? styles.tile : styles.singlePhoto}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Open image ${file.name} in conversation gallery`} accessibilityHint="View full screen and swipe through shared files" onPress={() => gallery?.open(file)} style={({ pressed }) => [styles.photo, { aspectRatio: tiled ? 1 : Math.min(2.2, Math.max(0.8, aspect)) }, pressed && styles.pressed]}>
      {content.uri && !decodeError ? <Image source={{ uri: content.uri }} accessibilityLabel={file.name} resizeMode={tiled ? "cover" : "contain"} style={StyleSheet.absoluteFill} onLoad={event => {
        // Web doesn't always report the decoded size.
        const { width = 0, height = 0 } = event.nativeEvent.source ?? {};
        if (width > 0 && height > 0) setAspect(width / height);
      }} onError={() => setDecodeError(true)} /> : <View style={styles.photoPlaceholder}>
        {failed ? <><AppIcon name="paperclip" size={24} color={colors.muted} /><Text style={styles.placeholderText}>Preview unavailable</Text></> : <ActivityIndicator accessibilityLabel="Loading image" color={colors.blue} />}
      </View>}
      <View style={styles.openBadge}><AppIcon name="plus" color={colors.white} size={15} /></View>
    </Pressable>
    {failed ? <Pressable accessibilityRole="button" onPress={retry} style={styles.retry}><Text style={styles.retryText}>Retry image</Text></Pressable> : null}
  </View>;
}

function FileAttachment({ file }: { file: Attachment }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const gallery = useMediaGallery();
  return <Pressable accessibilityRole="button" accessibilityLabel={`Open ${file.name}, ${formatFileSize(file.size)}`} accessibilityHint="View in the conversation gallery" onPress={() => gallery?.open(file)} style={({ pressed }) => [styles.file, pressed && styles.pressed]}>
    <View style={styles.fileIcon}><AppIcon name="paperclip" size={23} color={colors.blueDark} /></View>
    <View style={styles.fileCopy}><Text style={styles.filename} numberOfLines={2}>{file.name}</Text><Text style={styles.fileMeta}>{formatFileSize(file.size)} · {file.name.split(".").pop()?.toUpperCase() || "FILE"}</Text></View>
    <AppIcon name="chevronRight" color={colors.muted} size={18} />
  </Pressable>;
}

function AttachmentTiles({ files }: { files: Attachment[] }) {
  const styles = useStyles();
  const media = files.filter(file => isPreviewImage(file) || isPreviewVideo(file));
  const documents = files.filter(file => !isPreviewImage(file) && !isPreviewVideo(file));
  return <View style={styles.attachments}>
    {media.length ? <View style={styles.photos}>{media.map(file => isPreviewVideo(file) ? <VideoPreview key={file.id} file={file} tiled={media.length > 1} /> : <ImageAttachment key={file.id} file={file} tiled={media.length > 1} />)}</View> : null}
    {documents.map(file => <FileAttachment key={file.id} file={file} />)}
  </View>;
}

export function Attachments({ files }: { files: Attachment[] }) {
  const gallery = useMediaGallery();
  if (!files.length) return null;
  if (gallery) return <AttachmentTiles files={files} />;
  return <MediaGalleryProvider items={files.map(file => ({ ...file, messageId: "", sender: { id: "", name: "" }, createdAt: 0 }))}>
    <AttachmentTiles files={files} />
  </MediaGalleryProvider>;
}

/** Optimistic uploads remain local until the server supplies an attachment ID. */
export function PendingAttachments({ files }: { files: Upload[] }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return <View accessibilityLabel="Attachments being sent" style={styles.attachments}>
    <View style={styles.photos}>{files.map((file, index) => {
      const uri = uploadImageUri(file);
      const video = isPreviewVideo({ mime: uploadMediaMime(file.data) || "" });
      return uri ? <View key={index} style={[files.length > 1 ? styles.tile : styles.singlePhoto, styles.photo, { aspectRatio: files.length > 1 ? 1 : 4 / 3 }]}><Image source={{ uri }} accessibilityLabel={file.name} resizeMode="cover" style={StyleSheet.absoluteFill} /><View style={styles.pendingBadge}><ActivityIndicator size="small" color={colors.white} /><Text style={styles.pendingText}>Sending</Text></View></View>
        : <View key={index} accessibilityLabel={video ? `Sending video ${file.name}` : `Sending file ${file.name}`} style={styles.pendingFile}>{video ? <Text style={styles.videoLabel}>▶ Video</Text> : <AppIcon name="paperclip" color={colors.muted} />}<Text numberOfLines={1} style={styles.filename}>{file.name}</Text><ActivityIndicator size="small" color={colors.blue} /></View>;
    })}</View>
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  drafts: { padding: space.xs, gap: space.xs },
  draft: { width: 120, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, borderRadius: radius.md, overflow: "hidden" },
  draftImage: { width: "100%", height: 72 },
  draftFile: { height: 72, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center" },
  fileType: { ...typography.label, color: colors.blueDark },
  draftName: { ...typography.caption, marginTop: space.xs, paddingHorizontal: space.xs, color: colors.ink },
  remove: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.xs },
  removeText: { ...typography.captionStrong, color: colors.blue },
  attachments: { marginTop: space.xs, gap: space.xs },
  photos: { flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "flex-start" },
  singlePhoto: { width: "100%", maxWidth: 480 },
  tile: { width: "48%", flexGrow: 1, flexBasis: "48%", maxWidth: "50%" },
  photo: { overflow: "hidden", borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, maxHeight: 380 },
  photoPlaceholder: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.xs, padding: space.sm },
  placeholderText: { ...typography.caption, color: colors.muted, textAlign: "center" },
  openBadge: { position: "absolute", right: space.xs, bottom: space.xs, width: 26, height: 26, borderRadius: radius.pill, backgroundColor: "#0007", alignItems: "center", justifyContent: "center" },
  retry: { minHeight: 44, justifyContent: "center", alignItems: "center" },
  retryText: { ...typography.captionStrong, color: colors.blue },
  pressed: { opacity: 0.75 },
  file: { minHeight: 64, padding: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background, flexDirection: "row", alignItems: "center", gap: space.sm },
  fileIcon: { width: 40, height: 44, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", backgroundColor: colors.blueSoft },
  fileCopy: { flex: 1, minWidth: 0 },
  filename: { ...typography.label, color: colors.ink, flexShrink: 1 },
  fileMeta: { ...typography.meta, color: colors.muted, marginTop: space.xxs },
  pendingBadge: { position: "absolute", bottom: space.xs, right: space.xs, borderRadius: radius.pill, backgroundColor: "#0009", paddingHorizontal: space.sm, paddingVertical: space.xxs, flexDirection: "row", alignItems: "center", gap: space.xs },
  pendingText: { ...typography.meta, color: colors.white },
  videoLabel: { ...typography.captionStrong, color: colors.blueDark },
  pendingFile: { width: "100%", flexDirection: "row", alignItems: "center", padding: space.sm, gap: space.xs, borderRadius: radius.md, backgroundColor: colors.surface },
}));
