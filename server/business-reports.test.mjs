import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_PENDING, PER_USER_PER_DAY, createBusinessReports, reportingEnabled } from "./business-reports.mjs";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "servant-reports-")), "reports.db");
const clock = () => { let t = 1_800_000_000_000; return { now: () => t, tick: (ms) => { t += ms; } }; };
const text = (n) => `Please review the fake vendor roster number ${n} for the training workshop`;

test("it is off unless all three switches are on", () => {
  assert.equal(reportingEnabled(undefined), false);
  assert.equal(reportingEnabled({ enabled: true, businessInfo: true }), false, "reporting is its own opt-in");
  assert.equal(reportingEnabled({ enabled: true, reportFalseAlarms: true }), false, "it needs the business check");
  assert.equal(reportingEnabled({ businessInfo: true, reportFalseAlarms: true }), false, "it needs the warning enabled");
  assert.equal(reportingEnabled({ enabled: true, businessInfo: true, reportFalseAlarms: true }), true);
});

test("a report waits for review and is not exported until the owner approves it", () => {
  const s = createBusinessReports({ file: tmp() });
  const { id } = s.submit({ userId: "u1", text: text(1), score: 0.7 });
  assert.equal(s.list("pending").length, 1);
  assert.deepEqual(s.exportApproved(), [], "pending reports are never trained on");
  assert.equal(s.approve(id, "owner"), true);
  const rows = s.exportApproved();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].labels, [], "an approved false alarm becomes a benign example");
  assert.equal(rows[0].source, "false_alarm_report");
  assert.equal(s.approve(id, "owner"), false, "a reviewed report cannot be approved twice");
  s.close();
});

test("rejecting erases the message text and leaves only a hash, so it is not queued again", () => {
  const file = tmp();
  const s = createBusinessReports({ file });
  const { id } = s.submit({ userId: "u1", text: text(2), score: 0.9 });
  assert.equal(s.reject(id, "owner"), true);
  assert.deepEqual(s.exportApproved(), []);
  assert.equal(s.list("rejected")[0].text, null, "no text kept");
  const raw = new DatabaseSync(file).prepare("SELECT text FROM reports WHERE id = ?").get(id);
  assert.equal(raw.text, null, "erased in the file itself");
  assert.equal(s.submit({ userId: "u2", text: `  ${text(2).toUpperCase()}  `, score: 0.9 }).duplicate, true, "the same message, any case or spacing, is not queued again");
  s.close();
});

test("the same message is queued once, even from different people", () => {
  const s = createBusinessReports({ file: tmp() });
  s.submit({ userId: "u1", text: text(3), score: 0.5 });
  assert.equal(s.submit({ userId: "u2", text: text(3), score: 0.5 }).duplicate, true);
  assert.equal(s.list("pending").length, 1);
  s.close();
});

test("each person can report only so many a day, and the cap resets", () => {
  const c = clock();
  const s = createBusinessReports({ file: tmp(), now: c.now });
  for (let i = 0; i < PER_USER_PER_DAY; i++) s.submit({ userId: "u1", text: text(100 + i), score: 0.6 });
  assert.throws(() => s.submit({ userId: "u1", text: text(999), score: 0.6 }), e => e.status === 429);
  s.submit({ userId: "u2", text: text(998), score: 0.6 });
  c.tick(24 * 60 * 60 * 1000 + 1000);
  assert.ok(s.submit({ userId: "u1", text: text(997), score: 0.6 }).id, "tomorrow is a new day");
  s.close();
});

test("unreviewed reports expire after thirty days and are erased", () => {
  const c = clock();
  const file = tmp();
  const s = createBusinessReports({ file, now: c.now });
  s.submit({ userId: "u1", text: text(4), score: 0.6 });
  c.tick(29 * 24 * 60 * 60 * 1000);
  assert.equal(s.list("pending").length, 1, "still waiting on day 29");
  c.tick(2 * 24 * 60 * 60 * 1000);
  assert.equal(s.list("pending").length, 0, "gone after thirty days");
  assert.equal(new DatabaseSync(file).prepare("SELECT COUNT(*) AS n FROM reports").get().n, 0, "deleted from the file, not just hidden");
  s.close();
});

test("approved reports are kept (they are the training set) and are not touched by the expiry", () => {
  const c = clock();
  const s = createBusinessReports({ file: tmp(), now: c.now });
  const { id } = s.submit({ userId: "u1", text: text(5), score: 0.6 });
  s.approve(id, "owner");
  c.tick(90 * 24 * 60 * 60 * 1000);
  assert.equal(s.exportApproved().length, 1);
  s.close();
});

test("the queue has a ceiling, and bad input is refused", () => {
  const s = createBusinessReports({ file: tmp() });
  for (const bad of ["", "   ", "x".repeat(4001)]) assert.throws(() => s.submit({ userId: "u1", text: bad, score: 0.5 }), e => e.status === 400);
  assert.ok(MAX_PENDING >= 1000);
  s.close();
});

test("the file is private to the server's user", { skip: process.platform === "win32" }, () => {
  const file = tmp();
  createBusinessReports({ file }).close();
  assert.equal(fs.statSync(file).mode & 0o077, 0, "no group or world access");
});
