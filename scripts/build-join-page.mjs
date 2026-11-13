#!/usr/bin/env node
// Writes the public site and invite page for web exports. Optional flags:
// --mac URL --ios URL --android URL --web URL --contact-email ADDRESS --footer TEXT
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { joinPage } from "../server/join-page.mjs";
import { landingPage, supportPage } from "../server/public-page.mjs";
import { privacyPage } from "../server/privacy-page.mjs";
import { termsPage } from "../server/terms-page.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = n => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const downloads = Object.fromEntries(["mac", "ios", "android"].filter(n => arg(n)).map(n => [n, arg(n)]));
const config = { contactEmail: arg("contact-email"), footer: arg("footer") };
// Keep Expo's generated index.html as the app entry point. The host rewrites only
// / to site/index.html, so /welcome and signed-in deep links still open the app.
const pages = { site: landingPage(config), support: supportPage(config), privacy: privacyPage(config), terms: termsPage(config), join: joinPage(downloads, arg("web"), config.footer) };
for (const [name, html] of Object.entries(pages)) {
  const dir = path.join(root, "app", "public", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), html);
  console.log("wrote", path.relative(root, path.join(dir, "index.html")));
}
