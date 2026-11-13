import assert from "node:assert/strict";
import { test } from "node:test";
import { commandSender } from "./email-verify.mjs";

const mail = { to: "a@example.test", code: "123456", minutes: 10 };

test("the mailer command gets the message on stdin and a clean exit resolves", async () => {
  await commandSender(mail, { mailer: { command: "cat >/dev/null" } });
  await assert.rejects(commandSender(mail, { mailer: { command: "exit 3" } }), /mailer exited 3/);
  await assert.rejects(commandSender(mail, {}), /no mailer configured/);
});

// A hung mailer (SMTP stuck, wrong password prompt) used to hold the person's sign-in request open forever.
test("a mailer that never finishes is stopped and reported", async () => {
  const started = Date.now();
  await assert.rejects(commandSender(mail, { mailer: { command: "sleep 30", timeoutMs: 300 } }), /mailer timed out/);
  assert.ok(Date.now() - started < 5000, "gave up quickly instead of waiting for the mailer");
});

// Larger than the pipe buffer: closing stdin cannot accidentally accept the whole
// message before the command exits. No timing assumptions or sleeping are needed.
for (const exitCode of [3, 0]) {
  test(`a mailer that closes stdin early and exits ${exitCode} rejects safely`, async () => {
    const message = { ...mail, text: "x".repeat(8 * 1024 * 1024) };
    await assert.rejects(commandSender(message, { mailer: { command: `exec 0<&-; exit ${exitCode}` } }), error => {
      if (exitCode !== 0) assert.match(error.message, /mailer exited 3/);
      else {
        assert.equal(error.message, "mailer input failed");
        assert.ok(["EPIPE", "ECONNRESET"].includes(error.cause?.code));
      }
      return true;
    });
  });
}
