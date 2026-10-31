// Streaming SSE framing and acknowledgement are independent of native APIs so
// reconnect behavior can be tested without a phone or a running app.
export type EventFrame = { event: string; data: Record<string, unknown>; id?: string };
export const validEventCursor = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value));

export function createLiveEventDecoder(
  onEvent: (event: EventFrame) => void,
  options: { cursor?: string; onCursor?: (cursor: string | undefined) => void } = {},
) {
  if (options.cursor !== undefined && !validEventCursor(options.cursor)) throw new Error("Invalid live event cursor");
  let cursor = options.cursor;
  let buffer = "";
  const decoder = new TextDecoder();
  const acknowledge = (next: string | undefined) => {
    cursor = next;
    options.onCursor?.(next);
  };
  const parse = (block: string) => {
    let event = "";
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!event && !data.length) return; // Keepalive/comment block.
    if (!event || !data.length || (id !== undefined && !validEventCursor(id))) throw new Error("Invalid live event frame");
    const payload: unknown = JSON.parse(data.join("\n"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid live event data");
    const frame = { event, data: payload as Record<string, unknown>, ...(id === undefined ? {} : { id }) };
    if (event === "ready" || event === "checkpoint") {
      const legacyReady = event === "ready" && id === undefined && frame.data.cursor === undefined && frame.data.reset === undefined;
      if (!legacyReady && (!validEventCursor(frame.data.cursor) || frame.data.cursor !== id)) {
        throw new Error("Invalid live event checkpoint");
      }
      if (frame.data.reset !== undefined && typeof frame.data.reset !== "boolean") throw new Error("Invalid live event reset");
      if (id !== undefined && cursor !== undefined && Number(id) < Number(cursor) && frame.data.reset !== true) {
        throw new Error("Live event cursor moved backwards");
      }
      // A ready frame is still meaningful when no events were missed. A reset
      // can legitimately lower the cursor after restoring/replacing a database.
      onEvent(frame);
      acknowledge(id); // An older server's ready:{} disables resume.
      return;
    }
    if (id !== undefined && cursor !== undefined && Number(id) <= Number(cursor)) return;
    onEvent(frame);
    // A consumer failure must leave its cursor unchanged so reconnect can retry.
    if (id !== undefined) acknowledge(id);
  };
  const consume = () => {
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(buffer);
      if (!boundary) break;
      if (boundary.index > 256 * 1024) throw new Error("Live event frame too large");
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      parse(block);
    }
    if (buffer.length > 256 * 1024) throw new Error("Live event frame too large");
  };
  return {
    push(chunk: Uint8Array) { buffer += decoder.decode(chunk, { stream: true }); consume(); },
    finish() {
      buffer += decoder.decode();
      consume();
      if (buffer.trim()) throw new Error("Live event stream ended mid-frame");
    },
    get cursor() { return cursor; },
  };
}
