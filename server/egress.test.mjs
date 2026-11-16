// The agent's outbound gate: nothing goes out unless the "always" list or the person's entitlements say so.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { cleanHost, createEgressProxy, createEgressStore, egressSettings, hostMatches, isInternalAddress, judge } from "./egress.mjs";

test("host names, patterns and settings", () => {
  assert.equal(cleanHost(" API.Example.gov. "), "api.example.gov");
  assert.equal(cleanHost("*.example.gov"), "*.example.gov");
  assert.equal(cleanHost("[2001:db8::1]"), "2001:db8::1");
  for (const bad of ["https://example.gov", "example.gov/path", "a b.gov", "", "*", "exa*mple.gov", null, 7]) assert.equal(cleanHost(bad), null, String(bad));
  assert.equal(hostMatches("*.example.gov", "api.example.gov"), true);
  assert.equal(hostMatches("*.example.gov", "a.b.example.gov"), true);
  assert.equal(hostMatches("*.example.gov", "example.gov"), false);
  assert.equal(hostMatches("*.example.gov", "badexample.gov"), false);
  assert.equal(hostMatches("example.gov", "example.gov"), true);
  assert.deepEqual(egressSettings(undefined), { mode: "off", port: 8790, always: [], holdSeconds: 0 });
  assert.deepEqual(egressSettings({ mode: "ask", port: 9000, always: ["API.example.gov", "nope/", "api.example.gov"], holdSeconds: 900 }), { mode: "ask", port: 9000, always: ["api.example.gov"], holdSeconds: 120 });
  assert.equal(egressSettings({ mode: "on" }).mode, "off", "anything but ask is off");
});

test("this machine and private networks are never a destination", () => {
  for (const inside of ["127.0.0.1", "10.1.2.3", "192.168.1.10", "172.16.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "not-an-address"]) assert.equal(isInternalAddress(inside), true, inside);
  for (const outside of ["8.8.8.8", "140.82.112.3", "2606:4700::1111"]) assert.equal(isInternalAddress(outside), false, outside);
});

test("a connection is judged for its token's person, else for everyone whose agent is working", () => {
  const settings = egressSettings({ mode: "ask", always: ["models.example.gov"] });
  const grants = { usr_pat: ["api.example.gov"], usr_jo: [] };
  const allowed = (userId, host) => (grants[userId] || []).includes(host);
  const whose = token => token === "pat-token" ? { userId: "usr_pat", chatId: "chat_1" } : token === "jo-token" ? { userId: "usr_jo" } : null;
  const ask = (host, token, active = []) => judge({ settings, host, token, whose, active: () => active, allowed });
  assert.equal(ask("models.example.gov", "", []).verdict, "allow", "the always list needs nobody");
  assert.deepEqual(ask("api.example.gov", "", []), { verdict: "deny", blocked: [], reason: "nobody" });
  assert.equal(ask("api.example.gov", "pat-token").verdict, "allow");
  assert.deepEqual(ask("api.example.gov", "jo-token"), { verdict: "deny", blocked: [{ userId: "usr_jo" }] });
  assert.equal(ask("api.example.gov", "", ["usr_pat"]).verdict, "allow");
  assert.deepEqual(ask("api.example.gov", "", ["usr_pat", "usr_jo"]), { verdict: "deny", blocked: [{ userId: "usr_jo" }] }, "one person without it closes it for unattributed traffic");
  assert.equal(ask("api.example.gov", "pat-token", ["usr_pat", "usr_jo"]).verdict, "allow", "a token is judged on its own");
  assert.equal(judge({ settings, host: "api.example.gov", token: "pat-token", whose, allowed, known: () => false }).reason, "nobody", "someone who left has no say");
});

test("tokens are kept as hashes, expire, and stop when the person leaves; refusals tell people once a day", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-egress-"));
  let now = 1_800_000_000_000;
  const store = createEgressStore(path.join(dir, "egress.db"), { clock: () => now });
  const token = store.mintToken("usr_pat", "chat_1", 1);
  assert.deepEqual(store.whose(token), { userId: "usr_pat", chatId: "chat_1" });
  assert.equal(store.whose("wrong"), null);
  assert.equal(fs.readFileSync(path.join(dir, "egress.db")).includes(token), false, "the token itself is not on disk");
  now += 3600_001;
  assert.equal(store.whose(token), null, "expired");
  const second = store.mintToken("usr_pat");
  store.forget("usr_pat");
  assert.equal(store.whose(second), null);

  assert.equal(store.refused({ userId: "usr_pat", host: "api.example.gov", port: 443, chatId: "chat_1" }).fresh, true);
  const again = store.refused({ userId: "usr_pat", host: "api.example.gov", port: 443 });
  assert.equal(again.fresh, false);
  assert.equal(again.attempt.attempts, 2);
  assert.equal(again.attempt.chatId, "chat_1");
  assert.equal(store.refused({ userId: "usr_jo", host: "api.example.gov", port: 443 }).fresh, true, "another person is another row");
  now += 24 * 3600_000;
  assert.equal(store.refused({ userId: "usr_pat", host: "api.example.gov", port: 443 }).fresh, true, "a day later people are told again");
  assert.deepEqual(store.recent().map(a => a.userId), ["usr_pat", "usr_jo"]);
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// A raw CONNECT through the proxy; resolves with the status line, headers and anything read after them.
function connectThrough(proxyPort, target, { token, send } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    let data = "";
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${token ? `Proxy-Authorization: Basic ${Buffer.from(`${token}:`).toString("base64")}\r\n` : ""}\r\n`));
    socket.on("data", chunk => {
      data += chunk;
      if (send && data.includes("\r\n\r\n") && data.startsWith("HTTP/1.1 200") && !socket.sent) { socket.sent = true; socket.write(send); }
      if (send && data.includes("pong")) socket.end();
    });
    socket.on("close", () => resolve({ status: Number(data.slice(9, 12)), text: data }));
  });
}

test("the proxy refuses, tells people once, then tunnels after the entitlement is granted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-egress-"));
  const store = createEgressStore(path.join(dir, "egress.db"));
  const echo = net.createServer(socket => socket.on("data", chunk => socket.write(String(chunk).replace("ping", "pong"))));
  await new Promise(done => echo.listen(0, "127.0.0.1", done));
  const web = http.createServer((req, res) => res.end(`plain ${req.headers.host} ${req.url} ${req.headers["proxy-authorization"] || "no-proxy-header"}`));
  await new Promise(done => web.listen(0, "127.0.0.1", done));
  const grants = new Set();
  const told = [];
  let current = { mode: "ask", always: ["models.example.gov"] };
  const dialed = [];
  const proxy = createEgressProxy({ store, settings: () => egressSettings(current), allowed: (userId, host) => grants.has(`${userId} ${host}`), active: () => [], blocked: attempt => told.push(attempt),
    hint: host => `it needs the entitlement "Tax data API" for ${host}.`, resolve: async host => [{ address: host === "inside.example.gov" ? "10.0.0.5" : "203.0.113.9" }],
    connect: (port, address) => { dialed.push(`${address}:${port}`); return net.connect(echo.address().port, "127.0.0.1"); } });
  const port = await proxy.listen(0);
  const pat = store.mintToken("usr_pat", "chat_1");

  const first = await connectThrough(port, "api.example.gov:443", { token: pat });
  assert.equal(first.status, 403);
  assert.match(first.text, /X-Servant-Egress: deny/);
  assert.match(first.text, /Servant blocked api\.example\.gov: it needs the entitlement "Tax data API"/);
  await connectThrough(port, "api.example.gov:443", { token: pat });
  assert.equal(told.length, 1, "told once, not per attempt");
  assert.deepEqual({ userId: told[0].userId, host: told[0].host, chatId: told[0].chatId }, { userId: "usr_pat", host: "api.example.gov", chatId: "chat_1" });
  assert.deepEqual(dialed, [], "nothing left the machine");

  const nobody = await connectThrough(port, "api.example.gov:443");
  assert.equal(nobody.status, 403);
  assert.match(nobody.text, /no agent turn is running/);

  grants.add("usr_pat api.example.gov");
  const open = await connectThrough(port, "api.example.gov:443", { token: pat, send: "ping" });
  assert.equal(open.status, 200);
  assert.match(open.text, /pong/);
  assert.deepEqual(dialed, ["203.0.113.9:443"], "it dials the address it checked, not the name");

  const always = await connectThrough(port, "models.example.gov:443", { send: "ping" });
  assert.equal(always.status, 200, "the always list needs no person");

  // A name that points at a private address stays closed even when the entitlement covers it.
  grants.add("usr_pat inside.example.gov");
  const inward = await connectThrough(port, "inside.example.gov:443", { token: pat });
  assert.equal(inward.status, 403);
  assert.match(inward.text, /private network/);
  const loopback = await connectThrough(port, "127.0.0.1:8787", { token: pat });
  assert.equal(loopback.status, 403);
  assert.equal((await connectThrough(port, "exa*mple.gov:443")).status, 400);

  // Plain HTTP through the proxy follows the same rules, and the token is not forwarded.
  const plain = (url, token) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: url, headers: { Host: new URL(url).host, ...(token ? { "Proxy-Authorization": `Basic ${Buffer.from(`x:${token}`).toString("base64")}` } : {}) } }, res => {
      let body = ""; res.on("data", c => body += c); res.on("end", () => resolve({ status: res.statusCode, body, verdict: res.headers["x-servant-egress"] }));
    });
    req.on("error", reject); req.end();
  });
  const refusedPlain = await plain("http://other.example.gov/x", pat);
  assert.equal(refusedPlain.status, 403);
  assert.equal(refusedPlain.verdict, "deny");
  assert.equal((await plain("http://127.0.0.1:1/x", pat)).status, 403);

  // Turned off in config.json: everything is refused, the always list included (the sandbox has no other way out).
  current = { mode: "off", always: ["models.example.gov"] };
  assert.equal((await connectThrough(port, "models.example.gov:443")).status, 403);

  await proxy.close();
  // With internal targets allowed (tests only), a plain request reaches the web server without the proxy header.
  const local = createEgressProxy({ store, settings: () => egressSettings({ mode: "ask", always: ["127.0.0.1"] }), allowed: () => false, active: () => [], allowInternal: true });
  const localPort = await local.listen(0);
  const through = await new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:${web.address().port}/hello?x=1`;
    const req = http.request({ host: "127.0.0.1", port: localPort, method: "GET", path: url, headers: { Host: new URL(url).host, "Proxy-Authorization": "Basic eDp5" } }, res => { let body = ""; res.on("data", c => body += c); res.on("end", () => resolve({ status: res.statusCode, body })); });
    req.on("error", reject); req.end();
  });
  assert.equal(through.status, 200);
  assert.equal(through.body, `plain 127.0.0.1:${web.address().port} /hello?x=1 no-proxy-header`);
  await local.close();
  echo.close(); web.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("a refused attempt can wait for a manager and carry on when the entitlement is granted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-egress-"));
  const store = createEgressStore(path.join(dir, "egress.db"));
  const echo = net.createServer(socket => socket.on("data", chunk => socket.write(String(chunk).replace("ping", "pong"))));
  await new Promise(done => echo.listen(0, "127.0.0.1", done));
  let granted = false, waits = 0;
  const proxy = createEgressProxy({ store, settings: () => egressSettings({ mode: "ask", holdSeconds: 5 }), allowed: () => granted, active: () => ["usr_pat"],
    resolve: async () => [{ address: "203.0.113.9" }], connect: () => net.connect(echo.address().port, "127.0.0.1"), sleep: async () => { if (++waits === 2) granted = true; } });
  const port = await proxy.listen(0);
  const held = await connectThrough(port, "api.example.gov:443", { send: "ping" });
  assert.equal(held.status, 200);
  assert.equal(waits, 2);
  await proxy.close(); echo.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true });
});
