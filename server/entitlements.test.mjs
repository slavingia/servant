// Entitlements: people ask and confirm, their manager decides, access is handed down from an owner, nothing is deleted.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { capabilitySettings, createEntitlements, DEFAULT_CONFIRMATION, grantDaysSetting, NATIVE, ONCE_WINDOW_MS, SOCIAL_ENTITLEMENT } from "./entitlements.mjs";

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
  assert.deepEqual(store.list().map(e => [e.name, e.capability]), [["Filesystem read", "fs-read"], ["Filesystem write", "fs-write"], ["GitHub read", "github-read"], ["GitHub write", "github-write"], ["Social media", "social"]]);
  assert.deepEqual(NATIVE.map(n => n.capability).sort(), ["fs-read", "fs-write", "github-read", "github-write"]);
  const github = store.get("native-github-write");
  assert.deepEqual(github.hosts, ["github.com", "*.github.com", "*.githubusercontent.com"]);
  fails(() => store.retire(github.id, "usr_ana"), 400);
  fails(() => store.update(github.id, { name: "Git" }, "usr_ana"), 400);
  assert.deepEqual(store.update(github.id, { hosts: ["github.com"], name: "GitHub write" }, "usr_ana").hosts, ["github.com"], "an owner can still say which hosts it opens");
  store.create({ name: "Jira", hosts: ["jira.example.gov"] }, "usr_ana");
  assert.deepEqual(store.list().map(e => e.name), ["Filesystem read", "Filesystem write", "GitHub read", "GitHub write", "Social media", "Jira"], "built-in ones first");
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
  assert.equal(reopened.list().filter(e => e.native).length, 5, "the four asked for by use, and Social media");
  // Social media is built in but asked for by hand: it opens no hosts, the agent can't use it, and there is no "once".
  const socialMedia = reopened.get(SOCIAL_ENTITLEMENT.id);
  assert.deepEqual([socialMedia.name, socialMedia.native, socialMedia.byRequest, socialMedia.hosts], ["Social media", true, true, []]);
  fails(() => reopened.use("usr_pat", "social"), 400, "bad_request");
  fails(() => reopened.update(socialMedia.id, { name: "Posting" }, "usr_ana"), 400, "bad_request");
  fails(() => reopened.retire(socialMedia.id, "usr_ana"), 400, "bad_request");
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
  const looked = store.use("usr_pat", "github-write", "Run: git push", { consume: false });
  assert.deepEqual([looked.verdict, looked.once, store.grant(id, "usr_pat").status], ["allow", true, "once"], "looking doesn't spend it");
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

test("the agent action log keeps every line, newest first, and can't be changed", () => {
  const { store, file, time, done } = setup();
  store.logAction({ userId: "usr_pat", chatId: "cht_1", needs: ["github-write", "fs-write"], verdict: "waiting", detail: "Run: git commit -am fix && git push" });
  time.now += 1000;
  store.logAction({ userId: "usr_pat", chatId: "cht_1", needs: ["github-write"], verdict: "allowed-once", detail: "Run: git push" });
  store.logAction({ userId: "usr_ana", needs: ["fs-read"], verdict: "allowed-owner", detail: "Read README.md  " + "x".repeat(400) });
  const all = store.actions();
  assert.deepEqual(all.map(a => [a.userId, a.verdict, a.needs.join("+")]), [["usr_ana", "allowed-owner", "fs-read"], ["usr_pat", "allowed-once", "github-write"], ["usr_pat", "waiting", "github-write+fs-write"]]);
  assert.equal(all[0].detail.length, 300, "what it was about to do is kept short");
  assert.equal(all[2].chatId, "cht_1");
  assert.equal("chatId" in all[0], false);
  assert.deepEqual(store.actions({ userId: "usr_pat" }).map(a => a.detail), ["Run: git push", "Run: git commit -am fix && git push"]);
  assert.deepEqual(store.actions({ before: all[0].seq, limit: 1 }).map(a => a.detail), ["Run: git push"], "paged back from a line");
  const raw = new DatabaseSync(file);
  assert.throws(() => raw.exec("DELETE FROM actions"), /append-only/);
  assert.throws(() => raw.exec("UPDATE actions SET verdict='allowed'"), /append-only/);
  raw.close();
  done();
});

test("a standing grant runs out after the server's number of days, opens nothing from then on, and is asked for again", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-entitlements-expiry-"));
  const file = path.join(dir, "entitlements.db");
  const roles = new Map([["usr_ana", "owner"], ["usr_jo", "member"], ["usr_pat", "member"]]);
  const managerOf = { usr_jo: "usr_ana", usr_pat: "usr_jo" };
  const time = { now: 1_800_000_000_000 }, DAY = 86_400_000;
  let days = 30;
  const store = createEntitlements(file, { clock: () => time.now, known: id => roles.has(id), isOwner: id => roles.get(id) === "owner", manages: (by, id) => managerOf[id] === by, grantDays: () => days });
  try {
    const github = store.create({ name: "GitHub", hosts: ["github.com"] }, "usr_ana");
    for (const who of ["usr_jo", "usr_pat"]) store.request(github.id, who, { confirmed: true });
    store.decide(github.id, "usr_jo", { decision: "grant", by: "usr_ana" });
    time.now += 10 * DAY;
    store.decide(github.id, "usr_pat", { decision: "grant", by: "usr_jo" });
    // While it lasts, the grant says when it runs out.
    assert.equal(store.grant(github.id, "usr_jo").expiresAt, 1_800_000_000_000 + 30 * DAY);
    assert.equal(store.allows("usr_pat", "github.com"), true);

    // Day 30: Jo's has run out, Pat's (granted on day 10) has not. Jo's opens nothing and Jo can no longer pass it on.
    time.now = 1_800_000_000_000 + 30 * DAY;
    assert.deepEqual([store.grant(github.id, "usr_jo").status, store.grant(github.id, "usr_pat").status], ["expired", "granted"]);
    assert.deepEqual([store.allows("usr_jo", "github.com"), store.holds(github.id, "usr_jo"), store.allows("usr_pat", "github.com")], [false, false, true]);
    assert.equal(store.grant(github.id, "usr_jo").expiresAt, undefined);
    assert.deepEqual(store.held("usr_jo").map(e => e.name), []);
    roles.set("usr_sam", "member"); managerOf.usr_sam = "usr_jo";
    store.request(github.id, "usr_sam", { confirmed: true });
    fails(() => store.decide(github.id, "usr_sam", { decision: "grant", by: "usr_jo" }), 403, "not_held");
    // It is on the record, once, by the server, and nothing was deleted.
    const expired = store.history(github.id).filter(h => h.action === "expired");
    assert.deepEqual(expired.map(h => [h.userId, h.by, h.detail.days]), [["usr_jo", "server", 30]]);
    store.list(); store.list();
    assert.equal(store.history(github.id).filter(h => h.action === "expired").length, 1, "marked once, however often it is read");

    // Asking again is a new request, decided again, with a new lifetime from that day.
    fails(() => store.decide(github.id, "usr_jo", { decision: "revoke", by: "usr_ana" }), 409, "conflict");
    assert.equal(store.request(github.id, "usr_jo", { confirmed: true }).fresh, true);
    store.decide(github.id, "usr_jo", { decision: "grant", by: "usr_ana" });
    assert.deepEqual([store.grant(github.id, "usr_jo").status, store.grant(github.id, "usr_jo").expiresAt, store.allows("usr_jo", "github.com")], ["granted", time.now + 30 * DAY, true]);

    // A built-in entitlement runs out the same way: the agent's next use waits for the manager again.
    const read = NATIVE.find(n => n.capability === "fs-read");
    assert.equal(store.use("usr_pat", read.capability, "read a file").verdict, "wait");
    store.decide(read.id, "usr_pat", { decision: "grant", by: "usr_ana" });
    assert.equal(store.use("usr_pat", read.capability, "read a file").verdict, "allow");
    time.now += 31 * DAY;
    assert.deepEqual([store.use("usr_pat", read.capability, "read a file again").verdict, store.grant(read.id, "usr_pat").status], ["wait", "requested"]);

    // Without a lifetime (the default) nothing runs out, and a grant carries no end date.
    days = 0;
    store.decide(read.id, "usr_pat", { decision: "grant", by: "usr_ana" });
    time.now += 5000 * DAY;
    assert.deepEqual([store.grant(read.id, "usr_pat").status, store.grant(read.id, "usr_pat").expiresAt], ["granted", undefined]);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the lifetime setting takes whole days from 1 to 3650; anything else means grants don't run out", () => {
  assert.deepEqual([90, 1, 3650].map(grantDaysSetting), [90, 1, 3650]);
  assert.deepEqual([0, -1, 1.5, 3651, "30", null, undefined, true].map(grantDaysSetting), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test("built-in entitlements are held per project: allowed for one project says nothing about another", () => {
  const { store, done } = setup();
  const app = { id: "example-app", name: "Example app" }, site = { id: "prototypes", name: "Prototypes" };
  const ask = (who, capability, project, options = {}) => store.use(who, capability, "Run: a command", { project, ...options });
  const allow = (id, who, decision = "grant", by = "usr_ana") => store.decide(id, who, { decision, by });
  try {
    // The first use in a project's chat asks for the entitlement for that project, by name.
    const first = ask("usr_pat", "fs-write", app);
    assert.deepEqual([first.verdict, first.fresh, first.entitlement.id, first.entitlement.name], ["wait", true, "native-fs-write@example-app", "Filesystem write · Example app"]);
    assert.deepEqual([first.entitlement.native, first.entitlement.capability, first.entitlement.projectId], [true, "fs-write", "example-app"]);
    assert.equal(ask("usr_pat", "fs-write", app).fresh, false, "asked once");
    allow(first.entitlement.id, "usr_pat");
    assert.equal(ask("usr_pat", "fs-write", app).verdict, "allow");
    // Write covers read, in the same project only.
    assert.equal(ask("usr_pat", "fs-read", app).verdict, "allow");
    for (const [capability, project, why] of [["fs-write", site, "another project"], ["fs-read", site, "reading another project"], ["fs-write", null, "a chat outside any project"], ["github-write", app, "another entitlement in the same project"]]) {
      assert.equal(ask("usr_pat", capability, project).verdict, "wait", why);
    }
    assert.deepEqual(store.held("usr_pat").map(e => e.name), ["Filesystem write · Example app"]);

    // Held for every project (no project named), it counts in each one.
    allow("native-fs-write", "usr_pat");
    for (const project of [site, { id: "new-one", name: "New one" }, null]) assert.equal(ask("usr_pat", "fs-write", project).verdict, "allow");
    assert.equal(ask("usr_pat", "fs-read", site).verdict, "allow", "and its write still covers read");

    // Allow once is for the project it was asked in, and is used up there.
    assert.equal(ask("usr_sam", "github-write", app).verdict, "wait");
    allow("native-github-write@example-app", "usr_sam", "once");
    assert.equal(ask("usr_sam", "github-write", site).verdict, "wait", "not usable in another project");
    assert.deepEqual([ask("usr_sam", "github-write", app, { consume: false }).once, ask("usr_sam", "github-write", app).verdict, ask("usr_sam", "github-write", app).verdict], [true, "allow", "wait"]);

    // The GitHub pair opens GitHub's hosts for someone who holds it for a project. The gate goes by host, not repository.
    assert.equal(store.allows("usr_jo", "api.github.com"), false);
    ask("usr_jo", "github-read", app);
    allow("native-github-read@example-app", "usr_jo");
    assert.equal(store.allows("usr_jo", "api.github.com"), true);

    // Access is handed down per project too: Jo holds GitHub read for Example app, so Jo can grant that and nothing wider.
    ask("usr_pat", "github-read", app); ask("usr_pat", "github-read", site);
    allow("native-github-read@example-app", "usr_pat", "grant", "usr_jo");
    fails(() => allow("native-github-read@prototypes", "usr_pat", "grant", "usr_jo"), 403, "not_held");
    // Taking it back closes that project only.
    allow("native-fs-write@example-app", "usr_pat", "revoke");
    assert.equal(store.grant("native-fs-write", "usr_pat").status, "granted");

    // A refusal for one project stands for that project and no other.
    ask("usr_sam", "fs-write", app); ask("usr_sam", "fs-write", site);
    allow("native-fs-write@example-app", "usr_sam", "deny");
    assert.deepEqual([ask("usr_sam", "fs-write", app).verdict, ask("usr_sam", "fs-write", site).verdict], ["deny", "wait"]);

    // Like the built-in ones they stand for, they keep their name and can't be retired; a made-up project id is refused.
    fails(() => store.retire("native-fs-write@example-app", "usr_ana"), 400);
    fails(() => ask("usr_pat", "fs-read", { id: "../etc", name: "x" }), 400);
    assert.deepEqual(store.list().filter(e => e.projectId).map(e => e.name).sort(), ["Filesystem read · Prototypes", "Filesystem write · Example app", "Filesystem write · Prototypes", "GitHub read · Example app", "GitHub read · Prototypes", "GitHub write · Example app", "GitHub write · Prototypes"].sort(),
      "one for each project something was asked for in; none made for a use that something wider already covered (New one, reading Example app)");
  } finally { done(); }
});
