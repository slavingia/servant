import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The bundled mailer carries the Gmail app password and every sign-in code, so it must check the SMTP
// server's certificate. Python's SMTP_SSL does not unless it is handed a verifying context.
test("send-mail.py connects to SMTP with certificate and hostname verification on", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-mail-"));
  fs.writeFileSync(path.join(dir, "mail.json"), JSON.stringify({ user: "test@example.test", appPassword: "aaaa bbbb cccc dddd" }));
  const stubs = path.join(dir, "stubs");
  fs.mkdirSync(stubs);
  const seen = path.join(dir, "seen.json");
  // Replaces the network class only: records how it was asked to connect and sends nothing.
  fs.writeFileSync(path.join(stubs, "sitecustomize.py"), `
import json, os, smtplib, ssl
class Stub:
    def __init__(self, host, port, *args, **kwargs):
        ctx = kwargs.get("context")
        if ctx is None:
            ctx = ssl._create_stdlib_context()  # what SMTP_SSL itself falls back to
        json.dump({"host": host, "verify": int(ctx.verify_mode), "hostname": ctx.check_hostname}, open(os.environ["SEEN"], "w"))
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def login(self, *a): pass
    def send_message(self, *a): pass
smtplib.SMTP_SSL = Stub
`);
  const run = spawnSync("python3", [new URL("./send-mail.py", import.meta.url).pathname], {
    input: JSON.stringify({ to: "a@example.test", subject: "s", text: "t" }),
    env: { ...process.env, SERVANT_DATA_DIR: dir, PYTHONPATH: stubs, SEEN: seen },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const used = JSON.parse(fs.readFileSync(seen, "utf8"));
  assert.equal(used.host, "smtp.gmail.com");
  assert.equal(used.verify, 2, "ssl.CERT_REQUIRED: a certificate must be presented and valid");
  assert.equal(used.hostname, true, "the certificate must match smtp.gmail.com");
});
