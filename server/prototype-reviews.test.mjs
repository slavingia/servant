// Sharing a prototype with a business owner: the store, and the review mode a served page gets.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cleanPage, createPrototypeReviews, maskEmail, reviewDomains, SESSION_MS } from "./prototype-reviews.mjs";
import { servePrototype, _resetLimits } from "./prototypes.mjs";
import { reviewPage, reviewPageHeaders } from "./prototype-review-page.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-reviews-"));
  const time = { now: 1_800_000_000_000 };
  const file = path.join(dir, "prototype-reviews.db");
  const store = createPrototypeReviews(file, { clock: () => time.now });
  return { store, time, file, dir, done: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const fails = (fn, status, code) => assert.throws(fn, error => error.status === status && (!code || error.code === code), `expected ${status} ${code || ""}`);
const base = { chatId: "cht_1", folder: "proto-aaaa1111", title: "Refund tracker", by: "usr_ana", domains: ["example.gov"] };

test("a prototype is shared to a work address only, and sharing again replaces the link", () => {
  const { store, done } = setup();
  fails(() => store.share({ ...base, email: "not an email" }), 400, "email_invalid");
  fails(() => store.share({ ...base, email: "jo@example.com" }), 403, "email_not_allowed");
  fails(() => store.share({ ...base, email: "jo@example.gov.evil.com" }), 403, "email_not_allowed");
  assert.deepEqual(reviewDomains({ domains: [] }), ["gov", "mil"], "with no domains set, government and military addresses only");
  assert.deepEqual(reviewDomains({ domains: ["example.gov"] }), ["example.gov"]);
  fails(() => store.share({ ...base, email: "jo@example.org", domains: reviewDomains({ domains: [] }) }), 403, "email_not_allowed");
  assert.equal(store.share({ ...base, chatId: "cht_other", email: "jo@agency.gov", domains: reviewDomains({ domains: [] }) }).share.email, "jo@agency.gov");

  const first = store.share({ ...base, email: " Jo.Park@Example.gov " });
  assert.equal(first.share.email, "jo.park@example.gov");
  assert.match(first.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(store.byToken(first.token).id, first.share.id);
  assert.equal(store.byToken("nope"), null);
  const second = store.share({ ...base, email: "jo.park@example.gov" });
  assert.equal(store.byToken(first.token), null, "the earlier link stops working");
  assert.equal(store.byToken(second.token).id, second.share.id);
  assert.deepEqual(store.forChat("cht_1").map(s => !!s.endedAt), [false, true], "both are on record, newest first");
  assert.equal(maskEmail("jo.park@example.gov"), "j***@example.gov");
  done();
});

test("only a confirmed session opens a share, for twelve hours, and ending the share closes it", () => {
  const { store, time, file, done } = setup();
  const { share, token } = store.share({ ...base, email: "jo@example.gov" });
  const other = store.share({ ...base, email: "sam@example.gov" });
  assert.equal(store.session(token, ""), null);
  assert.equal(store.session(token, "made-up"), null);
  const session = store.startSession(share.id);
  assert.equal(session.expiresAt, time.now + SESSION_MS);
  assert.equal(store.session(token, session.secret).id, share.id);
  assert.equal(store.session(other.token, session.secret), null, "a session is for its own share");
  assert.equal(fs.readFileSync(file).includes(session.secret), false, "only its hash is on disk");
  assert.equal(fs.readFileSync(file).includes(token), false, "and only the link's hash");
  assert.ok(store.get(share.id).verifiedAt);
  time.now += SESSION_MS + 1;
  assert.equal(store.session(token, session.secret), null, "after twelve hours another code is needed");
  const again = store.startSession(share.id);
  assert.equal(store.end(share.id, "cht_wrong", "usr_ana"), false, "only from its own chat");
  assert.equal(store.end(share.id, "cht_1", "usr_ana"), true);
  assert.equal(store.session(token, again.secret), null);
  assert.equal(store.byToken(token), null);
  assert.equal(store.end(share.id, "cht_1", "usr_ana"), false);
  store.endChat("cht_1", "usr_ana");
  assert.equal(store.byToken(other.token), null, "deleting the chat ends every share of it");
  done();
});

test("a comment keeps where it was made, and comments are never deleted", () => {
  const { store, file, done } = setup();
  const { share } = store.share({ ...base, email: "jo@example.gov" });
  const sam = store.share({ ...base, email: "sam@example.gov" }).share;
  fails(() => store.comment(share, { page: "index.html", x: 0.5, y: 0.5, text: "   " }), 400);
  fails(() => store.comment(share, { page: "index.html", x: 0.5, y: 0.5, text: "x".repeat(2001) }), 400);
  const c = store.comment(share, { page: "/p/proto-aaaa1111/plans/compare.html?review=1", x: 1.7, y: -3, anchor: "  Pay   now " + "x".repeat(200), text: " The amount is wrong\r\nhere. " });
  assert.deepEqual([c.page, c.x, c.y, c.email, c.text], ["plans/compare.html", 1, 0, "jo@example.gov", "The amount is wrong\nhere."]);
  assert.equal(c.anchor.length, 120);
  assert.ok(c.anchor.startsWith("Pay now x"));
  store.comment(sam, { page: "", x: "0.25", y: 0.75, anchor: "", text: "Looks right" });
  assert.deepEqual(store.comments({ chatId: "cht_1" }).map(x => [x.email, x.page]), [["jo@example.gov", "plans/compare.html"], ["sam@example.gov", "index.html"]]);
  assert.deepEqual(store.comments({ shareId: sam.id }).map(x => x.text), ["Looks right"], "a reviewer's own comments only");
  store.linkTodo(c.id, "todo_1");
  assert.equal(store.comments({ shareId: share.id })[0].todoId, "todo_1");
  store.end(share.id, "cht_1", "usr_ana");
  assert.equal(store.comments({ chatId: "cht_1" }).length, 2, "ending a share keeps its comments");
  for (const [given, page] of [["/p/proto-aaaa1111/", "index.html"], ["a/b.html#x", "a/b.html"], ["../secret", "index.html"], ["a/.hidden", "index.html"], ["<script>", "index.html"], [null, "index.html"]]) assert.equal(cleanPage(given, "proto-aaaa1111"), page, String(given));
  const raw = new DatabaseSync(file);
  assert.throws(() => raw.exec("DELETE FROM comments"), /kept/);
  raw.close();
  done();
});

test("a page asked for with review=1 gets the comment script; without it, it doesn't", async () => {
  const { dir, done } = setup();
  _resetLimits();
  fs.mkdirSync(path.join(dir, "proto-aaaa1111"));
  fs.writeFileSync(path.join(dir, "proto-aaaa1111", "index.html"), "<html><body><h1>Refund tracker</h1></body></html>");
  fs.writeFileSync(path.join(dir, "proto-aaaa1111", "app.js"), "console.log(1)");
  const server = http.createServer((req, res) => { if (!servePrototype(req, res, new URL(req.url, "http://x"), { dir })) { res.writeHead(404); res.end(); } });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const get = async p => { const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`); return { text: await r.text(), csp: r.headers.get("content-security-policy") }; };
  const plain = await get("/p/proto-aaaa1111/");
  assert.equal(plain.text.includes("data-servant-review"), false);
  const review = await get("/p/proto-aaaa1111/?review=1");
  assert.ok(review.text.includes("<script data-servant-review>"));
  assert.ok(review.text.includes('"contextmenu"') && review.text.includes("prototype-review") && review.text.includes("prototype-pins"));
  assert.ok(review.text.indexOf("data-servant-review") < review.text.lastIndexOf("</body>"), "inside the page's body");
  assert.match(review.csp, /^sandbox allow-scripts/, "still sandboxed away from the server");
  assert.equal((await get("/p/proto-aaaa1111/app.js?review=1")).text, "console.log(1)", "only pages, never scripts or styles");
  server.close(); done();
});

test("the review page shows nothing typed by a person as markup, and loads nothing from elsewhere", () => {
  const html = reviewPage({ nonce: "abc", title: `<img src=x onerror=alert(1)> "Refunds"`, sharedBy: "Ana <b>Ruiz</b>", masked: "j***@example.gov", serverName: "Example & team" });
  assert.equal(html.includes("<img src=x"), false);
  assert.equal(html.includes("<b>Ruiz</b>"), false);
  assert.ok(html.includes("Ana &lt;b&gt;Ruiz&lt;/b&gt; shared a prototype with you"));
  assert.ok(html.includes("j***@example.gov"));
  assert.ok(html.includes('<script nonce="abc">') && html.includes('<style nonce="abc">'));
  assert.equal(/ style="/.test(html), false, "no inline styles: the policy would drop them");
  assert.equal(/ on[a-z]+="/.test(html), false, "no inline handlers");
  const ended = reviewPage({ nonce: "abc", ended: true });
  assert.ok(ended.includes("This link doesn't work"));
  assert.equal(ended.includes("<script"), false);
  const csp = reviewPageHeaders("abc")["Content-Security-Policy"];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-abc'/);
  assert.match(csp, /frame-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
});
