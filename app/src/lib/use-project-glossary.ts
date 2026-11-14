import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Account } from "./server";
import { mergeGlossaryEntries, type GlossaryEntry } from "./abbreviations";
import { glossaryApi } from "./glossary-api";
import { lexiconApi } from "./lexicon-api";

const EMPTY: GlossaryEntry[] = [];
type Result = { key: string; entries: GlossaryEntry[]; globalEntries: GlossaryEntry[]; projectEntries: GlossaryEntry[]; error: string };
type Lookup = { key: string; active: boolean; controller: AbortController | null; pending: Promise<Result> | null; result: Result | null };

export function useProjectGlossary(account: Account | null, projectId?: string | null) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const lookup = useRef<Lookup | null>(null);
  const key = JSON.stringify([account?.serverUrl, account?.serverKey, account?.user.id, account?.token, projectId, revision]);
  const refresh = useCallback(() => setRevision(current => current + 1), []);

  // Invalidate the previous scope before callbacks in the new render can run.
  // A request may finish after abort; its result must still be refused.
  useLayoutEffect(() => {
    const scope: Lookup = { key, active: true, controller: null, pending: null, result: null };
    lookup.current = scope;
    return () => {
      scope.active = false;
      scope.controller?.abort();
      if (lookup.current === scope) lookup.current = null;
    };
  }, [key]);

  const getEntries = useCallback(async (fresh = false): Promise<GlossaryEntry[]> => {
    const scope = lookup.current;
    const valid = () => !!scope && scope.active && scope.key === key && lookup.current === scope;
    if (!valid() || !scope) throw new Error("Abbreviation lookup cancelled");
    if (!account) return EMPTY;
    if (scope.pending) {
      const value = await scope.pending;
      if (!valid()) throw new Error("Abbreviation lookup cancelled");
      return value.entries;
    }
    if (!fresh && scope.result && !scope.result.error) return scope.result.entries;

    const controller = new AbortController();
    scope.controller = controller;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 10000);
    const pending: Promise<Result> = Promise.all([
      lexiconApi.list(account, controller.signal),
      projectId ? glossaryApi.list(account, projectId, controller.signal) : Promise.resolve(null),
    ]).then(([global, project]) => {
      if (!valid() || controller.signal.aborted) throw new Error("Abbreviation lookup cancelled");
      const projectEntries = project?.entries ?? EMPTY;
      const next = { key, entries: mergeGlossaryEntries(global.entries, projectEntries), globalEntries: global.entries, projectEntries, error: "" };
      scope.result = next;
      setResult(next);
      return next;
    }).catch(reason => {
      controller.abort();
      if (!valid()) throw new Error("Abbreviation lookup cancelled");
      const error = timedOut ? "Abbreviation lookup timed out. Try again."
        : reason instanceof Error && reason.message ? reason.message : "Couldn't load abbreviations. Try again.";
      scope.result = { key, entries: [], globalEntries: [], projectEntries: [], error };
      setResult(scope.result);
      throw new Error(error);
    }).finally(() => {
      clearTimeout(timeout);
      if (scope.pending === pending) scope.pending = null;
      if (scope.controller === controller) scope.controller = null;
    });
    scope.pending = pending;
    const value = await pending;
    if (!valid()) throw new Error("Abbreviation lookup cancelled");
    return value.entries;
  }, [account, projectId, key]);

  const rememberEntry = useCallback((entry: GlossaryEntry) => {
    const scope = lookup.current;
    if (!scope?.active || scope.key !== key || !scope.result || scope.result.error) return;
    const globalEntries = [...scope.result.globalEntries.filter(value => value.id !== entry.id), entry];
    const next = { ...scope.result, globalEntries, entries: mergeGlossaryEntries(globalEntries, scope.result.projectEntries) };
    scope.result = next; setResult(next);
  }, [key]);

  // The list is read when it is first needed (a message is sent), not every time a composer appears: opening a
  // conversation, a thread or a chat used to ask for it each time, for nothing unless something was then sent.
  const current = account && result?.key === key ? result : null;
  return { entries: current?.entries ?? EMPTY, error: current?.error ?? "", refresh, getEntries, rememberEntry };
}
