import { Platform } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";

/** Lets the person choose a file and reads it as text on this device. null when they cancel. */
export async function pickTextFile(types: string[] = ["*/*"]): Promise<{ name: string; text: string } | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: types, multiple: false, copyToCacheDirectory: true });
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];
  if (Platform.OS === "web") {
    const text = asset.file ? await asset.file.text() : await (await fetch(asset.uri)).text();
    return { name: asset.name, text };
  }
  const file = new File(asset.uri);
  try { return { name: asset.name, text: await file.text() }; }
  finally { try { if (file.exists) file.delete(); } catch { /* a cache copy; the system clears it */ } }
}
