// The agent feed, shaped for a list like Loops: each line the agent posted in #agent-feed becomes one item.
// Digests read "Sent\n- 4:45pm · Messaged Ann\n\nShipped\n- …"; anything else is a single "Note".

const KINDS = { sent: "sent", shipped: "shipped", ran: "ran" };
const URL_RE = /\s*\(?(https?:\/\/[^\s)]+)\)?\s*$/;

/** One feed post → items, newest-first order is the caller's job. */
export function parseFeedPost(text, at, id) {
  const items = []; let kind = null;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const head = KINDS[line.toLowerCase()];
    if (head) { kind = head; continue; }
    let body = line.replace(/^[-•]\s*/, ""), time = null, url = null;
    const t = /^(\d{1,2}(?::\d{2})?\s?[ap]m)\s*·\s*/i.exec(body);
    if (t) { time = t[1].replace(/\s/g, "").toLowerCase(); body = body.slice(t[0].length); }
    const u = URL_RE.exec(body);
    if (u) { url = u[1]; body = body.slice(0, u.index).trim(); }
    items.push({ id: `${id}:${items.length}`, kind: kind || "note", text: body, time, url, at });
  }
  return items;
}

export function shapeFeed(rows, limit = 300) {
  const out = [];
  for (const r of rows) for (const it of parseFeedPost(r.text, r.created_at, r.seq).reverse()) out.push(it);
  return out.slice(0, limit);
}
