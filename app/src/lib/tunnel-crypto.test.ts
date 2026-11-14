import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { sealRequest, serverPoint, sharedSecret, toBase64 } from "./tunnel-crypto.ts";

// The other end of the wire, written with Node's own crypto: nothing here shares code with the app.
function nodeServer() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const serverKey = ecdh.getPublicKey("hex", "compressed");
  const keysFor = (envelope: { publicKey: string; salt: string }) => {
    const shared = ecdh.computeSecret(Buffer.from(envelope.publicKey, "hex"));
    return Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.from(envelope.salt, "base64"), Buffer.from(`servant-tunnel-v1:${serverKey}:${envelope.publicKey}`), 64));
  };
  const open = (envelope: { publicKey: string; salt: string; data: string }) => {
    const keys = keysFor(envelope);
    const data = Buffer.from(envelope.data, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", keys.subarray(0, 32), Buffer.alloc(12));
    decipher.setAAD(Buffer.from("servant-tunnel-v1:request"));
    decipher.setAuthTag(data.subarray(data.length - 16));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString("utf8"));
  };
  const frame = (envelope: { publicKey: string; salt: string }, sequence: number, value: unknown) => {
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(sequence, 8);
    const cipher = crypto.createCipheriv("aes-256-gcm", keysFor(envelope).subarray(32), nonce);
    cipher.setAAD(Buffer.from("servant-tunnel-v1:response"));
    return Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64");
  };
  return { ecdh, serverKey, open, frame };
}

const request = { method: "GET", path: "/v1/conversations", headers: { authorization: "Bearer token" }, body: "", at: 1763000000000 };

test("the shared secret with a pinned server key matches Node's ECDH for every fresh secret", () => {
  for (let server = 0; server < 3; server++) {
    const { ecdh, serverKey } = nodeServer();
    for (let i = 0; i < 12; i++) {
      const secret = crypto.randomBytes(32);
      const expected = ecdh.computeSecret(Buffer.from(p256.getPublicKey(secret)));
      assert.equal(Buffer.from(sharedSecret(serverKey, secret)).toString("hex"), expected.toString("hex"));
      // The path the app used before the table: the same bytes, so the wire format has not moved.
      assert.equal(Buffer.from(sharedSecret(serverKey, secret)).toString("hex"), Buffer.from(p256.getSharedSecret(secret, Buffer.from(serverKey, "hex")).slice(1)).toString("hex"));
    }
  }
});

test("a server key is checked and turned into a point once, then reused for every request", () => {
  const { serverKey } = nodeServer();
  const first = serverPoint(serverKey);
  assert.equal(serverPoint(serverKey), first);
  sealRequest(serverKey, request, crypto.randomBytes(32), crypto.randomBytes(32));
  assert.equal(serverPoint(serverKey), first);
  // Only a handful of servers are kept; an older one is rebuilt when it is needed again.
  for (let i = 0; i < 4; i++) serverPoint(nodeServer().serverKey);
  assert.notEqual(serverPoint(serverKey), first);
  assert.equal(Buffer.from(serverPoint(serverKey).toBytes(true)).toString("hex"), serverKey);
});

test("a key that is not a point on the curve is refused, with and without a table", () => {
  // Small x values, tried until Node's own ECDH says there is no such point.
  const valid = (key: string) => { try { const probe = crypto.createECDH("prime256v1"); probe.generateKeys(); probe.computeSecret(Buffer.from(key, "hex")); return true; } catch { return false; } };
  const offCurve = Array.from({ length: 40 }, (_, x) => `02${x.toString(16).padStart(64, "0")}`).find(key => !valid(key));
  assert.ok(offCurve, "an x with no point on the curve");
  assert.throws(() => serverPoint(offCurve));
  assert.throws(() => sharedSecret(offCurve, crypto.randomBytes(32)));
  assert.throws(() => sealRequest(offCurve, request, crypto.randomBytes(32), crypto.randomBytes(32)));
  assert.throws(() => serverPoint("not a key"), /trusted server key/);
  // Zero is not a secret.
  assert.throws(() => sharedSecret(nodeServer().serverKey, new Uint8Array(32)));
});

test("a sealed request opens on a server written with Node's crypto, and its reply opens in the app", () => {
  const server = nodeServer();
  for (let i = 0; i < 4; i++) {
    const secret = crypto.randomBytes(32);
    const body = JSON.stringify({ text: `Message ${i} — “quoted”, ünïcode and a long tail ${"x".repeat(i * 5000)}` });
    const tunnel = sealRequest(server.serverKey, { ...request, method: "POST", body }, new Uint8Array(secret), crypto.randomBytes(32));
    assert.equal(tunnel.envelope.publicKey, Buffer.from(p256.getPublicKey(secret)).toString("hex"));
    assert.deepEqual(server.open(tunnel.envelope), { ...request, method: "POST", body });
    // Reply frames of every size, so each base64 length (with and without padding) is read back.
    const text = "The refund status page needs a clearer “where is my refund” answer. ".repeat(260);
    const frames = [{ type: "headers", status: 200, headers: { "content-type": "application/json" } }, ...[0, 1, 2, 3, 17, 16384].map(length => ({ type: "chunk", data: text.slice(0, length) })), { type: "end" }];
    frames.forEach((value, sequence) => assert.deepEqual(tunnel.openFrame(server.frame(tunnel.envelope, sequence, value)), value));
    assert.throws(() => tunnel.openFrame(server.frame(tunnel.envelope, frames.length, { type: "end" })), /sequence/);
  }
});

test("a reply sealed for another request, or changed on the way, does not open", () => {
  const server = nodeServer();
  const first = sealRequest(server.serverKey, request, crypto.randomBytes(32), crypto.randomBytes(32));
  const second = sealRequest(server.serverKey, request, crypto.randomBytes(32), crypto.randomBytes(32));
  assert.notEqual(first.envelope.publicKey, second.envelope.publicKey);
  const headers = { type: "headers", status: 200, headers: {} };
  const line = server.frame(first.envelope, 0, headers);
  assert.throws(() => second.openFrame(line));
  assert.deepEqual(first.openFrame(line), headers);
  const changed = Buffer.from(server.frame(first.envelope, 1, { type: "chunk", data: "hello" }), "base64");
  changed[3] ^= 1;
  assert.throws(() => first.openFrame(changed.toString("base64")));
});

test("base64 of every byte value survives the trip", () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => (i * 7 + (i >> 8)) & 255);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"));
});
