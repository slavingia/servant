import test from "node:test";
import assert from "node:assert/strict";
import { accountId, accountStorageKey, ACCOUNTS_KEY, LEGACY_ACCOUNT_KEY, createAccountsStore, createLegacyAccountsStore, type Account, type AccountStorage } from "./accounts-store.ts";
const account = (key = "first", token = `${key}-token`): Account => ({ token, serverKey: key, serverUrl: `https://${key}.example`, serverName: key, user: { id: "same-id", name: "Reviewer", role: "member" } });
function fixture(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage: AccountStorage = { getItem: async key => data.get(key) ?? null, setItem: async (key, value) => { data.set(key, value); }, removeItem: async key => { data.delete(key); } };
  return { data, storage, store: createAccountsStore(storage) };
}

test("migration preserves legacy hub fields, identity, and settings before removing old key", async () => {
  const original = { ...account(), serverUrl: undefined, serverName: undefined, hubUrl: "https://old.example", hubName: "Old", deepWork: true, features: { channels: false, directMessages: true, meetings: true } };
  const { data, store } = fixture({ [LEGACY_ACCOUNT_KEY]: JSON.stringify(original) });
  const state = await store.load();
  assert.equal(state.accounts[0].serverUrl, "https://old.example");
  assert.equal(state.accounts[0].serverName, "Old");
  assert.equal(state.accounts[0].deepWork, true);
  assert.equal(data.has(LEGACY_ACCOUNT_KEY), false);
  assert.equal(data.has(accountStorageKey("first")), true);
});

test("failed migration retains original credentials and can retry", async () => {
  const { storage, data } = fixture({ [LEGACY_ACCOUNT_KEY]: JSON.stringify(account()) });
  let fail = true;
  const store = createAccountsStore({ ...storage, setItem: async (key, value) => { if (key === ACCOUNTS_KEY && fail) throw Error("locked"); await storage.setItem(key, value); } });
  await assert.rejects(store.load(), /locked/);
  assert.equal(data.has(LEGACY_ACCOUNT_KEY), true);
  fail = false;
  assert.equal((await store.load()).accounts.length, 1);
});

test("adding and switching persists both accounts and ignores tunnel/name changes for identity", async () => {
  const { store, storage } = fixture();
  await store.add(account()); await store.add(account("second"));
  await store.activate("first");
  await store.update({ ...account("second"), serverUrl: "https://moved.example", serverName: "Renamed" });
  const loaded = await createAccountsStore(storage).load();
  assert.equal(loaded.activeId, "first");
  assert.equal(loaded.accounts.length, 2);
  assert.equal(loaded.accounts[1].serverUrl, "https://moved.example");
  assert.equal(accountId(loaded.accounts[1]), "second");
});

test("concurrent pairings serialize and preserve each server", async () => {
  const { store } = fixture();
  await Promise.all([store.add(account()), store.add(account("second")), store.add(account("third"))]);
  assert.deepEqual((await store.load()).accounts.map(accountId), ["first", "second", "third"]);
});

test("workspace themes persist independently through switching, refresh, and sign-out", async () => {
  const { store, storage } = fixture();
  const first = { ...account(), theme: { primaryColor: "#663399" } };
  const second = { ...account("second"), theme: { primaryColor: "#226633" } };
  await store.add(first);
  await store.add(second);
  const restored = createAccountsStore(storage);
  const activeColor = async () => {
    const state = await restored.load();
    return state.accounts.find(value => accountId(value) === state.activeId)?.theme?.primaryColor;
  };
  assert.equal(await activeColor(), "#226633");
  await restored.activate("first");
  assert.equal(await activeColor(), "#663399");
  await restored.update({ ...second, theme: { primaryColor: "#884422" } });
  assert.equal(await activeColor(), "#663399", "a background refresh cannot change the active workspace color");
  await restored.remove("first");
  assert.equal(await activeColor(), "#884422");
  await restored.remove("second");
  assert.equal(await activeColor(), undefined, "signed-out screens use the default palette");
});

test("signing out one server leaves the next active and stale updates cannot restore it", async () => {
  const { store } = fixture();
  await store.add(account()); await store.add(account("second"));
  await store.remove("second");
  assert.equal(await store.update(account("second")), false);
  assert.deepEqual((await store.load()).accounts.map(accountId), ["first"]);
  assert.equal((await store.load()).activeId, "first");
  await store.remove("first");
  assert.deepEqual(await store.load(), { accounts: [], activeId: null });
});

test("late sign-out or profile update cannot remove or overwrite a re-paired credential", async () => {
  const { store } = fixture();
  await store.add(account()); await store.add(account("first", "new-token"));
  await store.remove("first", "first-token");
  assert.equal(await store.update(account()), false);
  assert.equal((await store.load()).accounts[0].token, "new-token");
});

test("cancelled desktop pairing restores all accounts before a later pairing", async () => {
  const { store, storage } = fixture();
  await store.add(account());
  let current = true;
  const originalSet = storage.setItem;
  storage.setItem = async (key, value) => { await originalSet(key, value); if (key === accountStorageKey("second")) current = false; };
  assert.equal(await store.add(account("second"), () => current), false);
  await store.add(account("third"));
  assert.deepEqual((await createAccountsStore(storage).load()).accounts.map(accountId), ["first", "third"]);
});

test("failed add rolls back and does not strand existing accounts", async () => {
  const { store, storage } = fixture();
  await store.add(account());
  const originalSet = storage.setItem;
  let fail = true;
  storage.setItem = async (key, value) => { if (key === ACCOUNTS_KEY && fail) { fail = false; throw Error("disk full"); } await originalSet(key, value); };
  await assert.rejects(store.add(account("second")), /disk full/);
  assert.deepEqual((await createAccountsStore(storage).load()).accounts.map(accountId), ["first"]);
});

test("corrupt saved registry is reported rather than silently discarding credentials", async () => {
  const { store } = fixture({ [ACCOUNTS_KEY]: JSON.stringify({ version: 1, ids: ["missing"], activeId: "missing" }) });
  await assert.rejects(store.load(), /could not be read/);
});

test("old Mac bridge stays signed in and refuses to overwrite its only account with another server", async () => {
  const { storage } = fixture({ [LEGACY_ACCOUNT_KEY]: JSON.stringify(account()) });
  const store = createLegacyAccountsStore(storage);
  assert.equal((await store.load()).activeId, "first");
  await assert.rejects(store.add(account("second")), /Update the Servant Mac app/);
  await store.update({ ...account(), serverName: "Renamed" });
  assert.equal((await store.load()).accounts[0].serverName, "Renamed");
  await store.remove("first");
  assert.equal((await store.load()).accounts.length, 0);
});

function sharedBrowserStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const watchers = new Map<number, Set<() => void>>();
  let lock: Promise<unknown> = Promise.resolve();
  let nextId = 0;
  let migrations = 0;
  const connection = (): AccountStorage => {
    const id = nextId++;
    const listeners = new Set<() => void>(); watchers.set(id, listeners);
    const notify = () => { for (const [other, callbacks] of watchers) if (other !== id) callbacks.forEach(callback => callback()); };
    return {
      getItem: async key => data.get(key) ?? null,
      setItem: async (key, value) => { data.set(key, value); notify(); },
      removeItem: async key => { if (key === LEGACY_ACCOUNT_KEY && data.has(key)) migrations++; data.delete(key); notify(); },
      transaction: work => {
        const result = lock.then(work);
        lock = result.catch(() => undefined);
        return result;
      },
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
  };
  return { connection, migrations: () => migrations };
}

test("a stale browser tab cannot erase another tab's new server or active selection", async () => {
  const shared = sharedBrowserStorage();
  const first = createAccountsStore(shared.connection());
  const second = createAccountsStore(shared.connection());
  await first.add(account());
  await second.load();
  await first.add(account("second"));
  await second.update({ ...account(), serverName: "First renamed" });
  const saved = await createAccountsStore(shared.connection()).load();
  assert.deepEqual(saved.accounts.map(accountId), ["first", "second"]);
  assert.equal(saved.activeId, "second");
  assert.equal(saved.accounts[0].serverName, "First renamed");
});

test("concurrent browser tabs serialize additions and cannot restore a signed-out server", async () => {
  const shared = sharedBrowserStorage();
  const first = createAccountsStore(shared.connection());
  const second = createAccountsStore(shared.connection());
  await Promise.all([first.load(), second.load()]);
  await Promise.all([first.add(account()), second.add(account("second"))]);
  assert.deepEqual((await first.load()).accounts.map(accountId), ["first", "second"]);
  await first.remove("second");
  assert.equal(await second.update({ ...account("second"), serverName: "Late response" }), false);
  assert.deepEqual((await second.load()).accounts.map(accountId), ["first"]);
});

test("legacy migration across browser tabs runs once under the shared lock", async () => {
  const shared = sharedBrowserStorage({ [LEGACY_ACCOUNT_KEY]: JSON.stringify(account()) });
  const first = createAccountsStore(shared.connection());
  const second = createAccountsStore(shared.connection());
  const [a, b] = await Promise.all([first.load(), second.load()]);
  assert.deepEqual(a, b);
  assert.equal(shared.migrations(), 1);
  await Promise.all([first.add(account("second")), second.add(account("third"))]);
  assert.deepEqual((await first.load()).accounts.map(accountId), ["first", "second", "third"]);
});

test("storage events refresh the other tab only after the complete account transaction", async () => {
  const shared = sharedBrowserStorage();
  const first = createAccountsStore(shared.connection());
  const second = createAccountsStore(shared.connection());
  const seen: { ids: string[]; active: string | null }[] = [];
  const unsubscribe = second.subscribe(state => seen.push({ ids: state.accounts.map(accountId), active: state.activeId }));
  await first.add(account());
  await second.load(); // Drain queued event refreshes deterministically.
  await first.add(account("second"));
  await second.load();
  await first.activate("first");
  await second.load();
  await first.remove("first");
  await second.load();
  unsubscribe();
  assert.deepEqual(seen, [
    { ids: ["first"], active: "first" },
    { ids: ["first", "second"], active: "second" },
    { ids: ["first", "second"], active: "first" },
    { ids: ["second"], active: "second" },
  ]);
});

test("another tab never observes a cancelled pairing's temporary credentials", async () => {
  const shared = sharedBrowserStorage();
  const storage = shared.connection();
  const first = createAccountsStore(storage);
  const second = createAccountsStore(shared.connection());
  await first.add(account());
  const seen: string[][] = [];
  const unsubscribe = second.subscribe(value => seen.push(value.accounts.map(accountId)));
  await second.load();
  let current = true;
  const write = storage.setItem;
  storage.setItem = async (key, value) => { await write(key, value); if (key === accountStorageKey("second")) current = false; };
  assert.equal(await first.add(account("second"), () => current), false);
  await second.load();
  unsubscribe();
  assert.deepEqual(seen, [["first"]]);
});
