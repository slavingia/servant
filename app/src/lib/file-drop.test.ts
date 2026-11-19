import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dropFile, dropStatus, FILE_DROP_ROUTE } from "./file-drop.ts";
import { DESTINATIONS, destinationGroups, reachable } from "./destinations.ts";
import { omnibarShortcuts } from "./omnibar.ts";
import { reconcileAccountProfile } from "./session-profile.ts";
import { ALL_FEATURES } from "./features.ts";
import type { Account } from "./accounts-store.ts";

const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const read = async (offset: number, length: number) => bytes.slice(offset, offset + length);

test("a dropped file goes up in chunks to the file drop route and reports the name it was saved under", async () => {
  const calls: { path: string; body: any }[] = [];
  const progress: number[] = [];
  const saved = await dropFile({ name: "plan.pdf", size: bytes.length, read, onProgress: f => progress.push(f), post: async (path, body: any) => {
    calls.push({ path, body });
    if (path === FILE_DROP_ROUTE) return { id: "upl_1", chunkBytes: 4, received: 0 };
    const received = body.offset + 4 > bytes.length ? bytes.length : body.offset + 4;
    return received === bytes.length ? { received, saved: "plan 2.pdf" } : { received };
  } });
  assert.equal(saved, "plan 2.pdf");
  assert.deepEqual(calls.map(c => c.path), ["/v1/file-drop", "/v1/file-drop/upl_1", "/v1/file-drop/upl_1", "/v1/file-drop/upl_1"]);
  assert.deepEqual(calls[0]!.body, { name: "plan.pdf", size: 10 });
  assert.equal(progress.at(-1), 1);
});

test("a server that never says the file was saved is a failure, not a quiet success", async () => {
  await assert.rejects(dropFile({ name: "a.txt", size: 2, read, post: async path => path === FILE_DROP_ROUTE ? { id: "u", chunkBytes: 4, received: 0 } : { received: 2 } }), /didn't confirm it saved/);
});

test("status lines: waiting, sending, saved, saved under another name, failed", () => {
  const base = { name: "plan.pdf", progress: 0 };
  assert.equal(dropStatus({ ...base, state: "waiting" }), "Waiting");
  assert.equal(dropStatus({ ...base, state: "sending", progress: 0.456 }), "Sending 45%");
  assert.equal(dropStatus({ ...base, state: "saved", saved: "plan.pdf" }), "Saved");
  assert.equal(dropStatus({ ...base, state: "saved", saved: "plan 2.pdf" }), "Saved as plan 2.pdf");
  assert.equal(dropStatus({ ...base, state: "failed", error: "Choose documents under 100 MB each" }), "Choose documents under 100 MB each");
});

test("File drop is a place only for an owner whose server offers it", () => {
  const place = DESTINATIONS.find(item => item.id === "fileDrop")!;
  assert.equal(reachable(place, { features: ALL_FEATURES, owner: true, fileDrop: true }), true);
  assert.equal(reachable(place, { features: ALL_FEATURES, owner: true }), false, "an owner of a server without the folder");
  assert.equal(reachable(place, { features: ALL_FEATURES, owner: false, fileDrop: true }), false, "never a member");
  const labels = (fileDrop: boolean) => destinationGroups("sidebar", { features: ALL_FEATURES, owner: true, fileDrop }).flatMap(group => group.places.map(p => p.label));
  assert.ok(labels(true).includes("File drop"));
  assert.ok(!labels(false).includes("File drop"));
  assert.ok(omnibarShortcuts("file drop", true, ALL_FEATURES, true).some(item => item.path === "/file-drop"));
  assert.ok(!omnibarShortcuts("file drop", true, ALL_FEATURES).some(item => item.path === "/file-drop"));
  assert.ok(!omnibarShortcuts("file drop", false, ALL_FEATURES, true).some(item => item.path === "/file-drop"));
});

test("the account learns file drop from the server and forgets it when the server stops saying so", () => {
  const account: Account = { token: "t", serverUrl: "https://example.gov", serverName: "Example server", user: { id: "u1", name: "Pat Tester", role: "owner" } };
  const on = reconcileAccountProfile(account, { user: { id: "u1" }, fileDrop: true });
  assert.equal(on.fileDrop, true);
  assert.equal(reconcileAccountProfile(on, { user: { id: "u1" } }).fileDrop, false);
});

test("the screen is registered and takes files by drop and by choosing", () => {
  const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  assert.match(source("app/_layout.tsx"), /name="file-drop" options=\{\{ title: "File drop"/);
  const screen = source("app/file-drop.tsx");
  assert.match(screen, /"drop"/);
  assert.match(screen, /label="Choose files"/);
});
