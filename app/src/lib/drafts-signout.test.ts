// Unsent text belongs to the person who typed it: signing out must not leave it for the next person on the device.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const g = globalThis as any;
g.__store = new Map<string, string>();
g.__getDelay = 0;
// drafts.ts loads ./storage lazily (Keychain / localStorage on a device); give it an in-memory one.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./storage" && context.parentURL?.endsWith("/drafts.ts")) {
      const source = `
        export const getItem = async (k) => { const v = globalThis.__store.get(k) ?? null; if (globalThis.__getDelay) await new Promise(r => setTimeout(r, globalThis.__getDelay)); return v; };
        export const setItem = async (k, v) => { globalThis.__store.set(k, v); };
        export const removeItem = async (k) => { globalThis.__store.delete(k); };`;
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { getDraft, setDraft, loadDrafts, clearDrafts } = await import("./drafts.ts");
const saved = () => g.__store.get("servant.drafts");
const settle = (ms = 700) => new Promise(r => setTimeout(r, ms));

test("signing out clears drafts from memory and from the device copy", async () => {
  setDraft("chat:1", "A's private half-written message");
  await settle();
  assert.match(saved(), /private half-written/, "it was saved to the device");
  await clearDrafts();
  assert.equal(getDraft("chat:1"), "", "B does not see A's text");
  assert.equal(saved(), undefined, "and it is gone from the device copy");
});

test("a save that was still waiting does not write A's text back after sign-out", async () => {
  setDraft("chat:2", "typed a moment before signing out");
  await clearDrafts(); // before the 500 ms save fires
  await settle();
  assert.equal(saved(), undefined);
  assert.equal(getDraft("chat:2"), "");
});

test("a load that was still reading A's saved drafts does not bring them back", async () => {
  g.__store.set("servant.drafts", JSON.stringify({ "chat:3": "A's old saved draft" }));
  g.__getDelay = 80;
  const loading = loadDrafts();
  await clearDrafts();
  await loading;
  g.__getDelay = 0;
  assert.equal(getDraft("chat:3"), "", "the late load is discarded");
});

test("the next person's own drafts work normally after a sign-out", async () => {
  await clearDrafts();
  setDraft("chat:9", "B's draft");
  assert.equal(getDraft("chat:9"), "B's draft");
  await settle();
  assert.match(saved(), /B's draft/);
});
