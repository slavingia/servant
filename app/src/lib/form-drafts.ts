// Forms kept as drafts on this device, so leaving a form part-way (another
// screen, a closed tab, a restart) doesn't lose what was typed. Each draft is
// for one person on one server. Same storage as unsent messages; signing out
// clears that person's form drafts.
const KEY = "servant.formDrafts";
const MAX = 12;
const MAX_AGE_MS = 60 * 24 * 60 * 60_000;

export type FormDraft = { savedAt: number; value: unknown };
type Store = Record<string, FormDraft>;
type Storage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };

let storage: Promise<Storage> | null = null;
const backend = () => storage ??= import("./storage");
/** For tests: where drafts are kept. */
export function setFormDraftStorage(next: Storage) { storage = Promise.resolve(next); store = null; }

let store: Promise<Store> | null = null;
let writes: Promise<void> = Promise.resolve();

function tidy(saved: Store, now: number): Store {
  const kept = Object.entries(saved)
    .filter(([, draft]) => draft && typeof draft.savedAt === "number" && now - draft.savedAt < MAX_AGE_MS)
    .sort(([, a], [, b]) => b.savedAt - a.savedAt)
    .slice(0, MAX);
  return Object.fromEntries(kept);
}
function load(now = Date.now()): Promise<Store> {
  store ??= backend().then(s => s.getItem(KEY)).then(raw => {
    const parsed = raw ? JSON.parse(raw) : {};
    return tidy(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Store : {}, now);
  }).catch(() => ({}));
  return store;
}
function persist(next: Store) {
  store = Promise.resolve(next);
  writes = writes.then(() => backend()).then(s => s.setItem(KEY, JSON.stringify(next))).catch(() => {});
  return writes;
}

export const formDraftKey = (account: { serverUrl: string; user: { id: string } }, form: string) => `${account.serverUrl}|${account.user.id}|${form}`;

export async function readFormDraft(key: string): Promise<FormDraft | null> {
  return (await load())[key] ?? null;
}
export async function writeFormDraft(key: string, value: unknown, now = Date.now()): Promise<void> {
  const current = await load(now);
  await persist(tidy({ ...current, [key]: { savedAt: now, value } }, now));
}
export async function clearFormDraft(key: string): Promise<void> {
  const current = await load();
  if (!(key in current)) return;
  const { [key]: _removed, ...rest } = current;
  await persist(rest);
}
/** Every draft of this person's on this server (for signing out). */
export async function clearFormDraftsFor(account: { serverUrl: string; user: { id: string } }): Promise<void> {
  const prefix = formDraftKey(account, "");
  const current = await load();
  const rest = Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(prefix)));
  if (Object.keys(rest).length !== Object.keys(current).length) await persist(rest);
}
