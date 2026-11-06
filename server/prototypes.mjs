// Prototyping: each chat's prototype is plain files in <data>/prototypes/<folder>/, served by this server at
// /p/<folder>/ (through the same tunnel as everything else). No git, no GitHub Pages. The design kit
// (components/ and assets/ of the design-prototypes project's checkout) is served beside it at /p/components/ and
// /p/assets/, so the starter page's `../components/components.css` links work unchanged.
// Folder names are random and unguessable: anyone with the link can view the page, nobody can list them.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mimeFor } from "./ota.mjs";

export const FOLDER = /^[a-z0-9][a-z0-9-]{2,40}$/;
const KIT = new Set(["components", "assets"]);
const TYPES = { html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", json: "application/json", svg: "image/svg+xml", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", ico: "image/x-icon", pdf: "application/pdf", csv: "text/csv; charset=utf-8" };
const typeFor = file => { const ext = path.extname(file).slice(1).toLowerCase(); return TYPES[ext] || mimeFor(ext); };

// A page and its pictures and scripts come to maybe 50 requests, so 600 a minute per visitor never gets in the way
// of a person (or a few people behind one office address) but stops someone hammering the link or guessing folders.
const LIMIT = 600, WINDOW = 60_000, MAX_FILE = 25 * 1024 * 1024;
const hits = new Map();
function allowed(ip, at = Date.now()) {
  if (hits.size > 5000) for (const [k, v] of hits) if (at - v.start > WINDOW) hits.delete(k);
  const h = hits.get(ip);
  if (!h || at - h.start > WINDOW) { hits.set(ip, { start: at, n: 1 }); return true; }
  return ++h.n <= LIMIT;
}
export const _resetLimits = () => hits.clear();

/** Delete a chat's prototype files (when the chat is deleted). Only ever touches a folder directly inside `dir`. */
export function removePrototype(dir, folder) {
  if (!FOLDER.test(folder || "")) return;
  try { fs.rmSync(path.join(dir, folder), { recursive: true, force: true }); } catch { /* already gone */ }
}

/** A new unguessable folder name for a chat's prototype. */
export const newFolder = () => `proto-${crypto.randomBytes(9).toString("hex")}`;

/**
 * Serve GET/HEAD /p/<folder>/<file…>. Pages run in a sandbox with no access to this server's origin (so a
 * prototype can't read anything from the API); static files are public. Returns false when the URL isn't ours.
 */
export function servePrototype(req, res, url, { dir, kitDir, ip = "" }) {
  if (!url.pathname.startsWith("/p/")) return false;
  const send = (status, body, headers = {}) => { res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers }); res.end(req.method === "HEAD" ? undefined : body); return true; };
  if (!allowed(ip)) return send(429, "Too many requests. Try again in a minute.", { "Retry-After": "60" });
  if (req.method !== "GET" && req.method !== "HEAD") return send(405, "Method not allowed", { Allow: "GET, HEAD" });
  let parts;
  try { parts = url.pathname.slice(3).split("/").map(decodeURIComponent); } catch { return send(404, "Not found"); }
  const [first, ...rest] = parts;
  const root = KIT.has(first) ? (kitDir ? path.join(kitDir, first) : null) : FOLDER.test(first || "") ? path.join(dir, first) : null;
  if (!root || rest.some(p => p === ".." || p.includes("\0") || p.startsWith("."))) return send(404, "Not found");
  // Folder URLs need the trailing slash so relative links (../components/) land in the right place.
  if (!KIT.has(first) && rest.length === 0) { res.writeHead(301, { Location: `${url.pathname}/${url.search}`, "Cache-Control": "no-store" }); res.end(); return true; }
  let file = path.join(root, ...rest.filter(Boolean));
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    const real = fs.realpathSync(file), base = fs.realpathSync(root);
    if (real !== base && !real.startsWith(base + path.sep)) return send(404, "Not found");
    if (fs.statSync(real).size > MAX_FILE) return send(413, "File too large");
    const body = fs.readFileSync(real);
    return send(200, body, {
      "Content-Type": typeFor(real),
      "Content-Length": String(body.length),
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals; default-src 'self' data: blob: 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; form-action 'self'; base-uri 'self'",
    });
  } catch { return send(404, "Not found"); }
}
