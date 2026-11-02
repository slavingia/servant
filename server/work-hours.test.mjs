import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { workHoursConfig, postingClosed, workHoursMessage } from "./work-hours.mjs";
import { createMessaging } from "./messaging.mjs";

const rule = workHoursConfig({ start: "08:30", end: "16:30", timeZone: "America/New_York" });
// Monday, November 2, 2026 (EST, UTC-5) and Saturday, November 7.
const et = (day, hhmm) => Date.parse(`2026-11-${day}T${hhmm}:00-05:00`);

test("posting is closed 8:30 am to 4:30 pm Eastern on weekdays only", () => {
  assert.equal(postingClosed(rule, et("02", "08:29")), false);
  assert.equal(postingClosed(rule, et("02", "08:30")), true);
  assert.equal(postingClosed(rule, et("02", "12:00")), true);
  assert.equal(postingClosed(rule, et("02", "16:29")), true);
  assert.equal(postingClosed(rule, et("02", "16:30")), false);
  assert.equal(postingClosed(rule, et("07", "12:00")), false, "Saturday stays open");
});

test("uses the configured time zone, not the Mac's", () => {
  // 13:45 UTC is 8:45 am Eastern (closed) and 5:45 am Pacific (open).
  const at = Date.parse("2026-11-02T13:45:00Z");
  assert.equal(postingClosed(rule, at), true);
  assert.equal(postingClosed(workHoursConfig({ timeZone: "America/Los_Angeles" }), at), false);
});

test("off unless configured, and bad settings fail loudly", () => {
  assert.equal(workHoursConfig(undefined), null);
  assert.equal(workHoursConfig({ enabled: false }), null);
  assert.equal(postingClosed(null), false);
  assert.throws(() => workHoursConfig({ start: "8.30" }));
  assert.throws(() => workHoursConfig({ timeZone: "Mars/Olympus" }));
});

test("the message points people to Teams", () => {
  assert.equal(workHoursMessage(rule), "Posting is off from 8:30 am to 4:30 pm on weekdays. Use Microsoft Teams during work hours");
});

test("channel and thread posts are refused while closed, and allowed after hours", async (t) => {
  let closed = true;
  const people = { owner: { id: "owner", name: "Owner", role: "owner" } };
  const always = workHoursConfig({ start: "00:00", end: "24:00", days: [0, 1, 2, 3, 4, 5, 6] });
  const messaging = createMessaging({ file: ":memory:", users: () => people, agentName: () => "Agent", askAgent: async () => "", workHours: () => (closed ? always : null) });
  t.after(() => messaging.close());
  const channel = messaging.createChannel(people.owner, { name: "hours" });
  const post = async (text) => {
    let out;
    const req = Readable.from([Buffer.from(JSON.stringify({ text }))]);
    await messaging.handle(req, { setHeader() {} }, {
      user: people.owner, method: "POST", parts: ["v1", "conversations", channel.id, "messages"], url: new URL("http://local"),
      send: (_r, status, data) => { out = { status, data }; }, fail: (_r, status, code, message) => { out = { status, code, message }; },
      readBody: async () => ({ text }),
    });
    return out;
  };
  const refused = await post("during work");
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "work_hours");
  assert.match(refused.message, /Microsoft Teams/);
  assert.equal(messaging.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE text = ?").get("during work").n, 0, "nothing is stored");
  closed = false;
  assert.equal((await post("after work")).status, 201);
});
