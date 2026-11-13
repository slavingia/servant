// Unsent messages, kept per conversation so leaving mid-message doesn't lose
// the text. Memory answers right away; the device copy survives a restart.
const KEY = "servant.drafts";
const MAX = 30;
let drafts: Record<string, string> = {};
let loading: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
// Bumped on sign-out so a load or save already under way for the previous person is ignored.
let generation = 0;

export function getDraft(key: string): string {
  return drafts[key] ?? "";
}

export function loadDrafts(): Promise<void> {
  const mine = generation;
  loading ??= import("./storage").then(m => m.getItem(KEY)).then(raw => {
    if (!raw || mine !== generation) return;
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
  const mine = generation;
  timer = setTimeout(() => { void import("./storage").then(m => { if (mine === generation) return m.setItem(KEY, JSON.stringify(drafts)); }).catch(() => {}); }, 500);
}

/** Sign-out: unsent text is the signed-out person's, so drop it from memory and from the device, and ignore any
 * load or save still in flight, so the next person on this device never sees it. */
export async function clearDrafts(scope?: string): Promise<void> {
  await loadDrafts();
  generation++;
  clearTimeout(timer);
  drafts = scope ? Object.fromEntries(Object.entries(drafts).filter(([key]) => !key.startsWith(`account:${scope}:`))) : {};
  loading = null;
  try { await import("./storage").then(m => Object.keys(drafts).length ? m.setItem(KEY, JSON.stringify(drafts)) : m.removeItem(KEY)); } catch { /* nothing saved, or storage unavailable */ }
}

/** Claim drafts saved before accounts were separated, once, for the migrated account. */
export async function migrateDrafts(scope: string): Promise<void> {
  await loadDrafts();
  let changed = false;
  for (const key of Object.keys(drafts)) {
    if (key.startsWith("account:")) continue;
    drafts[`account:${scope}:${key}`] = drafts[key];
    delete drafts[key];
    changed = true;
  }
  if (changed) await import("./storage").then(m => m.setItem(KEY, JSON.stringify(drafts))).catch(() => {});
}
