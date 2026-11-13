import assert from "node:assert/strict";
import test from "node:test";
import { PiiDeclined, piiFlags, withPiiConfirm } from "./pii-warning.ts";

class ServerError extends Error {
  status: number; code: string; details: Record<string, unknown>;
  constructor(message: string, status = 0, code = "network", details: Record<string, unknown> = {}) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}

const warn = () => new ServerError("This looks like it has a phone number.", 409, "pii_warning", { types: ["PHONE"] });

test("a send with nothing to warn about runs once", async () => {
  let runs = 0;
  assert.equal(await withPiiConfirm(async () => assert.fail("asked"), async c => { runs++; assert.equal(c, false); return "ok"; }), "ok");
  assert.equal(runs, 1);
});
test("a warning asks with the server's sentence and sends again on yes", async () => {
  const seen: boolean[] = []; let asked = "";
  const out = await withPiiConfirm(async m => { asked = m; return true; }, async c => { seen.push(c); if (!c) throw warn(); return "sent"; });
  assert.equal(out, "sent"); assert.deepEqual(seen, [false, true]); assert.match(asked, /phone number/);
});
test("a warning declined sends nothing", async () => {
  let runs = 0;
  await assert.rejects(withPiiConfirm(async () => false, async () => { runs++; throw warn(); }), PiiDeclined);
  assert.equal(runs, 1);
});
test("other errors pass through untouched", async () => {
  const other = new ServerError("nope", 500, "boom");
  await assert.rejects(withPiiConfirm(async () => assert.fail("asked"), async () => { throw other; }), e => e === other);
});

const reportable = () => new ServerError("This looks like it may have sensitive business information.", 409, "pii_warning", { types: [], reportable: true });

test("the flags sent for each choice: nothing, send anyway, or send anyway and report", () => {
  assert.deepEqual(piiFlags(false), {});
  assert.deepEqual(piiFlags(true), { confirmPii: true });
  assert.deepEqual(piiFlags("reported"), { confirmPii: true, reportFalseAlarm: true }, "a report always implies sending anyway");
});

test("the dialog is told whether the server can take a report", async () => {
  const seen: (boolean | undefined)[] = [];
  await withPiiConfirm(async (_m, o) => { seen.push(o?.reportable); return true; }, async c => { if (!c) throw reportable(); return "ok"; });
  await withPiiConfirm(async (_m, o) => { seen.push(o?.reportable); return true; }, async c => { if (!c) throw warn(); return "ok"; });
  assert.deepEqual(seen, [true, false], "only a server-marked business warning is reportable");
});

test("a report goes out with the resend, and declining sends and reports nothing", async () => {
  const sent: unknown[] = [];
  await withPiiConfirm(async () => "reported", async c => { sent.push(c); if (!c) throw reportable(); return "ok"; });
  assert.deepEqual(sent, [false, "reported"]);
  sent.length = 0;
  await assert.rejects(withPiiConfirm(async () => false, async c => { sent.push(c); throw reportable(); }), PiiDeclined);
  assert.deepEqual(sent, [false], "declined: only the first attempt, nothing resent");
});
