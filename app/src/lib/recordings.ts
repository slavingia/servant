// Record a voice memo: the audio goes up in chunks, then the server writes the notes and the next steps.
// Platform-free except `uploadRecording`'s reader, so it can be tested.
import { DOCUMENT_CHUNK_BYTES } from "./media.ts";
import { toBase64 } from "./tunnel-crypto.ts";
import type { ChunkReader, UploadPost } from "./document-upload.ts";
import type { Recording } from "./server.ts";

/** An upload that didn't finish keeps its server id so the next try carries on where it stopped. */
export class RecordingError extends Error {
  recordingId?: string;
  status?: number;
  expected?: number;
}

/**
 * Uploads the audio and starts the notes. Resumes where the server is after a dropped connection,
 * and with `resume` (the id from an earlier failed try) it never starts a second copy.
 */
export async function uploadRecording({ size, durationMs, ext, title, read, post, onProgress, signal, resume }: {
  size: number; durationMs: number; ext: string; title?: string; read: ChunkReader; post: UploadPost;
  onProgress?: (fraction: number) => void; signal?: AbortSignal; resume?: string;
}): Promise<Recording> {
  if (!Number.isSafeInteger(size) || size <= 0) throw new RecordingError("That recording is empty");
  let id = resume;
  const call = async (path: string, body: unknown) => {
    try { return await post(path, body); }
    catch (error) {
      const { status = 0, code = "", message = "" } = (error ?? {}) as { status?: number; code?: string; message?: string };
      throw Object.assign(new RecordingError(status ? message || "Couldn't upload the recording. Try again" : "Couldn't upload the recording. Check your connection and try again"),
        { status, recordingId: id, expected: code === "upload_offset" ? Number(message.match(/\d+/)?.[0]) : undefined });
    }
  };
  let offset = 0;
  let chunk = DOCUMENT_CHUNK_BYTES;
  if (!id) {
    const created = await call("/v1/recordings", { size, durationMs, ext });
    id = String(created.id);
    chunk = Math.min(Number(created.chunkBytes) || DOCUMENT_CHUNK_BYTES, DOCUMENT_CHUNK_BYTES);
    offset = Number(created.received) || 0;
  }
  // On a resumed upload the first piece starts at 0; the server answers with where it really is.
  let retries = 0;
  onProgress?.(offset / size);
  while (offset < size) {
    if (signal?.aborted) throw Object.assign(new RecordingError("Upload canceled"), { recordingId: id });
    const bytes = await read(offset, Math.min(chunk, size - offset));
    if (!bytes.length) throw Object.assign(new RecordingError("Couldn't read the recording"), { recordingId: id });
    try {
      offset = Number((await call(`/v1/recordings/${encodeURIComponent(id)}/chunk`, { offset, data: toBase64(bytes) })).received);
      retries = 0;
    } catch (error) {
      const expected = (error as RecordingError).expected;
      if (Number.isSafeInteger(expected) && retries++ < 3) { offset = expected!; continue; }
      if (!(error as RecordingError).status && retries++ < 3) continue;
      throw error;
    }
    onProgress?.(Math.min(1, offset / size));
  }
  return (await call(`/v1/recordings/${encodeURIComponent(id)}/finish`, title ? { title } : {})).recording as Recording;
}
