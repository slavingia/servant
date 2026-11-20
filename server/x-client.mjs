// The four calls Servant makes to X (docs/social.md): who the account is, its mentions, a recent search, and a
// post or reply. Requests are signed as the account itself (OAuth 1.0a, HMAC-SHA1) with the four values X gives an
// app's owner, so there is no token to refresh and nothing to install.
//
// Everything that comes back is untrusted text. It is reduced here to the fields Servant keeps; nothing else from
// a response is stored.
import crypto from "node:crypto";

export const X_API = "https://api.x.com";
/** What one post may hold, by X's own counting (xLength). */
export const X_POST_LIMIT = 280;
const fault = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

// RFC 3986: everything but letters, digits and - . _ ~ is escaped.
const enc = value => encodeURIComponent(String(value)).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The Authorization header for one request. `query` is what goes in the address; a JSON body is not signed. */
export function oauthHeader({ method, url, query = {}, keys, nonce = crypto.randomBytes(16).toString("hex"), timestamp = Math.floor(Date.now() / 1000) }) {
  const oauth = { oauth_consumer_key: keys.apiKey, oauth_nonce: nonce, oauth_signature_method: "HMAC-SHA1", oauth_timestamp: String(timestamp), oauth_token: keys.accessToken, oauth_version: "1.0" };
  const all = Object.entries({ ...query, ...oauth }).map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1);
  const base = [method.toUpperCase(), enc(url), enc(all.map(pair => pair.join("=")).join("&"))].join("&");
  const signature = crypto.createHmac("sha1", `${enc(keys.apiSecret)}&${enc(keys.accessTokenSecret)}`).update(base).digest("base64");
  return `OAuth ${Object.entries({ ...oauth, oauth_signature: signature }).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(", ")}`;
}

/** The account's four values from config.json or the environment, or null when any is missing. */
export function xKeys(raw, env = process.env) {
  const given = raw && typeof raw === "object" ? raw : {};
  const keys = {
    apiKey: env.SERVANT_X_API_KEY || given.apiKey, apiSecret: env.SERVANT_X_API_SECRET || given.apiSecret,
    accessToken: env.SERVANT_X_ACCESS_TOKEN || given.accessToken, accessTokenSecret: env.SERVANT_X_ACCESS_TOKEN_SECRET || given.accessTokenSecret,
  };
  return Object.values(keys).every(value => typeof value === "string" && value.trim()) ? Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.trim()])) : null;
}

const URL_IN_TEXT = /https?:\/\/[^\s]+/gi;
// Code points X counts once; every other one counts twice (twitter-text's weighted length, version 3).
const single = cp => cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
/** How long X says a post is: a link counts 23 whatever its length, and most non-Latin characters and emoji count 2. */
export function xLength(text) {
  let length = 0;
  const rest = String(text ?? "").normalize("NFC").replace(URL_IN_TEXT, () => { length += 23; return ""; });
  for (const ch of rest) length += single(ch.codePointAt(0)) ? 1 : 2;
  return length;
}

const ID = /^\d{1,20}$/;
const line = (value, max) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** One post from a response, reduced to what Servant keeps. Null when it is not a post we can show. */
export function readPost(raw, users) {
  if (!raw || typeof raw !== "object" || !ID.test(String(raw.id)) || typeof raw.text !== "string") return null;
  const author = users.get(String(raw.author_id)) || {};
  const handle = HANDLE.test(String(author.username)) ? String(author.username) : "";
  const at = Date.parse(raw.created_at);
  const avatar = typeof author.profile_image_url === "string" && /^https:\/\/pbs\.twimg\.com\/[\w\-./%]+$/.test(author.profile_image_url) ? author.profile_image_url : "";
  const metrics = raw.public_metrics && typeof raw.public_metrics === "object" ? raw.public_metrics : {};
  return {
    remoteId: String(raw.id), authorId: ID.test(String(raw.author_id)) ? String(raw.author_id) : "", authorHandle: handle, authorName: line(author.name, 80).trim() || (handle ? `@${handle}` : "Someone on X"),
    authorAvatar: avatar, text: line(raw.text, 4000), postedAt: Number.isFinite(at) ? at : Date.now(),
    // The address is built here from the id, never taken from the response.
    url: `https://x.com/${handle || "i"}/status/${raw.id}`,
    likes: count(metrics.like_count), reposts: count(metrics.retweet_count), replies: count(metrics.reply_count),
  };
}

/**
 * A client for one account. `fetch` and `api` can be replaced (tests, and a stand-in for X when trying Servant out).
 * Every call rejects with { status, code, message } in words an owner can act on; `retryAt` is set when X says to wait.
 */
export function createXClient({ keys, api = X_API, fetch: doFetch = globalThis.fetch, timeoutMs = 20_000 }) {
  const base = String(api).replace(/\/+$/, "");
  async function call(method, pathname, { query = {}, body } = {}) {
    const url = `${base}${pathname}`;
    const search = new URLSearchParams(query).toString();
    let response;
    try {
      response = await doFetch(search ? `${url}?${search}` : url, { method, signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: oauthHeader({ method, url, query, keys }), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw fault(503, "x_unreachable", "X didn't answer. Servant will try again");
    }
    let data = null;
    try { data = await response.json(); } catch { /* an empty or non-JSON answer */ }
    if (response.ok) return data || {};
    const said = line(data?.detail || data?.errors?.[0]?.message || data?.title || "", 200);
    if (response.status === 429) {
      const reset = Number(response.headers.get("x-rate-limit-reset")) * 1000;
      throw fault(429, "x_rate_limit", "X says this account has made too many requests. Servant will wait and try again", { retryAt: Number.isFinite(reset) && reset > 0 ? reset : Date.now() + 15 * 60_000 });
    }
    if (response.status === 401) throw fault(401, "x_keys", "X refused this server's keys. Ask an owner to check the four X values in config.json");
    if (response.status === 403) throw fault(403, "x_refused", `X refused this${said ? `: ${said}` : ". The account's access level may not allow it"}`);
    throw fault(502, "x_failed", `X returned ${response.status}${said ? `: ${said}` : ""}`);
  }
  const FIELDS = { "tweet.fields": "created_at,author_id,public_metrics", expansions: "author_id", "user.fields": "name,username,profile_image_url" };
  const posts = data => {
    const users = new Map((Array.isArray(data?.includes?.users) ? data.includes.users : []).map(user => [String(user?.id), user]));
    return (Array.isArray(data?.data) ? data.data : []).map(raw => readPost(raw, users)).filter(Boolean);
  };
  const since = id => id && ID.test(String(id)) ? { since_id: String(id) } : {};
  return {
    /** The account these keys belong to. */
    async me() {
      const data = (await call("GET", "/2/users/me", { query: { "user.fields": "name,username" } })).data || {};
      if (!ID.test(String(data.id)) || !HANDLE.test(String(data.username))) throw fault(502, "x_failed", "X didn't say which account these keys belong to");
      return { id: String(data.id), handle: String(data.username), name: line(data.name, 80).trim() || `@${data.username}` };
    },
    /** Posts that mention the account, newest first, after `sinceId` when given. */
    async mentions(userId, sinceId) {
      return posts(await call("GET", `/2/users/${encodeURIComponent(userId)}/mentions`, { query: { max_results: "100", ...FIELDS, ...since(sinceId) } }));
    },
    /** Posts from the last seven days that match a search, newest first, after `sinceId` when given. */
    async search(query, sinceId) {
      return posts(await call("GET", "/2/tweets/search/recent", { query: { query, max_results: "100", ...FIELDS, ...since(sinceId) } }));
    },
    /** Post `text`, as a reply when `replyTo` is a post's id. Resolves to the new post's id. */
    async post(text, replyTo) {
      const data = (await call("POST", "/2/tweets", { body: { text, ...(replyTo ? { reply: { in_reply_to_tweet_id: String(replyTo) } } : {}) } })).data || {};
      if (!ID.test(String(data.id))) throw fault(502, "x_failed", "X accepted the post but didn't say where it is. Check the account on X before trying again");
      return { id: String(data.id) };
    },
  };
}
