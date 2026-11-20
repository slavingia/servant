// The agent's sandbox (scripts/run-agent-sandboxed.sh, docs/agent-egress.md), tried from the inside: what a command
// started through it, and a command that command starts, can and can't reach. Mac only: it runs the real
// sandbox-exec. Nothing here leaves this computer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const wrapper = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "run-agent-sandboxed.sh");
const mac = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");
const skip = mac ? false : "needs the Mac sandbox (sandbox-exec)";

const listen = () => new Promise(resolve => {
  const server = net.createServer(socket => socket.end("hello\n"));
  server.listen(0, "127.0.0.1", () => resolve(server));
});
// Runs a shell line inside the sandbox. Resolves with what it printed; a line's own failures are part of the output.
async function inside(line, env = {}) {
  const { stdout } = await run(wrapper, ["/bin/sh", "-c", line], { env: { PATH: process.env.PATH, HOME: os.homedir(), ...env }, timeout: 20000 });
  return stdout;
}
// One TCP connection attempt from a new process: prints "reached" or "refused".
const probe = path.join(fs.realpathSync(os.tmpdir()), `servant-sandbox-probe-${process.pid}.cjs`);
fs.writeFileSync(probe, 'const s=require("net").connect(Number(process.argv[2]),"127.0.0.1");s.on("data",()=>{console.log("reached");process.exit()});s.on("error",()=>{console.log("refused");process.exit()});setTimeout(()=>{console.log("refused");process.exit()},3000);\n');
process.on("exit", () => fs.rmSync(probe, { force: true }));
const connect = port => `${process.execPath} ${probe} ${port}`;

test("network: only the gate's port is reachable, for the command and for what it starts", { skip }, async () => {
  const gate = await listen(), other = await listen();
  try {
    const env = { SERVANT_EGRESS_PORT: String(gate.address().port) };
    assert.equal((await inside(connect(gate.address().port), env)).trim(), "reached", "the gate itself");
    assert.equal((await inside(connect(other.address().port), env)).trim(), "refused", "another local service");
    // A grandchild, started through two more shells, is held by the same rules.
    assert.equal((await inside(`/bin/sh -c "/bin/sh -c '${connect(other.address().port)}'"`, env)).trim(), "refused");
    assert.equal((await inside(`/bin/sh -c "/bin/sh -c '${connect(gate.address().port)}'"`, env)).trim(), "reached", "and still reaches the gate");
    // A named local port can be opened on purpose, and only that one.
    assert.equal((await inside(connect(other.address().port), { ...env, SERVANT_SANDBOX_LOCAL_PORTS: String(other.address().port) })).trim(), "reached");
  } finally { gate.close(); other.close(); }
});

test("files: a closed folder can't be read or written, by its path, a link, a detour or a child process", { skip }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "servant-sandbox-")));
  const closed = path.join(root, "closed"), open = path.join(closed, "open"), out = path.join(root, "out");
  for (const dir of [open, out]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(closed, "key"), "secret\n");
  fs.writeFileSync(path.join(closed, "data.db"), "rows\n");
  fs.writeFileSync(path.join(open, "file"), "handed over\n");
  fs.symlinkSync(path.join(closed, "key"), path.join(out, "link"));
  const env = { SERVANT_EGRESS_PORT: "59999", SERVANT_SANDBOX_DENY_PATHS: closed, SERVANT_SANDBOX_ALLOW_PATHS: open };
  // Each attempt prints its name and whether the secret came out.
  const attempt = (name, command) => `if ${command} 2>/dev/null | grep -q secret; then echo "${name}: READ"; else echo "${name}: refused"; fi`;
  try {
    const result = await inside([
      attempt("by its path", `cat ${closed}/key`),
      attempt("through a link from outside", `cat ${out}/link`),
      attempt("by a detour through the open folder", `cat ${open}/../key`),
      attempt("from a child of a child", `/bin/sh -c "/bin/sh -c 'cat ${closed}/key'"`),
      attempt("copied out", `cp ${closed}/key ${out}/copy && cat ${out}/copy`),
      attempt("hard-linked out", `ln ${closed}/key ${out}/hard && cat ${out}/hard`),
      `if echo x > ${closed}/new 2>/dev/null; then echo "write: WROTE"; else echo "write: refused"; fi`,
      `if rm ${closed}/key 2>/dev/null; then echo "delete: DELETED"; else echo "delete: refused"; fi`,
      `if ls ${closed} >/dev/null 2>&1; then echo "list: LISTED"; else echo "list: refused"; fi`,
      `cat ${open}/file`,
    ].join("; "), env);
    assert.deepEqual(result.trim().split("\n"), [
      "by its path: refused", "through a link from outside: refused", "by a detour through the open folder: refused", "from a child of a child: refused",
      "copied out: refused", "hard-linked out: refused", "write: refused", "delete: refused", "list: refused",
      // The one folder opened again inside the closed one still works: that is how the agent is handed files.
      "handed over",
    ]);
    assert.equal(fs.readFileSync(path.join(closed, "key"), "utf8"), "secret\n", "untouched");
    assert.equal(fs.existsSync(path.join(closed, "new")), false);
    // A database's side files are closed with it, even ones that don't exist yet.
    const sides = await inside(["-wal", "-shm", "-journal"].map(suffix => `if echo x > ${closed}/data.db${suffix} 2>/dev/null; then echo WROTE; else echo refused; fi`).join("; "), { ...env, SERVANT_SANDBOX_DENY_PATHS: path.join(closed, "data.db") });
    assert.deepEqual(sides.trim().split("\n"), ["refused", "refused", "refused"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("what the sandbox does not do, written down so nobody assumes it", { skip }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "servant-sandbox-limits-")));
  const closed = path.join(root, "closed"), out = path.join(root, "out");
  for (const dir of [closed, out]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(closed, "key"), "secret\n");
  // A second name for the same file, made outside the sandbox before it started. The rules go by path.
  fs.linkSync(path.join(closed, "key"), path.join(out, "older-hard-link"));
  try {
    const env = { SERVANT_EGRESS_PORT: "59999", SERVANT_SANDBOX_DENY_PATHS: closed, EXAMPLE_TOKEN: "from-the-environment" };
    const result = await inside(`cat ${out}/older-hard-link; echo "$EXAMPLE_TOKEN"; cat ${root}/out/older-hard-link >/dev/null && echo "files outside the closed folders stay open"`, env);
    assert.deepEqual(result.trim().split("\n"), [
      // 1. A hard link that already existed outside the closed folder still reads. The sandboxed command can't make one.
      "secret",
      // 2. The environment is passed through: anything secret in it is the command's to read.
      "from-the-environment",
      // 3. Only what the operator lists is closed; the rest of the disk is as open as it was.
      "files outside the closed folders stay open",
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the wrapper refuses to start rather than run without a sandbox", async () => {
  const fails = async (args, env) => { try { await run(wrapper, args, { env: { PATH: process.env.PATH, ...env } }); return null; } catch (error) { return [error.code, String(error.stderr).trim()]; } };
  assert.deepEqual(await fails([], {}), [2, `usage: ${wrapper} command [arguments...]`]);
  assert.match((await fails(["/bin/echo", "hi"], { SERVANT_EGRESS_PORT: "80; rm" }))[1], /SERVANT_EGRESS_PORT must be a port number/);
  if (process.platform === "darwin") {
    assert.match((await fails(["/bin/echo", "hi"], { SERVANT_SANDBOX_DENY_PATHS: "relative/path" }))[1], /takes absolute paths/);
    assert.match((await fails(["/bin/echo", "hi"], { SERVANT_SANDBOX_DENY_PATHS: '/tmp/a"b' }))[1], /can't hold a path with a quote or backslash/);
    assert.match((await fails(["/bin/echo", "hi"], { SERVANT_SANDBOX_LOCAL_PORTS: "22)(allow default" }))[1], /takes port numbers/);
  }
});
