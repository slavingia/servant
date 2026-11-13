import { Platform } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { validateInboxFiles, type InboxUpload } from "./secure-inbox";

export async function pickInboxFiles(existing: readonly InboxUpload[]): Promise<InboxUpload[]> {
  if (existing.length >= 4) throw new Error("Attach up to 4 files per reply.");
  const result = await DocumentPicker.getDocumentAsync({ type: "*/*", multiple: true, copyToCacheDirectory: true });
  if (result.canceled) return [];
  if (existing.length + result.assets.length > 4) throw new Error("Attach up to 4 files per reply.");
  const files: InboxUpload[] = [];
  for (const asset of result.assets) {
    const local = Platform.OS === "web" ? asset.file ?? await (await fetch(asset.uri)).blob() : new File(asset.uri);
    const size = local.size;
    validateInboxFiles([...existing, ...files, { size }]);
    const data = local instanceof File ? await local.base64() : await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(new Error("Couldn't read the selected file. Choose it again."));
      reader.readAsDataURL(local);
    });
    files.push({ name: asset.name, size, data });
  }
  return files;
}
