import test from "node:test";
import assert from "node:assert/strict";
import { deviceLinkFromParams, deviceLinkMatchesAccount, deviceLinkUrl, parseDeviceLink } from "./device-link.ts";

const link = { id: "a".repeat(43), serverKey: "02" + "ab".repeat(32) };

test("computer QR contains only the approval handle and pinned public key", () => {
  const encoded = deviceLinkUrl({ ...link, secret: "never-serialize-this" } as typeof link);
  assert.deepEqual(parseDeviceLink(encoded), link);
  assert.equal(encoded.includes("secret"), false);
  assert.equal(encoded.includes("never-serialize"), false);
});

test("rejects redirected, ambiguous, malformed and credential-bearing computer codes", () => {
  const encoded = deviceLinkUrl(link);
  for (const input of [
    encoded.replace("servant:", "https:"), encoded.replace("link-device?", "link-device/path?"),
    encoded + "&server=https://attacker.example", encoded + "&secret=secret", encoded + "&key=" + link.serverKey,
    encoded + "#fragment", encoded.replace("link-device", "user@link-device"),
    encoded.replace(link.id, "short"), encoded.replace(link.serverKey, "bad"),
    "Scan this " + encoded,
  ]) assert.equal(parseDeviceLink(input), null, input);
  assert.equal(deviceLinkFromParams([link.id], link.serverKey), null);
  assert.equal(deviceLinkFromParams(link.id, [link.serverKey]), null);
});

test("phone authorization requires its existing workspace pin", () => {
  assert.equal(deviceLinkMatchesAccount(link, { serverKey: link.serverKey }), true);
  assert.equal(deviceLinkMatchesAccount(link, { serverKey: "03" + "cd".repeat(32) }), false);
  assert.equal(deviceLinkMatchesAccount(link, {}), false);
  assert.equal(deviceLinkMatchesAccount(link, null), false);
});
