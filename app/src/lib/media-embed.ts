// A link to something you can play (a podcast, a song, a video) gets a Play button under the message. Pressing
// it loads that service's own player in place. Nothing is loaded before the press: until then no reader's
// device contacts the service, and the link itself stays in the text.
//
// The player's address is built here from the parts of the link that were checked (a country code, a slug,
// ids), never copied from the message, and only these services' player addresses are ever framed.

export type MediaEmbed = {
  /** A stable key: the service and what is played. */
  key: string;
  service: "Apple Podcasts" | "Apple Music" | "Spotify" | "YouTube" | "Vimeo";
  /** Who the player is loaded from, for the line under the button. */
  from: "Apple" | "Spotify" | "YouTube" | "Vimeo";
  /** The player's address. */
  url: string;
  /** A fixed height for a sound player; a video keeps 16:9 instead. */
  height?: number;
};

const END = "(?=$|[\\s<>\"'`)\\]}.,;:!*_~])";
const SLUG = "[A-Za-z0-9%._~-]{1,200}";
type Rule = { pattern: RegExp; embed: (m: RegExpMatchArray) => MediaEmbed | null };

const RULES: Rule[] = [
  // https://podcasts.apple.com/us/podcast/a-show/id123456789?i=1000123456789
  { pattern: new RegExp(`https://podcasts\\.apple\\.com/([a-z]{2})/podcast/(?:(${SLUG})/)?id(\\d{1,20})(?:\\?(?:[^\\s#]*&)?i=(\\d{1,20})[^\\s]*?)?${END}`, "gi"),
    embed: ([, country, slug, show, episode]) => ({
      key: `apple-podcasts:${show}:${episode ?? ""}`, service: "Apple Podcasts", from: "Apple", height: episode ? 175 : 450,
      url: `https://embed.podcasts.apple.com/${country.toLowerCase()}/podcast/${slug ? `${slug}/` : ""}id${show}${episode ? `?i=${episode}` : ""}`,
    }) },
  // https://music.apple.com/us/album/a-record/123456789?i=123456790
  { pattern: new RegExp(`https://music\\.apple\\.com/([a-z]{2})/(album|playlist|song)/(?:(${SLUG})/)?((?:pl\\.)?[A-Za-z0-9-]{1,64})(?:\\?(?:[^\\s#]*&)?i=(\\d{1,20})[^\\s]*?)?${END}`, "gi"),
    embed: ([, country, kind, slug, id, song]) => ({
      key: `apple-music:${kind}:${id}:${song ?? ""}`, service: "Apple Music", from: "Apple", height: song || kind.toLowerCase() === "song" ? 175 : 450,
      url: `https://embed.music.apple.com/${country.toLowerCase()}/${kind.toLowerCase()}/${slug ? `${slug}/` : ""}${id}${song ? `?i=${song}` : ""}`,
    }) },
  // https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk
  { pattern: new RegExp(`https://open\\.spotify\\.com/(?:intl-[a-z]{2}/)?(track|album|playlist|episode|show)/([A-Za-z0-9]{22})(?:\\?[^\\s]*?)?${END}`, "gi"),
    embed: ([, kind, id]) => ({
      key: `spotify:${kind}:${id}`, service: "Spotify", from: "Spotify", height: /^(track|episode)$/i.test(kind) ? 152 : 352,
      url: `https://open.spotify.com/embed/${kind.toLowerCase()}/${id}`,
    }) },
  // https://www.youtube.com/watch?v=dQw4w9WgXcQ, https://youtu.be/dQw4w9WgXcQ, https://www.youtube.com/shorts/dQw4w9WgXcQ
  { pattern: new RegExp(`https://(?:(?:www\\.|m\\.)?youtube\\.com/(?:watch\\?(?:[^\\s#]*&)?v=|shorts/|live/)|youtu\\.be/)([A-Za-z0-9_-]{11})(?:[?&][^\\s]*?)?${END}`, "gi"),
    // youtube-nocookie.com is YouTube's own player that sets no cookie until it plays.
    embed: ([, id]) => ({ key: `youtube:${id}`, service: "YouTube", from: "YouTube", url: `https://www.youtube-nocookie.com/embed/${id}` }) },
  // https://vimeo.com/123456789
  { pattern: new RegExp(`https://(?:www\\.)?vimeo\\.com/(\\d{6,12})(?:\\?[^\\s]*?)?${END}`, "gi"),
    embed: ([, id]) => ({ key: `vimeo:${id}`, service: "Vimeo", from: "Vimeo", url: `https://player.vimeo.com/video/${id}?dnt=1` }) },
];

/** The only places a player is ever loaded from. The Mac app's frame policy lists the same (desktop/policy.mjs). */
export const MEDIA_FRAME_ORIGINS = ["https://embed.podcasts.apple.com", "https://embed.music.apple.com", "https://open.spotify.com", "https://www.youtube-nocookie.com", "https://player.vimeo.com"];

/** Does this address belong to the player that was loaded? A player may not take its frame anywhere else. */
export const withinPlayer = (embed: Pick<MediaEmbed, "url">, address: string) => {
  try { return new URL(address).origin === new URL(embed.url).origin; } catch { return false; }
};

/** What can be played from a message's links, in the order they appear, at most `max`. Links in code are not links. */
export function mediaEmbeds(text: string, max = 2): MediaEmbed[] {
  const prose = (text || "").replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const found: { at: number; embed: MediaEmbed }[] = [];
  for (const rule of RULES) {
    for (const match of prose.matchAll(rule.pattern)) {
      const embed = rule.embed(match);
      if (embed && MEDIA_FRAME_ORIGINS.includes(new URL(embed.url).origin) && !found.some(f => f.embed.key === embed.key)) found.push({ at: match.index ?? 0, embed });
    }
  }
  return found.sort((a, b) => a.at - b.at).slice(0, max).map(f => f.embed);
}
