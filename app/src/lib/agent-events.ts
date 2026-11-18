import type { Attachment, Message } from "./server";
import { parseAgentTurn, parseApproval, type AgentTurn, type AgentApproval } from './agent-turns.ts';
import { parseSourceDevice } from './message-device.ts';
import { parsePoster } from './message-poster.ts';
import { parseConnectParts, type ConnectPart } from './connections.ts';

export type StreamEvent =
  | { type: "turn"; turn: AgentTurn }
  | { type: "approval"; approval: AgentApproval }
  | { type: "delta"; text: string }
  | { type: "status"; text: string }
  | { type: "sent"; message: Message }
  | { type: "message"; text: string; attachments?: Attachment[]; id?: string; at?: Message["at"]; connect?: ConnectPart[] }
  | { type: "error"; message: string }
  | { type: "done" };

// Keep work and approval updates live, but publish the reply as one message.
// A dropped connection never flushes an unfinished reply into the conversation.
export function bufferAgentReply(onEvent: (event: StreamEvent) => void): (event: StreamEvent) => void {
  let text = "";
  let message: Extract<StreamEvent, { type: "message" }> | undefined;
  let turnStatus: AgentTurn["status"] | undefined;
  let failed = false;
  let done = false;
  return event => {
    if (done) return;
    if (event.type === "delta") { text += event.text; return; }
    if (event.type === "message") { message = event; return; }
    if (event.type === "turn") turnStatus = event.turn.status;
    if (event.type === "error") failed = true;
    if (event.type === "done") {
      done = true;
      if (message) onEvent(message);
      // Older servers may end with only deltas. Durable runs must confirm a
      // successful terminal state before those deltas can stand in for a reply.
      else if (text && !failed && (!turnStatus || turnStatus === "completed")) onEvent({ type: "message", text });
      text = "";
      message = undefined;
    }
    onEvent(event);
  };
}

function attachments(value: unknown): Attachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item): Attachment[] => {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !/^[\w-]+$/.test(item.id)
      || typeof item.name !== "string" || typeof item.mime !== "string"
      || !Number.isSafeInteger(item.size) || item.size < 0) return [];
    return [{ id: item.id, name: item.name, mime: item.mime, size: item.size }];
  });
}

// The wire carries attachment metadata, never raw image bytes or remote URLs.
export function parseAgentEvent(name: string, payload: Record<string, unknown>): StreamEvent | null {
  if (name === 'turn') { const turn = parseAgentTurn(payload.turn); return turn ? { type: 'turn', turn } : null; }
  if (name === 'approval') { const approval = parseApproval(payload.approval); return approval ? { type: 'approval', approval } : null; }
  const text = typeof payload.text === "string" ? payload.text : "";
  if (name === "delta" || name === "status") return { type: name, text };
  if (name === "error") return { type: "error", message: typeof payload.message === "string" ? payload.message : "The agent hit a problem" };
  if (name === "done") return { type: "done" };
  const source = name === "sent" ? payload.message : payload;
  if ((name !== "sent" && name !== "message") || !source || typeof source !== "object") return null;
  const value = source as Record<string, unknown>;
  const files = attachments(value.attachments);
  const at = typeof value.at === "string" || typeof value.at === "number" || value.at === null ? value.at : undefined;
  const id = typeof value.id === "string" ? value.id : undefined;
  const body = typeof value.text === "string" ? value.text : "";
  if (name === "sent") {
    if (!id || value.role !== "user" || (!body && !files?.length)) return null;
    const sourceDevice = parseSourceDevice(value.sourceDevice);
    const postedBy = parsePoster(value.postedBy);
    return { type: "sent", message: { id, role: "user", text: body, at, attachments: files, ...(sourceDevice ? { sourceDevice } : {}), ...(postedBy ? { postedBy } : {}) } };
  }
  const connect = parseConnectParts(value.connect);
  return { type: "message", id, text: body, at, attachments: files, ...(connect.length ? { connect } : {}) };
}

export function createAgentEventDecoder(onEvent: (event: StreamEvent) => void) {
  let buffer = "";
  let completed = false;
  const decoder = new TextDecoder();
  const consume = () => {
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(buffer);
      if (!boundary) break;
      if (boundary.index > 2 * 1024 * 1024) throw new Error("Agent response frame too large");
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      let name = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (!data.length) continue;
      const payload: unknown = JSON.parse(data.join("\n"));
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid agent response");
      const event = parseAgentEvent(name, payload as Record<string, unknown>);
      if (event) {
        onEvent(event);
        if (event.type === "done") completed = true;
      }
    }
    if (buffer.length > 2 * 1024 * 1024) throw new Error("Agent response frame too large");
  };
  return {
    push(chunk: Uint8Array) { buffer += decoder.decode(chunk, { stream: true }); consume(); },
    finish() {
      buffer += decoder.decode();
      consume();
      if (buffer.trim()) throw new Error("Agent response ended mid-frame");
      if (!completed) throw new Error("Agent response ended before completion");
    },
  };
}
