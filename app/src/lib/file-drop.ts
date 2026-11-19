// File drop: the owner drops a file on the app and it lands in one folder on the server's computer
// (server/file-drop.mjs). The bytes go up in the same chunks as a chat document. Platform-free and testable.
import { uploadDocument, UploadError, type ChunkReader, type UploadPost } from "./document-upload.ts";

export const FILE_DROP_ROUTE = "/v1/file-drop";

/** Sends one file and resolves with the name it was saved under ("plan 2.pdf" when "plan.pdf" was already there). */
export async function dropFile({ name, size, read, post, onProgress, signal }: {
  name: string; size: number; read: ChunkReader; post: UploadPost; onProgress?: (fraction: number) => void; signal?: AbortSignal;
}): Promise<string> {
  let saved = "";
  await uploadDocument({ base: FILE_DROP_ROUTE, name, size, read, post, onProgress, signal, onChunk: result => { if (typeof result?.saved === "string") saved = result.saved; } });
  if (!saved) throw new UploadError("The server didn't confirm it saved this file. Drop it again");
  return saved;
}

export type DropItem = { key: string; name: string; size: number; state: "waiting" | "sending" | "saved" | "failed"; progress: number; saved?: string; error?: string };

/** One line under a file's name: where it is, in plain words. */
export function dropStatus(item: Pick<DropItem, "name" | "state" | "progress" | "saved" | "error">): string {
  switch (item.state) {
    case "waiting": return "Waiting";
    case "sending": return `Sending ${Math.floor(item.progress * 100)}%`;
    case "saved": return item.saved && item.saved !== item.name ? `Saved as ${item.saved}` : "Saved";
    default: return item.error || "Couldn't send this file. Try again";
  }
}
