// Documents and design files are too big for one encrypted request, so they
// go up in chunks before the message that names them. Platform-free and testable.
import { DOCUMENT_CHUNK_BYTES, MAX_DOCUMENT_BYTES } from "./media.ts";
import { toBase64 } from "./tunnel-crypto.ts";

export type ChunkReader = (offset: number, length: number) => Promise<Uint8Array>;
/** Resolves with the JSON body; rejects with `{ status, code, message }` (status 0 = network). */
export type UploadPost = (path: string, body: unknown) => Promise<any>;

export class UploadError extends Error {}

async function call(post: UploadPost, path: string, body: unknown) {
  try { return await post(path, body); }
  catch (error) {
    const { status = 0, code = "", message = "" } = (error ?? {}) as { status?: number; code?: string; message?: string };
    throw Object.assign(new UploadError(status ? message || "Couldn't upload this file. Try again" : "Couldn't upload this file. Check your connection and try again"), {
      status, expected: code === "upload_offset" ? Number(message.match(/\d+/)?.[0]) : undefined,
    });
  }
}

/** Returns the server's upload ID once every byte has arrived. */
export async function uploadDocument({ chatId, base: route, name, size, read, post, onProgress, onChunk, signal }: {
  /** The chat the document is for, or `base`: another route that takes the same chunks (file drop). */
  chatId?: string; base?: string; onChunk?: (result: any) => void; name: string; size: number; read: ChunkReader; post: UploadPost; onProgress?: (fraction: number) => void; signal?: AbortSignal;
}): Promise<string> {
  if (!Number.isSafeInteger(size) || size <= 0) throw new UploadError("Couldn't read this file");
  if (size > MAX_DOCUMENT_BYTES) throw new UploadError("Choose documents under 100 MB each");
  const base = route ?? `/v1/chats/${encodeURIComponent(chatId ?? "")}/uploads`;
  const created = await call(post, base, { name, size });
  const id = String(created.id);
  const chunk = Math.min(Number(created.chunkBytes) || DOCUMENT_CHUNK_BYTES, DOCUMENT_CHUNK_BYTES);
  let offset = Number(created.received) || 0;
  let retries = 0;
  onProgress?.(offset / size);
  while (offset < size) {
    if (signal?.aborted) throw new UploadError("Upload canceled");
    const bytes = await read(offset, Math.min(chunk, size - offset));
    if (!bytes.length) throw new UploadError("Couldn't read this file");
    try {
      const result = await call(post, `${base}/${encodeURIComponent(id)}`, { offset, data: toBase64(bytes) });
      offset = Number(result.received);
      retries = 0;
      onChunk?.(result);
    } catch (error) {
      // A dropped connection may have delivered the chunk; resume where the server is.
      const expected = (error as { expected?: number }).expected;
      if (Number.isSafeInteger(expected) && retries++ < 3) { offset = expected!; continue; }
      if (!(error as { status?: number }).status && retries++ < 3) continue;
      throw error;
    }
    onProgress?.(Math.min(1, offset / size));
  }
  return id;
}

/** Joins ranged downloads of a stored document into one base64 string. */
export async function downloadDocument(first: { data: string; size: number }, fetchRange: (offset: number) => Promise<{ data: string; offset: number; size: number }>) {
  if (!Number.isSafeInteger(first.size) || first.size < 0 || first.size > MAX_DOCUMENT_BYTES) throw new Error("Attachment content is unavailable");
  const parts = [first.data];
  let received = decodedLength(first.data);
  while (received < first.size) {
    const next = await fetchRange(received);
    const length = decodedLength(next.data);
    if (next.offset !== received || !length) throw new Error("Attachment content is unavailable");
    parts.push(next.data);
    received += length;
  }
  if (received !== first.size || parts.slice(0, -1).some(part => part.endsWith("="))) throw new Error("Attachment content is unavailable");
  return parts.join("");
}

const decodedLength = (data: string) => {
  if (typeof data !== "string" || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("Attachment content is unavailable");
  return data.length * 3 / 4 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
};
