#!/usr/bin/env node
// Publish the server's current public URL so paired phones can find it after the
// tunnel address changes.
//
//   node server/publish.mjs https://<current>.trycloudflare.com
//
// Writes publicUrl into data/config.json and, unless discovery is "off",
// updates a secret GitHub gist (created on first run via `gh`) holding
// {"url": "..."}. The gist's raw URL is the stable discovery URL baked into
// pair links. The gist only reveals the tunnel address; every request to the
// server still needs a device token.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SERVANT_DATA_DIR || path.join(HERE, "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const FILE = "hub.json";

const url = process.argv[2];
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(url || "")) {
  console.error("usage: publish.mjs https://host");
  process.exit(2);
}

const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const changed = cfg.publicUrl !== url;
cfg.publicUrl = url;

function gh(args, input) {
  return execFileSync("gh", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

if (cfg.discovery !== "off") {
  const body = JSON.stringify({ url, updatedAt: new Date().toISOString() });
  if (!cfg.gistId) {
    const tmp = path.join(os.tmpdir(), FILE);
    fs.writeFileSync(tmp, body);
    const out = gh(["gist", "create", "--desc", "Servant hub address", tmp]);
    cfg.gistId = out.split("/").pop();
    fs.rmSync(tmp, { force: true });
  } else if (changed) {
    gh(["api", "-X", "PATCH", `gists/${cfg.gistId}`, "--input", "-"], JSON.stringify({ files: { [FILE]: { content: body } } }));
  }
  if (!cfg.discoveryUrl) {
    const owner = gh(["api", `gists/${cfg.gistId}`, "--jq", ".owner.login"]);
    cfg.discoveryUrl = `https://gist.githubusercontent.com/${owner}/${cfg.gistId}/raw/${FILE}`;
  }
}

const tmp = `${CONFIG_FILE}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
fs.renameSync(tmp, CONFIG_FILE);
console.log(changed ? `published ${url}` : `unchanged ${url}`);
