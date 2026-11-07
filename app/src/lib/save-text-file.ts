import { Platform } from "react-native";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

/**
 * Hands a text file to the person: a download in the browser, the share sheet
 * on phones. Native copies are temporary and deleted once the sheet closes.
 */
export async function saveTextFile(name: string, text: string, mimeType = "application/json") {
  const filename = name.replace(/[/\\\u0000-\u001f]/g, "_").slice(0, 180) || "file.json";
  if (Platform.OS === "web") {
    const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
    const link = document.createElement("a");
    link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return;
  }
  if (!await Sharing.isAvailableAsync()) throw new Error("Sharing is unavailable on this device");
  const local = new File(Paths.cache, `${Date.now()}-${filename}`);
  try {
    await local.write(text);
    await Sharing.shareAsync(local.uri, { mimeType, dialogTitle: filename });
  } finally { if (local.exists) local.delete(); }
}
