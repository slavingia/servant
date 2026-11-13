import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { testFetch } from "./encrypted-test-client.mjs";
import { TERMS_VERSION, TERMS_ITEMS } from "./terms.mjs";
import { DEFAULT_PRIMARY_COLOR, normalizeTheme } from "./theme.mjs";

test("theme accepts opaque hex colors and ignores unsupported configuration", () => {
  assert.deepEqual(normalizeTheme({ primaryColor: " #7c3aed " }), { primaryColor: "#7C3AED" });
  assert.deepEqual(normalizeTheme({ primaryColor: "#a3f" }), { primaryColor: "#AA33FF" });
  for (const raw of [undefined, null, [], "#7C3AED", {}, { primaryColor: null }, { primaryColor: 123 },
    { primaryColor: "purple" }, { primaryColor: "#1234" }, { primaryColor: "#12345678" },
    { primaryColor: "123456" }, { primaryColor: "#GGGGGG" }, { primaryColor: "url(example.gov)" }]) {
    assert.deepEqual(normalizeTheme(raw), { primaryColor: DEFAULT_PRIMARY_COLOR });
  }
  assert.deepEqual(normalizeTheme({ primaryColor: "#000", extra: "never exposed" }), { primaryColor: "#000000" });
  assert.deepEqual(normalizeTheme({ primaryColor: "#fff" }), { primaryColor: "#FFFFFF" });
});

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-theme-"));
process.env.SERVANT_DATA_DIR = directory;
let server, base, createInvite;
function configure(theme) {
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({
    host: "127.0.0.1", port: 0, name: "Theme test", theme,
    upstreams: { owner: { url: "http://127.0.0.1:1", key: "test" }, member: { url: "http://127.0.0.1:1", key: "test" } },
  }));
}

before(async () => {
  configure();
  const mod = await import("./server.mjs");
  createInvite = mod.createInvite;
  server = await mod.startServer();
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await server?.shutdown();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function api(route, { method = "GET", token, body } = {}) {
  const response = await testFetch(directory, base + route, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}

test("config theme reaches public metadata, pairing, device linking and account refresh without a restart", async () => {
  const blue = { primaryColor: DEFAULT_PRIMARY_COLOR };
  for (const route of ["/v1/server", "/v1/hub"]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).theme, blue);
  }

  configure({ primaryColor: "#7c3aed", secret: "not theme metadata" });
  const purple = { primaryColor: "#7C3AED" };
  assert.deepEqual((await api("/v1/server")).theme, purple);
  const paired = await api("/v1/pair", { method: "POST", body: {
    code: createInvite({ name: "Pat Tester", role: "member" }),
    device: "Test phone", terms: { version: TERMS_VERSION, items: TERMS_ITEMS },
  } });
  assert.deepEqual(paired.theme, purple);
  assert.deepEqual((await api("/v1/me", { token: paired.token })).theme, purple);

  const link = await api("/v1/device-links", { method: "POST", body: { device: "Test Mac" } });
  await api(`/v1/device-links/${link.id}/approve`, { method: "POST", token: paired.token, body: {} });
  const linked = await api(`/v1/device-links/${link.id}/poll`, { method: "POST", body: { secret: link.secret } });
  assert.equal(linked.status, "approved");
  assert.deepEqual(linked.theme, purple);

  configure({ primaryColor: "#0a8" });
  assert.deepEqual((await api("/v1/me", { token: paired.token })).theme, { primaryColor: "#00AA88" });
  configure({ primaryColor: "invalid" });
  assert.deepEqual((await api("/v1/me", { token: linked.token })).theme, blue);
  configure();
  assert.deepEqual((await api("/v1/me", { token: paired.token })).theme, blue);
});

// The pages the server renders use the same colors as the app, for the default blue and for any workspace color.
// The server cannot import the app's palette at run time, so it repeats the derivation; this keeps the two equal.
test("the server's page colors are the app's, in both appearances and for any workspace color", async () => {
  const { pageColors } = await import("./theme.mjs");
  const { createColors } = await import("../app/src/lib/theme-colors.ts");
  for (const seed of [undefined, "#0071BC", "#7C3AED", "#FFCC00", "#000000", "#0B6E4F", "#E11D48", "#ABC"]) {
    for (const scheme of ["light", "dark"]) {
      const page = pageColors(scheme, seed), app = createColors(scheme, seed);
      assert.ok(Object.keys(page).length >= 15, "found the page colors");
      for (const [name, value] of Object.entries(page)) assert.equal(value, app[name], `${name} for ${seed ?? "the default"} in ${scheme}`);
    }
  }
});
