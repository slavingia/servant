// Entitlements: people ask and confirm, their manager decides, access is handed down from an owner, nothing is deleted.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createEntitlements, DEFAULT_CONFIRMATION } from "./entitlements.mjs";

// Ana (owner) manages Jo; Jo manages Pat and Sam.
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-entitlements-"));
  const file = path.join(dir, "entitlements.db");
  const people = new Map([["usr_ana", "owner"], ["usr_jo", "member"], ["usr_pat", "member"], ["usr_sam", "member"]]);
  const managerOf = { usr_jo: "usr_ana", usr_pat: "usr_jo", usr_sam: "usr_jo" };
  const store = createEntitlements(file, { known: id => people.has(id), isOwner: id => people.get(id) === "owner", manages: (by, id) => managerOf[id] === by });
  return { store, people, file, done: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
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
  assert.deepEqual(store.list(), []);
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
