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
