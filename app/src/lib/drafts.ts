// Unsent messages, kept per conversation so leaving mid-message doesn't lose
// the text. Memory answers right away; the device copy survives a restart.
const KEY = "servant.drafts";
const MAX = 30;
let drafts: Record<string, string> = {};
let loading: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function getDraft(key: string): string {
  return drafts[key] ?? "";
}

export function loadDrafts(): Promise<void> {
  loading ??= import("./storage").then(m => m.getItem(KEY)).then(raw => {
    if (!raw) return;
    const saved = JSON.parse(raw) as Record<string, string>;
    // Anything typed since launch wins over the saved copy.
    drafts = { ...saved, ...drafts };
  }).catch(() => {});
  return loading;
}

export function setDraft(key: string, text: string) {
  if (text.trim()) { delete drafts[key]; drafts[key] = text; } else delete drafts[key];
  const keys = Object.keys(drafts);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX))) delete drafts[old];
  clearTimeout(timer);
  timer = setTimeout(() => { void import("./storage").then(m => m.setItem(KEY, JSON.stringify(drafts))).catch(() => {}); }, 500);
}

// A draft written from another screen (a prototype adjustments request) also
// reaches a message box that's already open for that conversation.
const replaced = new Map<string, Set<(text: string) => void>>();
export function onDraftReplaced(key: string, listener: (text: string) => void) {
  const set = replaced.get(key) ?? new Set();
  set.add(listener);
  replaced.set(key, set);
  return () => { set.delete(listener); if (!set.size) replaced.delete(key); };
}
/** Adds text to a conversation's unsent draft (after anything already typed) and shows it in its message box. */
export function appendToDraft(key: string, text: string) {
  const current = getDraft(key).trimEnd();
  const next = current ? `${current}\n\n${text}` : text;
  setDraft(key, next);
  replaced.get(key)?.forEach(listener => listener(next));
  return next;
}

// A screen asking the message box for a conversation to open its photo picker
// (the design starter "From a sketch or screenshot").
const attachRequests = new Map<string, Set<() => void>>();
export function onAttachRequested(key: string, listener: () => void) {
  const set = attachRequests.get(key) ?? new Set();
  set.add(listener);
  attachRequests.set(key, set);
  return () => { set.delete(listener); if (!set.size) attachRequests.delete(key); };
}
export function requestAttachment(key: string) {
  attachRequests.get(key)?.forEach(listener => listener());
}
