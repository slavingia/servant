// Sends what the share sheet handed us the way the chat composer sends a message: a new agent
// chat (or the person's last one), documents up in chunks first, then the message with
// everything attached. Platform-free: the screen injects the API calls, so the path is tested.
import type { StreamEvent } from "./agent-events.ts";
import type { Projects } from "./projects-store";
import type { Upload } from "./server";

export type ShareTarget = { kind: "new"; projectId: string | null } | { kind: "chat"; id: string; title: string };
export type ShareChat = { id: string; title: string };
export type ShareStage = "create" | "upload" | "send";
export type ShareProgress = { stage: ShareStage; file?: string; fraction?: number };
export type ShareSendDeps = {
  newChat: (options: { projectId?: string }) => Promise<ShareChat>;
  /** Chunked document upload; resolves with the server's upload id (document-upload.ts). */
  uploadDocument: (chatId: string, file: Upload, onProgress: (fraction: number) => void) => Promise<string>;
  /** POST the message and stream the reply (server.ts sendMessage). */
  send: (chatId: string, text: string, uploads: Upload[], requestId: string, onEvent: (event: StreamEvent) => void, signal: AbortSignal) => Promise<void>;
};

/** Carries what already happened, so a retry doesn't start another chat or upload a document twice. */
export class ShareSendError extends Error {
  stage: ShareStage;
  chat: ShareChat | null;
  uploads: Upload[];
  constructor(message: string, stage: ShareStage, chat: ShareChat | null, uploads: Upload[]) {
    super(message);
    this.stage = stage; this.chat = chat; this.uploads = uploads;
  }
}

export const CONFIRM_FAILED = "Couldn't confirm this message was sent. Check the chat before trying again.";

/** The line under the Send button while it works. */
export function progressLabel(progress: ShareProgress): string {
  if (progress.stage === "create") return "Starting the chat\u2026";
  if (progress.stage === "upload") return `Uploading ${progress.file ?? "file"}${progress.fraction ? `, ${Math.floor(progress.fraction * 100)}%` : ""}`;
  return "Sending\u2026";
}

/** The title the server gives a chat from its first message (server.mjs), so the header is right before it loads. */
export function shareTitle(text: string, uploads: readonly Upload[]): string {
  return (text.trim() || uploads[0]?.name || "New chat").replace(/\s+/g, " ").slice(0, 60);
}

/** The project the Agent tab would start a chat in (new-chat-choice.ts), when it's still one of the person's projects. */
export function defaultShareProject(projects: Projects | null, remembered: string | null | undefined): string | null {
  if (!projects || projects.vibeCoder || !remembered) return null;
  return projects.list.some(project => project.id === remembered) ? remembered : null;
}

/** The line under "Continue my last chat": what each position of the switch does, so off is never a mystery. */
export function continueHint(projectName: string | null, chatTitle: string): string {
  const title = Array.from(chatTitle.replace(/`/g, "").replace(/\s+/g, " ").trim());
  // A long title is cut short at a word, never mid-word.
  const cut = title.slice(0, 40).join("");
  const space = cut.lastIndexOf(" ");
  const shown = title.length > 40 ? `${(space > 24 ? cut.slice(0, space) : cut).trimEnd()}…` : title.join("");
  const end = /[.?!…]$/.test(shown) ? "" : ".";
  return `Off: starts a new chat${projectName ? ` in ${projectName}` : ""}. On: adds to ${shown || "your last chat"}${end}`;
}

const reason = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

export async function sendShare({ text, uploads, target, requestId, reuse = null, onProgress = () => {}, deps }: {
  text: string; uploads: readonly Upload[]; target: ShareTarget; requestId: string;
  /** The chat a failed attempt already made. */
  reuse?: ShareChat | null; onProgress?: (progress: ShareProgress) => void; deps: ShareSendDeps;
}): Promise<ShareChat> {
  let chat: ShareChat | null = reuse ?? (target.kind === "chat" ? { id: target.id, title: target.title } : null);
  const ready: Upload[] = uploads.map(upload => ({ ...upload }));
  if (!chat) {
    onProgress({ stage: "create" });
    try { chat = await deps.newChat(target.kind === "new" && target.projectId ? { projectId: target.projectId } : {}); }
    catch (error) { throw new ShareSendError(reason(error, "Couldn't start a chat. Check your connection and try again."), "create", null, ready); }
  }
  for (let i = 0; i < ready.length; i++) {
    const file = ready[i]!;
    if (!file.document || file.upload) continue;
    onProgress({ stage: "upload", file: file.name, fraction: 0 });
    try {
      const upload = await deps.uploadDocument(chat.id, file, fraction => onProgress({ stage: "upload", file: file.name, fraction }));
      ready[i] = { ...file, upload };
    } catch (error) { throw new ShareSendError(reason(error, `Couldn't upload ${file.name}. Try again.`), "upload", chat, ready); }
  }
  onProgress({ stage: "send" });
  // The reply streams to whoever is watching; the chat screen takes over once the server has the
  // message, so the stream is closed the moment the message is accepted.
  const controller = new AbortController();
  const state = { accepted: false, failure: null as string | null };
  const accept = () => { if (!state.accepted) { state.accepted = true; controller.abort(); } };
  try {
    await deps.send(chat.id, text, ready, requestId, event => {
      if (event.type === "turn" && event.turn.accepted) accept();
      else if (event.type === "sent" || event.type === "message") accept();
      else if (event.type === "error" && !state.accepted) state.failure = event.message;
    }, controller.signal);
  } catch (error) {
    if (!state.accepted) throw new ShareSendError(reason(error, CONFIRM_FAILED), "send", chat, ready);
  }
  if (!state.accepted) throw new ShareSendError(state.failure ?? CONFIRM_FAILED, "send", chat, ready);
  return { id: chat.id, title: !chat.title || chat.title === "New chat" ? shareTitle(text, ready) : chat.title };
}
