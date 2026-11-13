import { useEffect, useSyncExternalStore } from "react";
import { confirmedEntries, type GlossaryEntry } from "./abbreviations";
import { lexiconApi } from "./lexicon-api";
import { useSession } from "./session";
import { accountId, type Account } from "./server";

// The server's shared abbreviations, for marking them in messages. Every message row asks, so the list is
// fetched once per account and kept for a few minutes. Agent's guesses are left out: nobody has checked them.
const FRESH_MS = 5 * 60 * 1000;
const EMPTY: GlossaryEntry[] = [];
type Cached = { entries: GlossaryEntry[]; at: number; pending: boolean };
const cache = new Map<string, Cached>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const keyOf = (account: Account | null) => account ? accountId(account) : "";

function load(account: Account, key: string) {
  const current = cache.get(key);
  if (current && (current.pending || Date.now() - current.at < FRESH_MS)) return;
  cache.set(key, { entries: current?.entries ?? EMPTY, at: current?.at ?? 0, pending: true });
  void lexiconApi.list(account)
    .then(result => cache.set(key, { entries: confirmedEntries(result.entries), at: Date.now(), pending: false }))
    // A failed lookup only means nothing is marked; try again on a later render.
    .catch(() => cache.set(key, { entries: current?.entries ?? EMPTY, at: Date.now() - FRESH_MS + 30000, pending: false }))
    .finally(() => listeners.forEach(listener => listener()));
}

/** Known abbreviations to underline in messages; empty until loaded or when signed out. */
export function useAbbreviations(): GlossaryEntry[] {
  const { account } = useSession();
  const key = keyOf(account);
  useEffect(() => { if (account) load(account, key); }, [account, key]);
  return useSyncExternalStore(subscribe, () => cache.get(key)?.entries ?? EMPTY, () => EMPTY);
}
