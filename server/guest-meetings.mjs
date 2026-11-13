// Guests in a meeting: someone without an account joins from a link, Teams-style.
//
// A signed-in member asks for a guest link (https://<server>/m/<code>) during a call. A guest opens
// it in any browser, types a name and knocks. The host (whoever started the call) admits or denies
// them from the app. Admitted guests send and receive media through the same hosted call as
// everyone else (meetings.mjs); they are recorded and transcribed like everyone else.
//
// A guest is not a user: no account, no device token, no row in users. A guest holds an opaque token
// that works only on the /g/<code>/… routes below, only for one meeting, only while it is live (and
// at most six hours). Device tokens don't work here and guest tokens don't work on /v1 (the server
// looks them up in two different places). Everything a guest can see is built by guestView(): an
// allow-list of fields, never the member view.
//
// Live guest state is in memory and goes away with the meeting. Only a guest's display name is kept
// in the meetings database, so the transcript and notes written after the call can still say who
// spoke. The whole feature is off unless config.guestMeetings is true.
import crypto from "node:crypto";
import { guestPage, notFoundPage, pageHeaders } from "./guest-page.mjs";

export const MAX_GUESTS = 8;                       // admitted guests in one meeting
export const MAX_PENDING = 10;                     // waiting to be let in, per meeting
export const MAX_KNOCKS = 50;                      // knocks per meeting, ever
export const KNOCKS_PER_IP = 10;                   // per ten minutes, per visitor
export const KNOCK_WINDOW_MS = 10 * 60 * 1000;
export const POLLS_PER_IP = 600;                   // all guest requests per minute, per visitor
export const POLL_WINDOW_MS = 60 * 1000;
export const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;    // a guest token never outlives this
export const ENDED_KEEP_MS = 10 * 60 * 1000;       // after the call, a token still answers "ended" this long
export const DENIED_WAIT_MS = 60 * 1000;           // after a deny or remove, that address gets one knock a minute on that meeting…
export const DENIED_WINDOW_MS = 10 * 60 * 1000;    // …for this long (a colleague behind the same office address is only slowed, not shut out)
export const MAX_NAME = 40;
const MAX_BODY = 96 * 1024;                        // an SDP offer is a few KB
const CODE = /^[A-Za-z0-9_-]{20}$/;                // 15 random bytes, base64url: 120 bits
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const newId = (p) => `${p}_${crypto.randomBytes(9).toString("base64url")}`;

export const isGuestId = (id) => typeof id === "string" && id.startsWith("guest_");

/**
 * A display name a guest typed, made safe for every place it shows up: the host's screen, the
 * guest page, the transcript and the notes prompt. Trimmed, one space between words, no control or
 * direction-changing characters, no HTML or markdown or quote characters, no brackets (so nobody
 * can write their own "(guest)" or "[host]"), no @ or # (mentions and rooms), at most 40 characters,
 * and it must contain a letter or a digit. Returns null when nothing usable is left.
 */
export function cleanName(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.normalize("NFKC").replace(/\s+/g, " ")
    // Control characters, soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width and direction
    // marks (U+200B-200F), line and paragraph separators and bidi embeddings and overrides (U+2028-202E), word
    // joiner and invisible operators (U+2060-206F), the byte order mark, interlinear annotation marks.
    .replace(/[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/g, "")
    .replace(/[<>"`\\\[\]{}()|*_#~@:;=\/$%^+]/g, "")
    .replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
  return s && /[\p{L}\p{N}]/u.test(s) ? s : null;
}

/**
 * @param {object} o
 * @param {() => boolean} o.enabled        config.guestMeetings
 * @param {() => string} o.publicUrl       where guests reach this server
 * @param {() => number} [o.now]
 */
export function createGuestMeetings({ enabled, publicUrl, now = Date.now, log = console }) {
  let meetings = null;
  let nameOf = null, saveName = null;
  /** @type {Map<string, {code:string, on:boolean, codes:Set<string>, knocks:number, createdAt:number}>} meetingId -> link */
  const links = new Map();
  /** @type {Map<string, string>} every code ever issued -> meetingId (old codes still route a guest's own token) */
  const byCode = new Map();
  /** @type {Map<string, any>} guestId -> guest */
  const guests = new Map();
  /** @type {Map<string, string>} sha256(token) -> guestId */
  const byToken = new Map();
  const names = new Map();
  const knocks = new Map(), polls = new Map(), denied = new Map();
  const timer = setInterval(sweep, 60 * 1000);
  timer.unref?.();

  function attach(m) {
    meetings = m;
    m.db.exec("CREATE TABLE IF NOT EXISTS meeting_guests (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, name TEXT NOT NULL)");
    nameOf = m.db.prepare("SELECT name FROM meeting_guests WHERE id = ?");
    saveName = m.db.prepare("INSERT OR REPLACE INTO meeting_guests VALUES (?, ?, ?)");
  }

  // ---- what meetings.mjs asks ----
  /** The name shown for a guest everywhere a user's name would show, with "(guest)" outside the name. */
  function person(userId) {
    if (!isGuestId(userId)) return null;
    let name = names.get(userId);
    if (name === undefined) { name = nameOf?.get(userId)?.name || "Guest"; names.set(userId, name); }
    return { id: userId, name: `${name} (guest)`, guest: true };
  }
  const admitted = (meetingId, userId) => { const g = guests.get(userId); return !!g && g.meetingId === meetingId && g.status === "admitted" && !expired(g); };
  /** Extra fields on a signed-in member's meeting view. Never anything for a guest id. */
  function memberView(m, userId) {
    if (isGuestId(userId)) return null;
    if (!enabled()) return { guestsEnabled: false };
    return { guestsEnabled: true, guests: list(m.id, m.started_by === userId) };
  }
  // The call is over: the page and new knocks are dead at once (the call is no longer live); the link
  // record stays a few minutes so guests still on the page hear "ended" rather than "unknown token".
  function ended(meetingId) {
    const link = links.get(meetingId);
    if (link) { link.on = false; link.endedAt ??= now(); }
    for (const g of guests.values()) if (g.meetingId === meetingId && g.status !== "ended") { g.status = "ended"; g.expiresAt = Math.min(g.expiresAt, now() + ENDED_KEEP_MS); }
  }

  // ---- bookkeeping ----
  const expired = (g) => now() >= g.expiresAt;
  function sweep() {
    for (const [id, g] of guests) if (expired(g)) { guests.delete(id); byToken.delete(g.tokenHash); }
    for (const [id, link] of links) if ((link.endedAt && now() - link.endedAt > ENDED_KEEP_MS) || (!link.endedAt && !live(id))) { for (const c of link.codes) byCode.delete(c); links.delete(id); }
    const t = now();
    for (const [k, list] of knocks) if (!list.some(x => t - x < KNOCK_WINDOW_MS)) knocks.delete(k);
    for (const [k, v] of polls) if (t - v.start > POLL_WINDOW_MS) polls.delete(k);
    for (const [k, d] of denied) if (t >= d.until) denied.delete(k);
  }
  function pollAllowed(ip) {
    if (polls.size > 5000) sweep();
    const h = polls.get(ip);
    if (!h || now() - h.start > POLL_WINDOW_MS) { polls.set(ip, { start: now(), n: 1 }); return true; }
    return ++h.n <= POLLS_PER_IP;
  }
  function knockAllowed(ip) {
    const list = (knocks.get(ip) || []).filter(t => now() - t < KNOCK_WINDOW_MS);
    list.push(now());
    knocks.set(ip, list);
    if (knocks.size > 5000) sweep();
    return list.length <= KNOCKS_PER_IP;
  }
  const slow = (meetingId, ip) => denied.set(`${meetingId}|${ip}`, { until: now() + DENIED_WINDOW_MS, nextAt: now() + DENIED_WAIT_MS });
  const live = (meetingId) => !!meetings?.calls.has(meetingId);
  const ofMeeting = (meetingId) => [...guests.values()].filter(g => g.meetingId === meetingId && !expired(g));
  const participantsOf = (meetingId, guestId) => [...(meetings.calls.get(meetingId)?.participants.values() || [])].filter(p => p.userId === guestId);
  const guestSeats = (meetingId) => new Set([...(meetings.calls.get(meetingId)?.participants.values() || [])].filter(p => !p.screen && isGuestId(p.userId)).map(p => p.userId)).size;
  function list(meetingId, forHost) {
    const all = ofMeeting(meetingId);
    const pending = all.filter(g => g.status === "pending");
    const present = all.filter(g => g.status === "admitted");
    return {
      on: !!links.get(meetingId)?.on,
      count: present.length, pendingCount: pending.length,
      pending: forHost ? pending.map(g => ({ id: g.id, name: g.name, knockedAt: g.knockedAt })) : [],
      present: present.map(g => ({ id: g.id, name: g.name, connected: participantsOf(meetingId, g.id).some(p => !p.screen) })),
    };
  }
  const linkUrl = (link) => `${String(publicUrl() || "").replace(/\/+$/, "")}/m/${link.code}`;
  function issueCode(meetingId, link) {
    const code = crypto.randomBytes(15).toString("base64url");
    link.code = code; link.codes.add(code); byCode.set(code, meetingId);
    return link;
  }

  // Every call into the hosted call goes through meetings.handle with a guest identity, so a guest
  // uses exactly the member protocol (join, watch, state, leave) and none of the rest.
  async function sfu(g, method, sub, body) {
    let result;
    const user = { id: g.id, name: g.name, guest: true };
    await meetings.handle({}, {}, { user, method, parts: ["v1", "meetings", g.meetingId, sub], readBody: async () => body,
      send: (_r, status, b) => { result = { status, body: b }; },
      fail: (_r, status, code, message) => { result = { status, body: { error: { code, message } } }; } })
      .catch(e => { result = { status: e.status || 500, body: { error: { code: e.status ? e.code : "server_error", message: e.status ? e.message : "Something went wrong on the server" } } }; });
    return result;
  }

  /** What an admitted guest may know: who is on the call and how to connect. Nothing else. */
  function guestView(g) {
    const v = meetings.view(g.meetingId, g.id);
    const hostId = v.startedBy.id;
    return {
      state: "admitted", status: "live",
      hostPresent: v.participants.some(p => !p.screen && p.user.id === hostId),
      iceServers: v.iceServers,
      participants: v.participants.map(p => ({
        id: p.id, name: p.user.name, guest: !!p.user.guest, publishing: p.publishing, hasVideo: p.hasVideo, hasAudio: p.hasAudio, muted: !!p.muted,
        ...(p.screen ? { screen: true } : {}), ...(p.you ? { you: true, muteSeq: p.muteSeq || 0 } : {}),
      })),
    };
  }
  const hostPresent = (meetingId) => { const v = meetings.view(meetingId, null); return v.participants.some(p => !p.screen && p.user.id === v.startedBy.id); };

  // ---- host side (signed in, over /v1/meetings/:id/…; meetings.mjs checked membership) ----
  async function handleHost(req, res, { user, method, meeting, sub, guestId, send, fail, readBody }) {
    if (!enabled()) return fail(res, 404, "not_found", "Guests aren't turned on for this server");
    const isHost = meeting.started_by === user.id;
    const id = meeting.id;
    if (sub === "guest-link") {
      if (method !== "POST") return fail(res, 405, "method_not_allowed", "Not allowed");
      const action = String((await readBody(req))?.action || "create");
      if (!live(id)) return fail(res, 409, "meeting_ended", "This meeting has ended");
      if (!publicUrl()) return fail(res, 409, "no_public_url", "This server has no public address yet, so guests can't reach it");
      let link = links.get(id);
      if (action === "create") {
        if (!link) { link = issueCode(id, { code: "", on: true, codes: new Set(), knocks: 0, createdAt: now() }); links.set(id, link); }
      } else {
        if (!isHost) return fail(res, 403, "not_host", "Only the person who started the call can change the guest link");
        if (!link) return fail(res, 404, "not_found", "There is no guest link yet");
        if (action === "off") link.on = false;
        else if (action === "on") link.on = true;
        else if (action === "rotate") { issueCode(id, link); link.on = true; }
        else return fail(res, 400, "bad_action", "Choose create, on, off or rotate");
      }
      return send(res, 200, { url: linkUrl(link), on: link.on });
    }
    if (sub !== "guests") return fail(res, 404, "not_found", "Not found");
    if (!guestId) {
      if (method !== "GET") return fail(res, 405, "method_not_allowed", "Not allowed");
      return send(res, 200, { guests: list(id, isHost) });
    }
    if (method !== "POST") return fail(res, 405, "method_not_allowed", "Not allowed");
    const action = String((await readBody(req))?.action || "");
    if (!isHost) return fail(res, 403, "not_host", "Only the person who started the call can let guests in or remove them");
    const g = guests.get(String(guestId));
    if (!g || g.meetingId !== id || expired(g)) return fail(res, 404, "not_found", "That guest is gone");
    if (action === "admit") {
      if (g.status !== "pending") return fail(res, 409, "not_pending", "That guest isn't waiting");
      if (!live(id)) return fail(res, 409, "meeting_ended", "This meeting has ended");
      if (ofMeeting(id).filter(x => x.status === "admitted").length >= MAX_GUESTS) return fail(res, 409, "guests_full", `At most ${MAX_GUESTS} guests can be in a meeting`);
      g.status = "admitted";
    } else if (action === "deny") {
      if (g.status !== "pending") return fail(res, 409, "not_pending", "That guest isn't waiting");
      g.status = "denied"; slow(id, g.ip);
    } else if (action === "remove") {
      if (g.status !== "admitted" && g.status !== "pending") return fail(res, 409, "not_present", "That guest isn't in the meeting");
      g.status = "removed"; slow(id, g.ip);
      for (const p of participantsOf(id, g.id)) await meetings.kick(id, p.id);
    } else if (action === "mute") {
      for (const p of participantsOf(id, g.id)) if (!p.screen) { p.muted = true; p.muteSeq = (p.muteSeq || 0) + 1; }
    } else return fail(res, 400, "bad_action", "Choose admit, deny, remove or mute");
    return send(res, 200, { guests: list(id, true) });
  }

  // ---- guest side (plain HTTPS, no account) ----
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error("Too long"), { status: 413 })); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(Object.assign(new Error("Body must be JSON"), { status: 400 })); } });
    req.on("error", reject);
  });
  const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };
  const json = (res, status, body, extra = {}) => { res.writeHead(status, { ...JSON_HEADERS, ...extra }); res.end(JSON.stringify(body)); return true; };
  const refuse = (res, status, code, message, extra) => json(res, status, { error: { code, message } }, extra);
  const html = (res, status, page, nonce) => { res.writeHead(status, pageHeaders(nonce)); res.end(page); return true; };
  function tokenOf(req) {
    const h = String(req.headers.authorization || "");
    if (!h.startsWith("Bearer ")) return null;
    const hash = sha256(h.slice(7).trim());
    const id = byToken.get(hash);
    const g = id && guests.get(id);
    // Found by hash; compare the stored hash in constant time anyway.
    if (!g || !crypto.timingSafeEqual(Buffer.from(g.tokenHash), Buffer.from(hash))) return null;
    return expired(g) ? null : g;
  }

  /** GET /m/:code (the page) and the /g/:code/… API. Returns false when the URL isn't ours. */
  async function handle(req, res, url, { ip = "" } = {}) {
    const page = /^\/m\/([^/]+)\/?$/.exec(url.pathname);
    const api = /^\/g\/([^/]+)\/(knock|state|join|watch|state-report|leave)$/.exec(url.pathname);
    if (!page && !api) return false;
    const nonce = crypto.randomBytes(16).toString("base64");
    if (!pollAllowed(ip)) return page ? html(res, 429, notFoundPage(nonce, "Too many requests. Wait a minute and try again."), nonce) : refuse(res, 429, "rate_limited", "Too many requests. Wait a minute and try again", { "Retry-After": "60" });
    // A broken %-escape in a public link is just a link that doesn't exist (not an uncaught URIError and a 500).
    let code;
    try { code = decodeURIComponent((page || api)[1]); } catch { code = ""; }
    const meetingId = enabled() && CODE.test(code) ? byCode.get(code) : undefined;
    const link = meetingId ? links.get(meetingId) : undefined;
    const open = !!link && link.on && link.code === code && live(meetingId);
    if (page) {
      if (req.method !== "GET" && req.method !== "HEAD") return html(res, 405, notFoundPage(nonce), nonce);
      if (!open) return html(res, 404, notFoundPage(nonce), nonce);
      const v = meetings.view(meetingId, null);
      return html(res, 200, guestPage({ hostName: v.startedBy.name, nonce }), nonce);
    }
    const sub = api[2];
    if (sub !== "knock" && sub !== "state" && req.method !== "POST") return refuse(res, 405, "method_not_allowed", "Not allowed");
    if (sub === "knock") {
      if (req.method !== "POST") return refuse(res, 405, "method_not_allowed", "Not allowed");
      let body;
      try { body = await readBody(req); } catch (e) { return refuse(res, e.status || 400, "bad_request", e.message); }
      if (!knockAllowed(ip)) return refuse(res, 429, "rate_limited", "Too many tries from your connection. Wait ten minutes", { "Retry-After": "600" });
      if (!open) return refuse(res, 404, "not_found", "This link doesn't work");
      const name = cleanName(body?.name);
      if (!name) return refuse(res, 400, "bad_name", "Enter your name");
      const slowed = denied.get(`${meetingId}|${ip}`);
      if (slowed && now() < slowed.until) {
        if (now() < slowed.nextAt) return refuse(res, 429, "rate_limited", "The host didn't let someone from your connection in. You can ask again in a minute", { "Retry-After": String(Math.ceil((slowed.nextAt - now()) / 1000)) });
        slowed.nextAt = now() + DENIED_WAIT_MS;
      }
      if (link.knocks >= MAX_KNOCKS) return refuse(res, 429, "link_exhausted", "Too many people have used this link. Ask the host for a new one");
      if (ofMeeting(meetingId).filter(g => g.status === "pending").length >= MAX_PENDING) return refuse(res, 429, "lobby_full", "Too many people are waiting right now. Try again in a minute");
      link.knocks++;
      const token = crypto.randomBytes(32).toString("base64url");
      const g = { id: newId("guest"), meetingId, name, tokenHash: sha256(token), status: "pending", knockedAt: now(), expiresAt: now() + TOKEN_TTL_MS, ip };
      guests.set(g.id, g); byToken.set(g.tokenHash, g.id); names.set(g.id, name);
      try { saveName?.run(g.id, meetingId, name); } catch (e) { log.error?.("[servant] guest name:", e.message); }
      return json(res, 200, { guestToken: token, state: "pending" });
    }
    const g = tokenOf(req);
    if (!g || !link?.codes.has(code) || g.meetingId !== meetingId) return refuse(res, 401, "unauthorized", "Ask the host for a new link");
    if (g.status !== "ended" && !live(g.meetingId)) ended(g.meetingId);
    if (sub === "state") {
      if (req.method !== "GET") return refuse(res, 405, "method_not_allowed", "Not allowed");
      if (g.status === "admitted") return json(res, 200, guestView(g));
      return json(res, 200, { state: g.status, ...(g.status === "pending" ? { hostPresent: hostPresent(g.meetingId) } : {}) });
    }
    if (g.status !== "admitted") return refuse(res, 403, g.status === "pending" ? "not_admitted" : g.status, g.status === "pending" ? "The host hasn't let you in yet" : "You're not in this meeting");
    let body;
    try { body = (await readBody(req)) || {}; } catch (e) { return refuse(res, e.status || 400, "bad_request", e.message); }
    const pid = String(body.participantId || "");
    if (sub === "join") {
      if (guestSeats(g.meetingId) >= MAX_GUESTS && !participantsOf(g.meetingId, g.id).length) return refuse(res, 409, "guests_full", `At most ${MAX_GUESTS} guests can be in a meeting`);
      const r = await sfu(g, "POST", "join", { sdp: body.sdp });
      return r.status === 200 ? json(res, 200, { participantId: r.body.participantId, sdp: r.body.sdp }) : json(res, r.status, r.body);
    }
    if (sub === "watch") {
      const r = await sfu(g, "POST", "watch", { participantId: pid, publisherId: String(body.publisherId || ""), sdp: body.sdp });
      return r.status === 200 ? json(res, 200, { sdp: r.body.sdp }) : json(res, r.status, r.body);
    }
    if (sub === "state-report") {
      const r = await sfu(g, "POST", "state", { participantId: pid, muted: !!body.muted, cameraOff: !!body.cameraOff });
      return r.status === 200 ? json(res, 200, { ok: true }) : json(res, r.status, r.body);
    }
    // leave: the member route answers with the whole meeting; a guest gets a plain ok.
    const r = await sfu(g, "POST", "leave", { participantId: pid });
    // Tapping Leave ends this guest's visit: they drop off the host's list. (A reload or a closed tab
    // doesn't come through here, so those can still rejoin without knocking again.)
    if (r.status === 200 && body.final === true) g.status = "left";
    return r.status === 200 ? json(res, 200, { ok: true }) : json(res, r.status, r.body);
  }

  return { attach, person, admitted, memberView, ended, handleHost, handle, close: () => clearInterval(timer),
    /** For tests. */ _state: { links, guests, byToken, knocks, polls, denied }, _sweep: sweep };
}
