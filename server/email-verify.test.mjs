import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmailVerifier } from "./email-verify.mjs";

const settings = { domains: ["example.gov"] };
function setup() {
  let clock = 1_700_000_000_000;
  const sent = [];
  const verifier = createEmailVerifier({ now: () => clock, send: async (m) => { sent.push(m); } });
  return { verifier, sent, tick: (ms) => { clock += ms; } };
}
const wrong = (verifier, challenge, scope) => { try { verifier.check({ id: challenge.id, code: "000000", inviteKey: scope }); return "accepted"; } catch (e) { return e.code; } };

test("a code from the mailbox signs in; a wrong one does not", async () => {
  const { verifier, sent } = setup();
  const c = await verifier.start({ email: "a@example.gov", inviteKey: "inv1" }, settings);
  assert.equal(wrong(verifier, c, "inv1"), sent[0].code === "000000" ? "accepted" : "email_code_wrong");
  assert.equal(verifier.check({ id: c.id, code: sent[0].code, inviteKey: "inv1" }), "a@example.gov");
});

// Five tries per code times five codes was 25 guesses at a six-digit code every ten minutes, and asking for a
// fresh code reset the count. Wrong guesses now add up per address, across codes.
test("wrong guesses add up across fresh codes for the same address and link", async () => {
  const { verifier } = setup();
  const results = [];
  for (let n = 0; n < 5; n++) {
    let c;
    try { c = await verifier.start({ email: "a@example.gov", inviteKey: "inv1" }, settings); } catch (e) { results.push(e.code); continue; }
    for (let t = 0; t < 5; t++) results.push(wrong(verifier, c, "inv1"));
  }
  assert.equal(results.filter(r => r === "email_code_wrong").length, 8, `eight real guesses, then the address is paused: ${results.join()}`);
  assert.ok(results.includes("rate_limited"), "the pause shows as rate_limited, on a guess or on asking for another code");
  assert.ok(results.slice(results.indexOf("rate_limited")).every(r => r === "rate_limited" || r === "email_code_expired"));
});

test("the pause ends after ten minutes", async () => {
  const { verifier, tick } = setup();
  const c = await verifier.start({ email: "a@example.gov", inviteKey: "inv1" }, settings);
  for (let t = 0; t < 4; t++) wrong(verifier, c, "inv1");
  const d = await verifier.start({ email: "a@example.gov", inviteKey: "inv1" }, settings);
  for (let t = 0; t < 5; t++) wrong(verifier, d, "inv1");
  assert.equal(wrong(verifier, d, "inv1"), "rate_limited");
  tick(10 * 60 * 1000 + 1);
  const e = await verifier.start({ email: "a@example.gov", inviteKey: "inv1" }, settings);
  assert.equal(wrong(verifier, e, "inv1"), "email_code_wrong");
});

// Someone holding a team join link could request five codes for a colleague's address and use up the shared budget,
// so the colleague's own "send me a code" (sign-in again) was refused. Budgets are now per link or session.
test("one link or session using up the send budget does not block another's", async () => {
  const { verifier } = setup();
  for (let n = 0; n < 5; n++) await verifier.start({ email: "victim@example.gov", inviteKey: "inv-attacker" }, settings);
  await assert.rejects(verifier.start({ email: "victim@example.gov", inviteKey: "inv-attacker" }, settings), e => e.code === "rate_limited");
  const own = await verifier.start({ email: "victim@example.gov", inviteKey: "session:dev1:usr1" }, settings);
  assert.ok(own.id, "the person's own re-entry code still goes out");
});

test("guessing at one address does not lock another address or another scope", async () => {
  const { verifier, sent } = setup();
  const a = await verifier.start({ email: "a@example.gov", inviteKey: "inv1" }, settings);
  for (let t = 0; t < 5; t++) wrong(verifier, a, "inv1");
  const a2 = await verifier.start({ email: "a@example.gov", inviteKey: "inv1" }, settings);
  for (let t = 0; t < 5; t++) wrong(verifier, a2, "inv1");
  const b = await verifier.start({ email: "b@example.gov", inviteKey: "inv1" }, settings);
  assert.equal(verifier.check({ id: b.id, code: sent.at(-1).code, inviteKey: "inv1" }), "b@example.gov");
  const mine = await verifier.start({ email: "a@example.gov", inviteKey: "session:dev1:usr1" }, settings);
  assert.equal(verifier.check({ id: mine.id, code: sent.at(-1).code, inviteKey: "session:dev1:usr1" }), "a@example.gov");
});

test("no default domain: enabled with no domains allows nobody and warns at startup", async () => {
  const { emailSettings, emailSetupWarning } = await import("./email-verify.mjs");
  assert.deepEqual(emailSettings({ emailVerification: { enabled: true } }).domains, []);
  assert.deepEqual(emailSettings({ emailVerification: { enabled: true, domains: ["@Example.gov", " "] } }).domains, ["example.gov"]);
  assert.match(emailSetupWarning({ emailVerification: { enabled: true, domains: [] } }), /emailVerification\.domains is empty/);
  assert.equal(emailSetupWarning({ emailVerification: { enabled: true, domains: ["example.gov"] } }), null);
  assert.equal(emailSetupWarning({}), null, "off: nothing to warn about");
  const sent = [];
  const verifier = createEmailVerifier({ send: async m => { sent.push(m); } });
  await assert.rejects(verifier.start({ email: "a@example.gov", inviteKey: "inv1" }, emailSettings({ emailVerification: { enabled: true } })), e => e.code === "email_not_allowed");
  assert.equal(sent.length, 0);
});
