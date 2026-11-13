import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUSINESS_WARNING, businessWarningEnabled, createTokenizer, screenBusiness, screenMessage } from "./business-gate.mjs";

const REAL = fs.existsSync(path.join(process.env.SERVANT_PII_DIR || path.join(os.homedir(), ".local/share/servant/models/rampart-edge"), "business/business-int8.onnx"));

test("it is off unless config turns both switches on", () => {
  assert.equal(businessWarningEnabled(undefined), false);
  assert.equal(businessWarningEnabled({ enabled: true }), false, "personal-information warning alone does not turn it on");
  assert.equal(businessWarningEnabled({ businessInfo: true }), false, "businessInfo needs the warning enabled");
  assert.equal(businessWarningEnabled({ enabled: true, businessInfo: "yes" }), false);
  assert.equal(businessWarningEnabled({ enabled: true, businessInfo: true }), true);
});

test("a score over the line warns in general words, below it does not, and the message is never quoted", async () => {
  const secret = "the vault password is Gr33n-Tiger!42";
  const w = await screenBusiness(secret, { score: async () => 0.9 });
  assert.equal(w.message, BUSINESS_WARNING);
  assert.ok(!w.message.includes("Gr33n"), "the warning does not repeat what was typed");
  assert.equal(await screenBusiness(secret, { score: async () => 0.1 }), null);
  assert.equal(await screenBusiness("   ", { score: async () => 0.99 }), null, "blank text never warns");
});

test("a failing check lets the message through", async () => {
  assert.equal(await screenBusiness("x", { score: async () => { throw new Error("boom"); } }), null);
});

test("screenMessage: personal information wins and keeps its types; business runs only when switched on", async () => {
  const personal = async () => ({ message: "personal", types: ["GOV_ID"] });
  const none = async () => null;
  const biz = async () => ({ message: BUSINESS_WARNING });
  assert.deepEqual(await screenMessage("x", { enabled: true, businessInfo: true }, { personal, businessCheck: biz }), { message: "personal", types: ["GOV_ID"] });
  assert.equal((await screenMessage("x", { enabled: true, businessInfo: true }, { personal: none, businessCheck: biz })).message, BUSINESS_WARNING);
  assert.equal(await screenMessage("x", { enabled: true }, { personal: none, businessCheck: biz }), null, "off by default");
  assert.equal(await screenMessage("x", undefined, { personal, businessCheck: biz }), null, "nothing runs when the warning is off");
  assert.equal(await screenMessage("x", false, { personal, businessCheck: biz }), null);
  assert.equal((await screenMessage("x", true, { personal: none, businessCheck: biz })), null, "true means personal only");
});

test("the JavaScript tokenizer matches the Python one on awkward text", () => {
  const vocab = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]", "hello", "world", "##s", "caf", "##e", "a", "$", "1", ",", "."].join("\n");
  const t = createTokenizer(vocab);
  assert.deepEqual(t.encode("Hello, worlds."), [5, 13, 6, 7, 14]);
  assert.deepEqual(t.encode("CAFÉ"), [8, 9], "lower-cased and accents stripped, as BERT does");
  assert.deepEqual(t.encode("[CLS] hello [SEP]"), [2, 5, 3], "special tokens in the text map to themselves");
  assert.deepEqual(t.encode("zzzz"), [1], "unknown words become [UNK]");
  assert.deepEqual(t.encode("   \n\t  "), []);
});

test("the real model: warns on secrets, bid prices and restricted text; lets ordinary and public messages through", { skip: !REAL }, async () => {
  const warns = [
    "prod db: postgres://app_user:Tr0ub4dor&3xQ@db-prod-01.internal.example:5432/orders",
    "Final proposal price is $4,812,300 and Northgate came in at $5.1M, so we are low. Do not share before the award is announced.",
    "EMBARGOED UNTIL THURSDAY 6:00 AM ET. Draft press release, not for distribution: the agency will announce the new rule on Friday.",
    "Pen test finding: the admin console at 10.4.22.7 accepts the default login and the VPN gateway is unpatched against the session bug.",
  ];
  const fine = [
    "what time is the standup tomorrow",
    "What is the standard deduction for 2026 and when is the filing deadline?",
    "Can you explain what CUI means and how to mark a document?",
    "Say a contract is $X over 3 years with a 5% annual escalator. What's the Excel formula for the total?",
    "docs example: set API_KEY=<your-key-here> in your environment, never commit the real one",
  ];
  for (const t of warns) assert.ok(await screenBusiness(t), `should warn: ${t.slice(0, 60)}`);
  for (const t of fine) assert.equal(await screenBusiness(t), null, `should not warn: ${t.slice(0, 60)}`);
});
