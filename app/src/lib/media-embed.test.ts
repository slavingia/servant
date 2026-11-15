import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MEDIA_FRAME_ORIGINS, mediaEmbeds, withinPlayer } from "./media-embed.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const one = (text: string) => { const found = mediaEmbeds(text); assert.equal(found.length, 1, text); return found[0]; };

test("an Apple Podcasts link plays the episode, or lists the show", () => {
  const episode = one("Worth a listen: https://podcasts.apple.com/us/podcast/the-example-show/id123456789?i=1000123456789.");
  assert.deepEqual(episode, { key: "apple-podcasts:123456789:1000123456789", service: "Apple Podcasts", from: "Apple", height: 175,
    url: "https://embed.podcasts.apple.com/us/podcast/the-example-show/id123456789?i=1000123456789" });
  const show = one("https://podcasts.apple.com/GB/podcast/the-example-show/id123456789");
  assert.equal(show.url, "https://embed.podcasts.apple.com/gb/podcast/the-example-show/id123456789");
  assert.equal(show.height, 450);
  assert.equal(one("https://podcasts.apple.com/us/podcast/id123456789?uo=4&i=1000123456789&l=es").url, "https://embed.podcasts.apple.com/us/podcast/id123456789?i=1000123456789", "only the checked parts are carried over");
});

test("Apple Music, Spotify, YouTube and Vimeo links play too", () => {
  assert.equal(one("https://music.apple.com/us/album/a-record/1234567890?i=1234567891").url, "https://embed.music.apple.com/us/album/a-record/1234567890?i=1234567891");
  assert.equal(one("https://music.apple.com/us/album/a-record/1234567890?i=1234567891").height, 175);
  assert.equal(one("https://music.apple.com/us/playlist/a-list/pl.abcdef0123456789").height, 450);
  assert.deepEqual(one("https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk?si=abc"), { key: "spotify:episode:4rOoJ6Egrf8K2IrywzwOMk", service: "Spotify", from: "Spotify", height: 152, url: "https://open.spotify.com/embed/episode/4rOoJ6Egrf8K2IrywzwOMk" });
  assert.equal(one("https://open.spotify.com/intl-de/album/4rOoJ6Egrf8K2IrywzwOMk").height, 352);
  for (const link of ["https://www.youtube.com/watch?v=abcdefghijk", "https://youtube.com/watch?feature=share&v=abcdefghijk&t=30s", "https://youtu.be/abcdefghijk?t=30", "https://www.youtube.com/shorts/abcdefghijk", "https://m.youtube.com/watch?v=abcdefghijk"]) {
    assert.deepEqual(one(link), { key: "youtube:abcdefghijk", service: "YouTube", from: "YouTube", url: "https://www.youtube-nocookie.com/embed/abcdefghijk" }, link);
  }
  assert.deepEqual(one("See https://vimeo.com/123456789, from the launch"), { key: "vimeo:123456789", service: "Vimeo", from: "Vimeo", url: "https://player.vimeo.com/video/123456789?dnt=1" });
});

test("only real links to these services, in order, each once, two at most", () => {
  for (const text of ["", "no links here", "http://youtu.be/abcdefghijk", "https://podcasts.apple.com.example.gov/us/podcast/x/id1", "https://example.gov/?next=https://youtu.be/abc", "https://open.spotify.com/user/someone",
    "https://www.youtube.com/channel/abcdefghijk", "https://vimeo.com/channels/staffpicks", "`https://youtu.be/abcdefghijk`", "```\nhttps://youtu.be/abcdefghijk\n```", "https://youtu.be/abcdefghijkl"]) {
    assert.deepEqual(mediaEmbeds(text), [], text);
  }
  const several = mediaEmbeds("https://vimeo.com/123456789 then https://youtu.be/abcdefghijk and again https://vimeo.com/123456789 and https://youtu.be/ABCDEFGHIJK");
  assert.deepEqual(several.map(e => e.key), ["vimeo:123456789", "youtube:abcdefghijk"]);
});

test("a player is only ever one of the listed services' own, and stays there", () => {
  const links = ["https://podcasts.apple.com/us/podcast/x/id1?i=2", "https://music.apple.com/us/song/x/1", "https://open.spotify.com/track/4rOoJ6Egrf8K2IrywzwOMk", "https://youtu.be/abcdefghijk", "https://vimeo.com/123456789"];
  assert.deepEqual(links.map(link => new URL(one(link).url).origin), MEDIA_FRAME_ORIGINS);
  const player = one("https://youtu.be/abcdefghijk");
  assert.equal(withinPlayer(player, "https://www.youtube-nocookie.com/embed/abcdefghijk?autoplay=1"), true);
  for (const elsewhere of ["https://www.youtube.com/watch?v=abcdefghijk", "https://example.gov/", "javascript:alert(1)", "not an address"]) assert.equal(withinPlayer(player, elsewhere), false, elsewhere);
});

test("nothing loads until Play is pressed, and the Mac app allows the same players", () => {
  const component = read("../components/MediaEmbed.tsx"), messaging = read("../components/Messaging.tsx"), chat = read("../app/chat/[id].tsx");
  assert.match(component, /const \[playing, setPlaying\] = useState\(false\);/);
  assert.match(component, /if \(!playing\) return \(/, "before the press there is only a button");
  assert.match(component, /onShouldStartLoadWithRequest=\{\(r: any\) => withinPlayer\(embed, r\.url\)\}/);
  assert.match(messaging, /mediaEmbeds\(post\.text\)\.map\(embed => <MediaEmbed key=\{embed\.key\} embed=\{embed\} \/>\)/);
  assert.match(chat, /mediaEmbeds\(item\.text \|\| ""\)\.map\(embed => <MediaEmbed key=\{embed\.key\} embed=\{embed\} \/>\)/);
  const policy = read("../../../desktop/policy.mjs");
  for (const origin of MEDIA_FRAME_ORIGINS) assert.ok(policy.includes(`'${origin}'`), origin);
});
