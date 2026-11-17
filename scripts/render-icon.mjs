#!/usr/bin/env node
// Draw app/assets/icon.svg (the layered source) into app/assets/icon.png, 1024 x 1024 with no transparency.
// Then run scripts/make-icons.py to cut the Android, notification and favicon files from it.
//
//   npm ci --prefix desktop        # once: this uses the Mac app's Playwright
//   node scripts/render-icon.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const { chromium } = createRequire(path.join(root, "desktop", "package.json"))("playwright");
const svg = fs.readFileSync(path.join(root, "app/assets/icon.svg"), "utf8");
const out = path.join(root, "app/assets/icon.png");

// Playwright's own browser if it is installed (npx playwright install), otherwise the Chrome already on the machine.
const browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(`<style>html,body{margin:0;background:#000}</style>${svg}`);
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1024, height: 1024 }, omitBackground: false });
await browser.close();
console.log(`${out}: 1024 x 1024`);
