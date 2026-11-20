// The two things Servant does with X by itself (docs/social.md): ask for new posts every few minutes, and post
// each approved reply when its time comes. Nothing here decides what is said: a reply reaches `postDue` only after
// a person who holds the Social media entitlement approved it.
import { createXClient } from "./x-client.mjs";

/**
 * `store` is social.mjs; `settings()` is socialSettings read fresh; `fetch` can stand in for the network.
 */
export function createSocialRunner({ store, settings, fetch: doFetch, clock = Date.now, log = message => console.error(`[servant] social: ${message}`) }) {
  let syncing = null, posting = false;
  const client = () => { const s = settings(); return s.configured ? createXClient({ keys: s.keys, api: s.api, ...(doFetch ? { fetch: doFetch } : {}) }) : null; };
  // X asked for a pause: nothing is sent until then.
  const paused = () => Number(store.kv.get("retryAt") || 0) > clock();
  const noteError = error => {
    if (error?.retryAt) store.kv.set("retryAt", error.retryAt);
    store.kv.set("error", error?.code && error?.message ? error.message : "Servant couldn't reach X. It will try again");
  };
  /** The account the keys belong to, asked once and remembered (asked again when the keys change). */
  async function account(x) {
    const s = settings(), mark = `${s.api}|${s.keys.accessToken.slice(0, 12)}`;
    const saved = store.kv.get("account");
    if (saved && store.kv.get("accountFor") === mark) return JSON.parse(saved);
    const me = await x.me();
    store.kv.set("account", JSON.stringify(me)); store.kv.set("accountFor", mark);
    return me;
  }
  async function syncOnce() {
    const x = client();
    if (!x) return { added: 0 };
    if (paused()) return { added: 0, waiting: true };
    let added = 0;
    try {
      const me = await account(x);
      const sources = [{ key: "mentions", kind: "mention", search: null, get: since => x.mentions(me.id, since) },
        ...settings().searches.map(query => ({ key: `search:${query}`, kind: "search", search: query, get: since => x.search(query, since) }))];
      for (const source of sources) {
        const posts = await source.get(store.cursor(source.key));
        added += store.keep(source.kind, source.search, posts, { ownId: me.id });
        store.advance(source.key, posts);
      }
      store.kv.set("error", ""); store.kv.set("syncedAt", clock());
    } catch (error) {
      noteError(error);
      if (!error?.code) log(error?.message || String(error));
      return { added, error: store.kv.get("error") };
    }
    return { added };
  }
  return {
    /** Ask X for new mentions and search matches. One at a time: a second call joins the first. */
    sync: () => syncing ??= syncOnce().finally(() => { syncing = null; }),
    /** Whether it has been long enough since the last look. */
    syncDue: () => settings().configured && clock() - Number(store.kv.get("syncedAt") || 0) >= settings().pollMs && clock() - Number(store.kv.get("triedAt") || 0) >= 60_000,
    markTried: () => store.kv.set("triedAt", clock()),
    /** Post the next approved reply whose time has come, if any. One per call, so a backlog goes out one after another. */
    async postDue() {
      const x = client();
      if (!x || posting || paused()) return null;
      posting = true;
      try {
        const due = store.claimDue();
        if (!due) return null;
        // The post it answers has gone from Servant's own records: without it this would go out as a post of its own.
        if (due.isReply && !due.replyTo) { store.failed(due.id, "The post this answers is no longer in Servant, so the reply was not sent"); return { id: due.id, ok: false }; }
        try {
          const sent = await x.post(due.text, due.replyTo);
          store.posted(due.id, sent.id);
          return { id: due.id, ok: true };
        } catch (error) {
          // X said to wait: it took nothing, so the reply stays in line. Anything else needs a person to look, and
          // an answer that never came most of all: X may have taken the post, so it is never sent again unasked.
          if (error?.code === "x_rate_limit") { store.release(due.id); noteError(error); }
          else if (error?.code === "x_unreachable") store.failed(due.id, "X didn't answer, so it isn't known whether this was posted. Check the account on X before trying again");
          else store.failed(due.id, error?.code && error?.message ? error.message : "Servant couldn't post this. Try again");
          return { id: due.id, ok: false };
        }
      } finally { posting = false; }
    },
    /** What the app is told about the connection. */
    status() {
      const saved = store.kv.get("account");
      return { account: saved ? (({ handle, name }) => ({ handle, name }))(JSON.parse(saved)) : null, error: store.kv.get("error") || null, syncedAt: Number(store.kv.get("syncedAt") || 0) || null };
    },
    idle: async () => { await syncing?.catch(() => {}); },
  };
}
