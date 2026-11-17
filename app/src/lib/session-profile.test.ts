import assert from "node:assert/strict";
import test from "node:test";
import type { Account } from "./accounts-store.ts";
import { ALL_FEATURES } from "./features.ts";
import { reconcileAccountProfile } from "./session-profile.ts";

const account: Account = {
  token: "test-token", serverKey: "test-key", serverUrl: "https://example.gov", serverName: "Team server",
  user: { id: "test-person", name: "Pat Tester", role: "member" },
  features: ALL_FEATURES, theme: { primaryColor: "#0071BC" },
};

test("profile refresh applies the server color and rename together without losing saved credentials", () => {
  const updated = reconcileAccountProfile(account, { user: account.user, server: { name: "Example team" }, theme: { primaryColor: "#a3c" } });
  assert.equal(updated.serverName, "Example team");
  assert.deepEqual(updated.theme, { primaryColor: "#AA33CC" });
  assert.equal(updated.token, account.token);
  assert.equal(updated.serverKey, account.serverKey);
  assert.equal(updated.serverUrl, account.serverUrl);
  assert.deepEqual(account.theme, { primaryColor: "#0071BC" });
});

test("removing or invalidating the server theme resets a previously saved custom color", () => {
  const custom = { ...account, theme: { primaryColor: "#AA33CC" } };
  for (const theme of [undefined, null, {}, { primaryColor: "red" }, { primaryColor: "#12345678" }]) {
    assert.deepEqual(reconcileAccountProfile(custom, { user: account.user, theme }).theme, account.theme);
  }
});

test("unchanged normalized profiles reuse the account while a color change updates it", () => {
  assert.equal(reconcileAccountProfile(account, { user: account.user }), account);
  assert.equal(reconcileAccountProfile(account, { user: account.user, theme: { primaryColor: "#0071bc" } }), account);
  assert.notEqual(reconcileAccountProfile(account, { user: account.user, theme: { primaryColor: "#663399" } }), account);
  assert.equal(reconcileAccountProfile(account, { theme: { primaryColor: "#663399" } }), account);
});

test("theme refresh preserves an in-flight Deep work choice and reconciles other server metadata", () => {
  const latest = { ...account, deepWork: true, banner: { message: "Old banner" } };
  const updated = reconcileAccountProfile(latest, {
    user: { id: account.user.id, name: "Jo Park" },
    features: { secureInbox: false }, theme: { primaryColor: "#663399" },
    banner: { message: " New banner " }, recordsKept: true, deepWork: false,
  }, true);
  assert.equal(updated.deepWork, true);
  assert.equal(updated.user.name, "Jo Park");
  assert.equal(updated.user.role, "member");
  assert.equal(updated.features?.secureInbox, false);
  assert.deepEqual(updated.banner, { message: "New banner" });
  assert.equal(updated.recordsKept, true);
  assert.equal(updated.theme?.primaryColor, "#663399");
});


test("theme reconciliation leaves unknown server fields out of saved account metadata", () => {
  const updated = reconcileAccountProfile(account, {
    user: account.user, theme: { primaryColor: "#663399" },
    surveyPermissions: { canView: true, canManage: true },
  });
  assert.equal(updated.theme?.primaryColor, "#663399");
  assert.equal("surveyPermissions" in updated, false);
});
