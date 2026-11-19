export type Account = {
  token: string;
  serverUrl: string;
  serverKey?: string;
  discovery?: string;
  serverName: string;
  features?: { channels: boolean; directMessages: boolean; secureInbox: boolean };
  theme?: { primaryColor: string };
  recordsKept?: boolean;
  /** The owner of a server with a file drop folder (server/file-drop.mjs). */
  fileDrop?: boolean;
  deepWork?: boolean;
  banner?: { message: string };
  /** The onboarding tour is waiting: this person just joined and has not finished or skipped it (server/tour.mjs). Absent on a server without the tour. */
  tourDue?: boolean;
  /** This device closed the tour and the server has not confirmed it yet: it stays closed here, and the server is told again (lib/tour-seen.ts). */
  tourClosed?: boolean;
  /** `jobRole` is the role they chose for themselves (server/job-roles.mjs). It describes them; `role` is what decides access. */
  user: { id: string; name: string; role: "owner" | "member"; jobRole?: { id: string; label: string } };
};
export type Accounts = { accounts: Account[]; activeId: string | null };
export type AccountStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
  /** Serialize the entire transaction across browser tabs, including migration. */
  transaction?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Changes made by another renderer; reload under the same transaction lock. */
  subscribe?: (listener: () => void) => () => void;
};
export const ACCOUNTS_KEY = "servant.accounts";
export const LEGACY_ACCOUNT_KEY = "servant.account";

/** One signed-in identity per server. Names, token rotation, and tunnel moves do not change this ID. */
export const accountId = (account: Pick<Account, "serverKey" | "discovery" | "serverUrl">): string => account.serverKey || account.discovery || account.serverUrl.replace(/\/+$/, "");
// SecureStore accepts only alphanumeric characters, '.', '-' and '_'.
export const accountStorageKey = (id: string): string => `servant.account.${Array.from(id, char => char.codePointAt(0)!.toString(16).padStart(6, "0")).join("")}`;

function parseAccount(raw: string): Account {
  const saved = JSON.parse(raw);
  const { hubUrl, hubName, ...rest } = saved;
  const account = { ...rest, serverUrl: rest.serverUrl ?? hubUrl ?? "", serverName: rest.serverName ?? hubName ?? "Server" };
  if (!account.token || typeof account.token !== "string" || typeof account.serverUrl !== "string" || !account.serverUrl || !account.user || typeof account.user.id !== "string" || typeof account.user.name !== "string" || !["owner", "member"].includes(account.user.role)) throw new Error("Saved server account is incomplete");
  return account;
}
const manifest = (state: Accounts) => JSON.stringify({ version: 1, ids: state.accounts.map(accountId), activeId: state.activeId });

/** Serialize read-modify-write operations so a late response cannot restore a removed server. */
export function createAccountsStore(storage: AccountStorage) {
  let tail: Promise<unknown> = Promise.resolve();
  let published: string | null = null;
  let unwatch: (() => void) | undefined;
  const listeners = new Set<(value: Accounts) => void>();
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(() => storage.transaction ? storage.transaction(work) : work());
    tail = result.catch(() => undefined);
    return result;
  };
  const publish = (next: Accounts) => {
    const serialized = JSON.stringify(next);
    if (serialized === published) return;
    published = serialized;
    listeners.forEach(listener => listener(next));
  };
  const read = async (): Promise<Accounts> => {
    const raw = await storage.getItem(ACCOUNTS_KEY);
    if (raw !== null) {
      const index = JSON.parse(raw);
      if (index.version !== 1 || !Array.isArray(index.ids) || !index.ids.every((id: unknown) => typeof id === "string") || new Set(index.ids).size !== index.ids.length || (index.activeId !== null && !index.ids.includes(index.activeId))) throw new Error("Saved server list is incomplete");
      const accounts: Account[] = [];
      for (const id of index.ids) {
        const entry = await storage.getItem(accountStorageKey(id));
        if (!entry) throw new Error("A saved server could not be read");
        const account = parseAccount(entry);
        if (accountId(account) !== id) throw new Error("Saved server identity does not match");
        accounts.push(account);
      }
      return { accounts, activeId: index.activeId ?? (accounts[0] ? accountId(accounts[0]) : null) };
    }
    const legacy = await storage.getItem(LEGACY_ACCOUNT_KEY);
    if (!legacy) return { accounts: [], activeId: null };
    const account = parseAccount(legacy);
    const migrated = { accounts: [account], activeId: accountId(account) };
    await storage.setItem(accountStorageKey(accountId(account)), JSON.stringify(account));
    await storage.setItem(ACCOUNTS_KEY, manifest(migrated));
    // A failed migration never removes the original credentials.
    await storage.removeItem(LEGACY_ACCOUNT_KEY);
    return migrated;
  };
  const save = (account: Account, add: boolean, current?: () => boolean) => queue(async () => {
    const before = await read();
    if (current && !current()) return false;
    const id = accountId(account);
    const previous = before.accounts.find(value => accountId(value) === id);
    // Updates from a signed-out device or superseded token must never resurrect it.
    if (!add && (!previous || previous.token !== account.token)) return false;
    if (!add && JSON.stringify(previous) === JSON.stringify(account)) return true;
    const next = {
      accounts: previous ? before.accounts.map(value => accountId(value) === id ? account : value) : [...before.accounts, account],
      activeId: add ? id : before.activeId,
    };
    const key = accountStorageKey(id);
    const rollback = async () => {
      if (previous) await storage.setItem(key, JSON.stringify(previous)); else await storage.removeItem(key);
      await storage.setItem(ACCOUNTS_KEY, manifest(before));
    };
    try {
      await storage.setItem(key, JSON.stringify(account));
      if (current && !current()) { await rollback(); return false; }
      await storage.setItem(ACCOUNTS_KEY, manifest(next));
      if (current && !current()) { await rollback(); return false; }
    } catch (error) {
      await rollback();
      throw error;
    }
    publish(next);
    return true;
  });
  return {
    load: () => queue(async () => { const value = await read(); publish(value); return value; }),
    subscribe: (listener: (value: Accounts) => void) => {
      listeners.add(listener);
      unwatch ??= storage.subscribe?.(() => {
        // A storage event may arrive between a record and manifest write. The
        // transaction lock ensures subscribers see only the completed mutation.
        void queue(async () => publish(await read())).catch(() => {});
      });
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { unwatch?.(); unwatch = undefined; }
      };
    },
    add: (account: Account, current?: () => boolean) => save(account, true, current),
    update: (account: Account) => save(account, false),
    activate: (id: string) => queue(async () => {
      const before = await read();
      if (!before.accounts.some(value => accountId(value) === id)) throw new Error("This server is no longer signed in");
      if (before.activeId === id) return;
      const next = { ...before, activeId: id };
      await storage.setItem(ACCOUNTS_KEY, manifest(next));
      publish(next);
    }),
    remove: (id: string, token?: string) => queue(async () => {
      const before = await read();
      const account = before.accounts.find(value => accountId(value) === id);
      if (!account || (token && account.token !== token)) return;
      const accounts = before.accounts.filter(value => accountId(value) !== id);
      const next = { accounts, activeId: before.activeId === id ? (accounts[0] ? accountId(accounts[0]) : null) : before.activeId };
      // Commit the list before deleting the credential. A crash can leave an orphan,
      // but cannot make another saved server unreadable or bring this one back.
      await storage.setItem(ACCOUNTS_KEY, manifest(next));
      publish(next);
      await storage.removeItem(accountStorageKey(id));
      await storage.removeItem(LEGACY_ACCOUNT_KEY);
    }),
  };
}

/** OTA updates also run in older Mac binaries whose encrypted bridge accepts
 * only the original key. Keep that installation usable until its binary updates. */
export function createLegacyAccountsStore(storage: AccountStorage) {
  const listeners = new Set<(state: Accounts) => void>();
  let tail: Promise<unknown> = Promise.resolve();
  const queue = <T>(operation: () => Promise<T>): Promise<T> => { const result = tail.then(operation); tail = result.catch(() => undefined); return result; };
  const load = async (): Promise<Accounts> => {
    const raw = await storage.getItem(LEGACY_ACCOUNT_KEY);
    const account = raw ? parseAccount(raw) : null;
    return { accounts: account ? [account] : [], activeId: account ? accountId(account) : null };
  };
  const emit = async () => { const state = await load(); listeners.forEach(listener => listener(state)); };
  const save = (account: Account, add: boolean, current?: () => boolean) => queue(async () => {
    const before = await load();
    const previous = before.accounts[0];
    if (current && !current()) return false;
    if (add && previous && accountId(previous) !== accountId(account)) throw new Error("Update the Servant Mac app to join another server");
    if (!add && (!previous || previous.token !== account.token || accountId(previous) !== accountId(account))) return false;
    await storage.setItem(LEGACY_ACCOUNT_KEY, JSON.stringify(account));
    if (current && !current()) {
      if (previous) await storage.setItem(LEGACY_ACCOUNT_KEY, JSON.stringify(previous)); else await storage.removeItem(LEGACY_ACCOUNT_KEY);
      return false;
    }
    await emit();
    return true;
  });
  return {
    load: () => queue(load),
    subscribe: (listener: (state: Accounts) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    add: (account: Account, current?: () => boolean) => save(account, true, current),
    update: (account: Account) => save(account, false),
    activate: (id: string) => queue(async () => { if ((await load()).activeId !== id) throw new Error("Update the Servant Mac app to join another server"); }),
    remove: (id: string, token?: string) => queue(async () => {
      const current = (await load()).accounts[0];
      if (current && accountId(current) === id && (!token || token === current.token)) { await storage.removeItem(LEGACY_ACCOUNT_KEY); await emit(); }
    }),
  };
}
