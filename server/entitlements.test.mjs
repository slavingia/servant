// Entitlements: people ask and confirm, their manager decides, access is handed down from an owner, nothing is deleted.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { capabilitySettings, createEntitlements, DEFAULT_CONFIRMATION, NATIVE, ONCE_WINDOW_MS } from "./entitlements.mjs";

// Ana (owner) manages Jo; Jo manages Pat and Sam.
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-entitlements-"));
  const file = path.join(dir, "entitlements.db");
  const people = new Map([["usr_ana", "owner"], ["usr_jo", "member"], ["usr_pat", "member"], ["usr_sam", "member"]]);
  const managerOf = { usr_jo: "usr_ana", usr_pat: "usr_jo", usr_sam: "usr_jo" };
  const time = { now: 1_800_000_000_000 };
  const store = createEntitlements(file, { clock: () => time.now, known: id => people.has(id), isOwner: id => people.get(id) === "owner", manages: (by, id) => managerOf[id] === by });
  return { store, people, file, time, done: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const fails = (fn, status, code) => assert.throws(fn, error => error.status === status && (!code || error.code === code), `expected ${status} ${code || ""}`);

test("a person asks with a confirmation, their manager grants, and the hosts open only then", () => {
  const { store, done } = setup();
  const github = store.create({ name: "GitHub", description: "The team's repositories", hosts: ["GitHub.com", "*.github.com", "github.com"] }, "usr_ana");
  assert.deepEqual(github.hosts, ["github.com", "*.github.com"]);
  assert.equal(github.confirmation, DEFAULT_CONFIRMATION);
  assert.equal(store.allows("usr_pat", "api.github.com"), false);

  fails(() => store.request(github.id, "usr_pat", {}), 400, "confirmation_required");
  fails(() => store.request(github.id, "usr_pat", { confirmed: "yes" }), 400, "confirmation_required");
  const asked = store.request(github.id, "usr_pat", { confirmed: true, note: "I'm on the example-app team" });
  assert.equal(asked.fresh, true);
  assert.equal(asked.grant.status, "requested");
  assert.equal(store.request(github.id, "usr_pat", { confirmed: true }).fresh, false, "asking again while waiting tells nobody twice");
  assert.equal(store.allows("usr_pat", "api.github.com"), false, "asking opens nothing");
  assert.deepEqual(store.waitingOn("usr_jo").map(g => g.userId), ["usr_pat"]);
  assert.deepEqual(store.waitingOn("usr_ana").map(g => g.userId), ["usr_pat"], "an owner can decide for anyone");
  assert.deepEqual(store.waitingOn("usr_sam"), []);
  assert.deepEqual(store.waitingOn("usr_pat"), [], "their own request is not theirs to answer");

  fails(() => store.decide(github.id, "usr_pat", { decision: "grant", by: "usr_sam" }), 403, "forbidden");
  fails(() => store.decide(github.id, "usr_pat", { decision: "grant", by: "usr_pat" }), 403, "forbidden");
  // Jo is Pat's manager but doesn't hold GitHub, so Jo can't hand it on yet.
  fails(() => store.decide(github.id, "usr_pat", { decision: "grant", by: "usr_jo" }), 403, "not_held");
  store.request(github.id, "usr_jo", { confirmed: true });
  fails(() => store.decide(github.id, "usr_jo", { decision: "grant", by: "usr_jo" }), 403, "forbidden");
  store.decide(github.id, "usr_jo", { decision: "grant", by: "usr_ana" });
  store.decide(github.id, "usr_pat", { decision: "grant", by: "usr_jo" });
  assert.equal(store.allows("usr_pat", "api.github.com"), true);
  assert.equal(store.allows("usr_pat", "github.com"), true);
  assert.equal(store.allows("usr_pat", "notgithub.com"), false);
  assert.equal(store.allows("usr_sam", "github.com"), false, "one person's grant is nobody else's");
  fails(() => store.request(github.id, "usr_pat", { confirmed: true }), 409, "already_granted");
  fails(() => store.decide(github.id, "usr_pat", { decision: "grant", by: "usr_jo" }), 409);

  store.decide(github.id, "usr_pat", { decision: "revoke", by: "usr_ana", reason: "Moved teams" });
  assert.equal(store.allows("usr_pat", "github.com"), false);
  assert.equal(store.grant(github.id, "usr_pat").status, "revoked");
  assert.equal(store.request(github.id, "usr_pat", { confirmed: true }).fresh, true, "after a revocation it is a new request");
  store.decide(github.id, "usr_pat", { decision: "deny", by: "usr_jo", reason: "Not on the team" });
  assert.equal(store.grant(github.id, "usr_pat").reason, "Not on the team");
  assert.deepEqual(store.history(github.id).filter(h => h.userId === "usr_pat").map(h => h.action).reverse(), ["requested", "granted", "revoked", "requested", "denied"]);
  assert.equal(store.history(github.id).find(h => h.action === "requested").detail.confirmation, DEFAULT_CONFIRMATION, "the words agreed to are kept");
  done();
});

test("nobody is given an entitlement they did not ask for; an owner can decide their own; a manager can decline or take back without holding it", () => {
  const { store, done } = setup();
  const e = store.create({ name: "Tax data API", hosts: ["api.example.gov"], confirmation: "I hold the Tax data role myself." }, "usr_ana");
  fails(() => store.decide(e.id, "usr_jo", { decision: "grant", by: "usr_ana" }), 404);
  store.request(e.id, "usr_ana", { confirmed: true });
  store.decide(e.id, "usr_ana", { decision: "grant", by: "usr_ana" });
  assert.equal(store.allows("usr_ana", "api.example.gov"), true);
  assert.equal(store.history(e.id).find(h => h.action === "requested").detail.confirmation, "I hold the Tax data role myself.");
  store.request(e.id, "usr_sam", { confirmed: true });
  store.decide(e.id, "usr_sam", { decision: "deny", by: "usr_jo" });
  store.request(e.id, "usr_sam", { confirmed: true });
  store.decide(e.id, "usr_sam", { decision: "grant", by: "usr_ana" });
  store.decide(e.id, "usr_sam", { decision: "revoke", by: "usr_jo" });
  assert.equal(store.allows("usr_sam", "api.example.gov"), false);
  fails(() => store.decide(e.id, "usr_sam", { decision: "maybe", by: "usr_ana" }), 400);
  done();
});

test("editing, retiring and a person leaving close access without deleting anything", () => {
  const { store, people, file, done } = setup();
  const e = store.create({ name: "Jira", hosts: ["jira.example.gov"] }, "usr_ana");
  fails(() => store.create({ name: "jira", hosts: [] }, "usr_ana"), 409, "name_taken");
  fails(() => store.create({ name: "Bad", hosts: ["https://example.gov/path"] }, "usr_ana"), 400);
  fails(() => store.create({ name: " ", hosts: [] }, "usr_ana"), 400);
  for (const id of ["usr_pat", "usr_sam"]) store.request(e.id, id, { confirmed: true });
  store.decide(e.id, "usr_pat", { decision: "grant", by: "usr_ana" });
  assert.deepEqual(store.held("usr_pat").map(h => h.name), ["Jira"]);
  assert.deepEqual(store.covering("jira.example.gov").map(c => c.name), ["Jira"]);

  store.update(e.id, { hosts: ["tracker.example.gov"] }, "usr_ana");
  assert.equal(store.allows("usr_pat", "jira.example.gov"), false, "a host taken off the entitlement closes at once");
  assert.equal(store.allows("usr_pat", "tracker.example.gov"), true);

  people.delete("usr_pat"); store.forget("usr_pat", "server");
  assert.equal(store.grant(e.id, "usr_pat").status, "revoked");
  assert.equal(store.allows("usr_pat", "tracker.example.gov"), false);

  store.retire(e.id, "usr_ana");
  assert.equal(store.get(e.id), null);
  assert.deepEqual(store.list().filter(x => !x.native), []);
  assert.deepEqual(store.waitingOn("usr_ana"), [], "a retired entitlement has nothing left to decide");
  fails(() => store.request(e.id, "usr_sam", { confirmed: true }), 404);
  assert.ok(store.history(e.id).some(h => h.action === "retired"));
  assert.equal(store.grants(e.id).length, 2, "the record of who asked and held it stays");

  const raw = new DatabaseSync(file);
  assert.throws(() => raw.exec("DELETE FROM history"), /append-only/);
  assert.throws(() => raw.exec("UPDATE history SET action='x'"), /append-only/);
  raw.close();
  done();
});

test("built-in entitlements are on every server, can't be retired or renamed, and are asked for by use", () => {
  const { store, file, done } = setup();
  assert.deepEqual(store.list().map(e => [e.name, e.capability]), [["Filesystem read", "fs-read"], ["Filesystem write", "fs-write"], ["GitHub read", "github-read"], ["GitHub write", "github-write"]]);
  assert.deepEqual(NATIVE.map(n => n.capability).sort(), ["fs-read", "fs-write", "github-read", "github-write"]);
  const github = store.get("native-github-write");
  assert.deepEqual(github.hosts, ["github.com", "*.github.com", "*.githubusercontent.com"]);
  fails(() => store.retire(github.id, "usr_ana"), 400);
  fails(() => store.update(github.id, { name: "Git" }, "usr_ana"), 400);
  assert.deepEqual(store.update(github.id, { hosts: ["github.com"], name: "GitHub write" }, "usr_ana").hosts, ["github.com"], "an owner can still say which hosts it opens");
  store.create({ name: "Jira", hosts: ["jira.example.gov"] }, "usr_ana");
  assert.deepEqual(store.list().map(e => e.name), ["Filesystem read", "Filesystem write", "GitHub read", "GitHub write", "Jira"], "built-in ones first");
  fails(() => store.use("usr_pat", "sudo"), 400);

  // The first use files a request with what the agent was about to do; repeats change nothing but that line.
  const first = store.use("usr_pat", "github-write", "Run: git push origin main");
  assert.deepEqual([first.verdict, first.fresh, first.entitlement.name], ["wait", true, "GitHub write"]);
  const again = store.use("usr_pat", "github-write", "Run: gh pr merge 12");
  assert.deepEqual([again.verdict, again.fresh], ["wait", false]);
  const request = store.grant(github.id, "usr_pat");
  assert.deepEqual([request.status, request.via, request.detail], ["requested", "use", "Run: gh pr merge 12"]);
  assert.deepEqual(store.waitingOn("usr_jo").map(g => [g.userId, g.detail]), [["usr_pat", "Run: gh pr merge 12"]]);
  assert.equal(store.use("usr_gone", "fs-read").verdict, "deny", "someone who isn't on the server is refused");
  // Reopening the file adds no second copy and keeps the request.
  const reopened = createEntitlements(file);
  assert.equal(reopened.list().filter(e => e.native).length, 4);
  assert.equal(reopened.grant(github.id, "usr_pat").status, "requested");
  reopened.close();
  done();
});

test("allow once lets one action through and the next asks again; allow always stands; a no stands until the person asks", () => {
  const { store, time, done } = setup();
  const id = "native-github-write";
  // Jo is Pat's manager but holds nothing, so Jo can't allow it, once or always. The owner can.
  store.use("usr_pat", "github-write", "Run: git push");
  fails(() => store.decide(id, "usr_pat", { decision: "once", by: "usr_jo" }), 403, "not_held");
  fails(() => store.decide(id, "usr_pat", { decision: "grant", by: "usr_jo" }), 403, "not_held");
  store.decide(id, "usr_pat", { decision: "once", by: "usr_ana" });
  assert.equal(store.grant(id, "usr_pat").status, "once");
  assert.equal(store.allows("usr_pat", "github.com"), false, "nothing opens until it is used");
  const used = store.use("usr_pat", "github-write", "Run: git push");
  assert.deepEqual([used.verdict, used.once], ["allow", true]);
  assert.equal(store.grant(id, "usr_pat").status, "used");
  assert.equal(store.allows("usr_pat", "api.github.com"), true, "its hosts stay open long enough for that action");
  time.now += ONCE_WINDOW_MS + 1;
  assert.equal(store.allows("usr_pat", "api.github.com"), false);
  const next = store.use("usr_pat", "github-write", "Run: gh pr merge 3");
  assert.deepEqual([next.verdict, next.fresh], ["wait", true], "the next action asks again");

  // Always: every later use goes through, and write covers read.
  store.decide(id, "usr_pat", { decision: "grant", by: "usr_ana" });
  for (let i = 0; i < 3; i++) assert.equal(store.use("usr_pat", "github-write").verdict, "allow");
  assert.equal(store.use("usr_pat", "github-read").verdict, "allow", "write covers read");
  assert.equal(store.grant("native-github-read", "usr_pat"), null, "without a separate request for read");
  assert.equal(store.use("usr_pat", "fs-read").verdict, "wait", "but GitHub says nothing about files");
  // Pat holds GitHub write, so Pat can now pass on GitHub read (covered) to a report... Sam reports to Jo, so only an owner or Jo decides.
  store.use("usr_sam", "github-read");
  fails(() => store.decide("native-github-read", "usr_sam", { decision: "grant", by: "usr_pat" }), 403, "forbidden");

  // A no stands: later uses are refused without asking the manager again, until the person asks themselves.
  store.decide("native-fs-read", "usr_pat", { decision: "deny", by: "usr_ana", reason: "Not on this server" });
  assert.equal(store.use("usr_pat", "fs-read").verdict, "deny");
  assert.equal(store.use("usr_pat", "fs-read").verdict, "deny");
  assert.equal(store.request("native-fs-read", "usr_pat", { confirmed: true }).fresh, true);
  assert.equal(store.use("usr_pat", "fs-read").verdict, "wait");
  // Taking it back closes it and the next use asks again.
  store.decide(id, "usr_pat", { decision: "revoke", by: "usr_ana" });
  assert.equal(store.use("usr_pat", "github-write").verdict, "wait");
  fails(() => store.decide(store.create({ name: "Jira", hosts: [] }, "usr_ana").id, "usr_pat", { decision: "once", by: "usr_ana" }), 404);
  assert.deepEqual(store.history(id).filter(h => h.userId === "usr_pat").map(h => h.action).reverse(), ["requested", "once", "used", "requested", "granted", "revoked", "requested"]);
  assert.deepEqual(capabilitySettings(undefined), { mode: "off", waitSeconds: 120 });
  assert.deepEqual(capabilitySettings({ mode: "ask", waitSeconds: 5000 }), { mode: "ask", waitSeconds: 900 });
  assert.deepEqual(capabilitySettings({ mode: "ask", waitSeconds: 0 }), { mode: "ask", waitSeconds: 0 });
  done();
});
