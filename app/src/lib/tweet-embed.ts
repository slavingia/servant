// A pasted tweet link shows the tweet itself under the message, like Slack and
// Discord do. Only x.com / twitter.com status links qualify; the link stays in the text.

const TWEET = /https?:\/\/(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status(?:es)?\/(\d{1,25})(?=$|[/?#\s<>"'`)\]}.,;:!*_~])/gi;

/** Ids of the tweets linked in a message, first appearance first, at most `max`. */
export function tweetIds(text: string, max = 2): string[] {
  const ids: string[] = [];
  for (const m of (text || "").matchAll(TWEET)) {
    if (!ids.includes(m[1])) ids.push(m[1]);
    if (ids.length >= max) break;
  }
  return ids;
}

/** Twitter's own embed page. dnt asks Twitter not to use the view for personalisation. */
export function tweetEmbedUrl(id: string, dark: boolean): string {
  return `https://platform.twitter.com/embed/Tweet.html?id=${encodeURIComponent(id)}&dnt=true&theme=${dark ? "dark" : "light"}&hideThread=true&lang=en`;
}

/** Height Twitter reports when its embed resizes itself, or null for any other message. */
export function tweetResizeHeight(data: unknown): number | null {
  try {
    const msg = typeof data === "string" ? JSON.parse(data) : data;
    const params = (msg as any)?.["twttr.embed"]?.params;
    const h = Array.isArray(params) ? Number(params[0]?.height) : NaN;
    return Number.isFinite(h) && h > 0 ? Math.min(Math.round(h), 900) : null;
  } catch { return null; }
}
