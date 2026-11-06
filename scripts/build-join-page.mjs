#!/usr/bin/env node
// Writes the invite page for servant.com: node scripts/build-join-page.mjs [--ios URL] [--android URL]
// The web deploy (expo export) copies app/public into the site, so servant.com/join serves it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { joinPage } from "../server/join-page.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = n => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const dir = path.join(root, "app", "public", "join");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "index.html"), joinPage({ ios: arg("ios") || "https://testflight.apple.com/join/qn5JQPyS", android: arg("android") }));
console.log("wrote", path.join(dir, "index.html"));
