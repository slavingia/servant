import { test } from "node:test";
import assert from "node:assert/strict";
import { askLabel, canAsk, holders, hostsLine, parseHosts, refusedLine, standingLine, waitingOnYou } from "./entitlements.ts";
import type { Entitlement, EntitlementStanding } from "./server.ts";

const standing = (status: EntitlementStanding["status"], extra: Partial<EntitlementStanding> = {}): EntitlementStanding => ({ entitlementId: "ent_1", userId: "usr_pat", status, note: "", requestedAt: 1, ...extra });
const entitlement = (id: string, people: EntitlementStanding[]): Entitlement => ({ id, name: id, description: "", hosts: [], confirmation: "", mine: null, people });

test("where you stand, in one line", () => {
  assert.equal(standingLine(null, "Jo Park"), "");
  assert.equal(standingLine(standing("granted"), "Jo Park"), "You have this");
  assert.equal(standingLine(standing("requested"), "Jo Park"), "Waiting for Jo Park");
  assert.equal(standingLine(standing("requested"), null), "Waiting for an owner");
  assert.equal(standingLine(standing("denied", { reason: "Not on the team" }), "Jo Park"), "Declined: Not on the team");
  assert.equal(standingLine(standing("denied"), "Jo Park"), "Declined");
  assert.equal(standingLine(standing("revoked"), "Jo Park"), "Taken back");
});

test("you can ask when you never did, or after a no", () => {
  assert.equal(canAsk(null), true);
  assert.equal(canAsk(standing("denied")), true);
  assert.equal(canAsk(standing("revoked")), true);
  assert.equal(canAsk(standing("requested")), false);
  assert.equal(canAsk(standing("granted")), false);
  assert.equal(askLabel(null), "Ask for this");
  assert.equal(askLabel(standing("denied")), "Ask again");
});

test("requests waiting on you come oldest first, across entitlements; holders are only those granted", () => {
  const list = [
    entitlement("GitHub", [standing("requested", { userId: "usr_sam", requestedAt: 30 }), standing("granted", { userId: "usr_pat" })]),
    entitlement("Jira", [standing("requested", { userId: "usr_pat", requestedAt: 10 }), standing("denied", { userId: "usr_sam" })]),
  ];
  assert.deepEqual(waitingOnYou(list).map(w => [w.entitlement.id, w.request.userId]), [["Jira", "usr_pat"], ["GitHub", "usr_sam"]]);
  assert.deepEqual(holders(list[0]).map(h => h.userId), ["usr_pat"]);
  assert.deepEqual(holders(list[1]), []);
});

test("hosts are read however they are typed", () => {
  assert.deepEqual(parseHosts("API.example.gov\n*.data.example.gov, https://github.com/example-org/x  api.example.gov. example.gov:443"), ["api.example.gov", "*.data.example.gov", "github.com", "example.gov"]);
  assert.deepEqual(parseHosts("  \n "), []);
  assert.equal(hostsLine([]), "Opens no hosts yet");
  assert.equal(hostsLine(["github.com", "*.github.com"]), "Opens github.com, *.github.com");
  assert.equal(refusedLine({ name: "Pat Tester", host: "api.example.gov", attempts: 1 }), "Pat Tester · api.example.gov · 1 try");
  assert.equal(refusedLine({ name: "Pat Tester", host: "api.example.gov", attempts: 3 }), "Pat Tester · api.example.gov · 3 tries");
});
