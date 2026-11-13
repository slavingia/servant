import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { RawSharePayload } from "./share-payload.ts";

const require = createRequire(import.meta.url);
const ts = require("typescript");

// Run the actual gate and native adapter with controlled hooks and a native payload store.
// Advancing a timer represents the grace period after the OS foreground/deep-link events.
function gateHarness() {
  const pending: RawSharePayload[] = [{ shareType: "url", value: "https://www.example.gov/refunds" }];
  let clears = 0;
  const pushes: string[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const listeners = new Set<(state: string) => void>();
  const effects: { deps: unknown[]; cleanup?: () => void }[] = [];
  const refs: { current: unknown }[] = [];
  const scheduled: (() => void)[] = [];
  let cursor = 0;
  const state = { pathname: "/channels", expired: false, ready: true };
  const native = {
    getSharedPayloads: () => pending,
    clearSharedPayloads: () => { clears++; pending.splice(0); },
  };
  const modules: Record<string, unknown> = {
    react: {
      useRef: (value: unknown) => { const index = cursor++; return refs[index] ?? (refs[index] = { current: value }); },
      useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
        const index = cursor++;
        const before = effects[index];
        if (before && deps.length === before.deps.length && deps.every((dep, i) => Object.is(dep, before.deps[i]))) return;
        scheduled.push(() => {
          before?.cleanup?.();
          effects[index] = { deps, cleanup: effect() || undefined };
        });
      },
    },
    "react-native": { Platform: { OS: "ios" }, AppState: { addEventListener: (_: string, listener: (state: string) => void) => { listeners.add(listener); return { remove: () => listeners.delete(listener) }; } } },
    "expo-router": { router: { push: (path: string) => pushes.push(path) }, usePathname: () => state.pathname, useRootNavigationState: () => state.ready ? { key: "ready" } : null },
    "expo-sharing": native,
    "../lib/session-expiry": { useSessionExpiry: () => ({ expired: state.expired }) },
  };
  const load = (relative: string) => {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8");
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: Record<string, any> = {};
    runInNewContext(output, {
      exports,
      require: (id: string) => { assert.ok(id in modules, `known test dependency: ${id}`); return modules[id]; },
      setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; },
      clearTimeout: (id: number) => timers.delete(id),
    });
    return exports;
  };
  modules["../lib/incoming-share"] = load("./incoming-share.ts");
  const { ShareGate } = load("../components/ShareGate.tsx");
  return {
    state, pending, pushes,
    clears: () => clears,
    render: () => { cursor = 0; ShareGate(); scheduled.splice(0).forEach(effect => effect()); },
    foreground: () => listeners.forEach(listener => listener("active")),
    advance: () => { const due = [...timers.values()]; timers.clear(); due.forEach(fn => fn()); },
    unmount: () => { effects.forEach(effect => effect.cleanup?.()); effects.splice(0); refs.splice(0); },
  };
}

test("pending shares wait for the navigator and are not consumed by navigation", () => {
  const h = gateHarness();
  h.state.ready = false; h.render(); h.advance();
  assert.deepEqual(h.pushes, []);
  h.state.ready = true; h.render(); h.advance();
  assert.deepEqual(h.pushes, ["/share"]);
  h.foreground(); h.advance();
  assert.deepEqual(h.pushes, ["/share"], "foreground events cannot route the same share twice");
  assert.equal(h.pending.length, 1);
  assert.equal(h.clears(), 0);
});

test("a deep link arriving during the foreground grace period opens only one share screen", () => {
  const h = gateHarness();
  h.render();
  h.state.pathname = "/share"; h.render(); h.advance();
  assert.deepEqual(h.pushes, []);
});

test("an expired session keeps its verification screen until finished, then opens the pending share", () => {
  const h = gateHarness();
  h.state.expired = true; h.state.pathname = "/reverify";
  h.render(); h.foreground(); h.advance();
  assert.deepEqual(h.pushes, [], "do not cover verification and trigger a second verification screen");
  h.state.expired = false; h.render(); h.advance();
  assert.deepEqual(h.pushes, [], "wait for verification's return navigation too");
  h.state.pathname = "/channels"; h.render(); h.advance();
  assert.deepEqual(h.pushes, ["/share"], "no additional foreground event is needed after verification");
  assert.equal(h.pending.length, 1);
  assert.equal(h.clears(), 0);
});

test("session expiry during the foreground grace period cancels pending share navigation", () => {
  const h = gateHarness();
  h.render();
  h.state.expired = true; h.render(); h.advance();
  assert.deepEqual(h.pushes, []);
});

test("pairing again can reopen the share claimed before sign-out without clearing native data", () => {
  const h = gateHarness();
  h.render(); h.advance();
  assert.deepEqual(h.pushes, ["/share"]);
  // The signed-in gate unmounts on sign-out; it mounts again after pairing.
  h.unmount(); h.render(); h.advance();
  assert.deepEqual(h.pushes, ["/share", "/share"]);
  assert.equal(h.pending.length, 1);
  assert.equal(h.clears(), 0);
});
