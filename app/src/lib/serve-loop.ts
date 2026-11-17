// The loading ball's one loop, as numbers: a few bounces before the serve, the toss, the serve away (the
// ball shrinks as it goes, toward the far end of the court), the rally back (it grows as it comes), and a
// last bounce that lands where the first one starts, so the loop has no seam. ServeLoader.tsx draws it.
//
// Lengths are in ball diameters, measured up from where the ball rests. `depth` is 0 here and 1 at the far end.

export const SERVE_LOOP_MS = 3200;
/** How high the far end of the court sits on screen. */
export const HORIZON = 1.25;
/** The ball's size at the far end. */
export const FAR_SCALE = 0.14;
/** The box the loop is drawn in, so nothing is clipped: its width and its height, in diameters. */
export const BOX = { width: 1.6, height: 2.6 };

const DRIBBLE = 0.12;
const DRIBBLES = 3;
const TOSS_END = 0.46;
const SERVE_END = 0.64;
const RETURN_START = 0.7;
const LAND = 0.88;
const DRIBBLE_HEIGHT = 0.85;
const TOSS_HEIGHT = 1.3;
const SQUASH = 0.016;

/** Where the ball touches the ground close to the viewer: each is a squash. */
export const CONTACTS = [...Array.from({ length: DRIBBLES + 1 }, (_, i) => i * DRIBBLE), LAND, 1];

export type ServeFrame = {
  /** The ball's middle above the resting point (0 at rest). */
  y: number;
  scale: number;
  scaleX: number;
  scaleY: number;
  rotate: number;
  /** The shadow's middle above the resting ground line, its width and how dark it is. */
  shadowY: number;
  shadowScale: number;
  shadowOpacity: number;
};

const clamp = (n: number) => Math.min(1, Math.max(0, n));
const local = (t: number, from: number, to: number) => clamp((t - from) / (to - from));
const hop = (u: number, height: number) => 4 * height * u * (1 - u);
const easeOut = (u: number) => 1 - (1 - u) ** 2;
const easeIn = (u: number) => u * u;

function flight(t: number): { height: number; depth: number } {
  if (t < DRIBBLE * DRIBBLES) return { height: hop((t % DRIBBLE) / DRIBBLE, DRIBBLE_HEIGHT), depth: 0 };
  if (t < TOSS_END) return { height: TOSS_HEIGHT * easeOut(local(t, DRIBBLE * DRIBBLES, TOSS_END)), depth: 0 };
  if (t < SERVE_END) {
    // Hit at the top of the toss, it flies away and drops toward the far court as it goes.
    const u = local(t, TOSS_END, SERVE_END);
    return { height: TOSS_HEIGHT * (1 - u) + hop(u, 0.5), depth: easeOut(u) };
  }
  if (t < RETURN_START) return { height: hop(local(t, SERVE_END, RETURN_START), 0.6), depth: 1 };
  if (t < LAND) {
    const u = local(t, RETURN_START, LAND);
    return { height: hop(u, 1), depth: 1 - easeIn(u) };
  }
  return { height: hop(local(t, LAND, 1), DRIBBLE_HEIGHT * 0.8), depth: 0 };
}

export function serveFrame(t: number): ServeFrame {
  const { height, depth } = flight(clamp(t));
  const scale = 1 - (1 - FAR_SCALE) * depth;
  const ground = HORIZON * depth;
  // A squash where it meets the ground near the viewer: wider and shorter, its foot staying on the ground.
  const squash = Math.max(0, ...CONTACTS.map(at => 1 - Math.abs(t - at) / SQUASH)) * (depth === 0 ? 1 : 0);
  const scaleY = 1 - 0.18 * squash;
  const scaleX = 1 + 0.14 * squash;
  // The ball's middle sits half its (shrunk, squashed) height above its foot.
  const y = ground + height * scale + (scale * scaleY) / 2 - 0.5;
  const lift = clamp(height / TOSS_HEIGHT);
  return {
    y,
    scale,
    scaleX,
    scaleY,
    rotate: 720 * easeOut(local(t, TOSS_END, LAND)),
    shadowY: ground,
    shadowScale: scale * (1 - 0.55 * lift),
    shadowOpacity: (0.3 + 0.7 * scale) * (1 - 0.65 * lift),
  };
}

/** The loop sampled for Animated.interpolate: one input range and every value's outputs beside it. */
export function serveKeyframes(steps = 160) {
  const input = Array.from({ length: steps + 1 }, (_, i) => i / steps);
  // Every contact is a sample of its own, so no squash falls between two samples.
  const times = [...new Set([...input, ...CONTACTS.flatMap(at => [at - SQUASH / 2, at, at + SQUASH / 2])])]
    .filter(at => at >= 0 && at <= 1).sort((a, b) => a - b);
  const frames = times.map(serveFrame);
  const pick = <K extends keyof ServeFrame>(key: K) => frames.map(frame => frame[key]);
  return {
    input: times,
    y: pick("y"), scale: pick("scale"), scaleX: pick("scaleX"), scaleY: pick("scaleY"), rotate: pick("rotate"),
    shadowY: pick("shadowY"), shadowScale: pick("shadowScale"), shadowOpacity: pick("shadowOpacity"),
  };
}

// Most things load within a moment. A ball that comes up and is gone again inside that moment is a flicker on
// every screen opened (measured with a fifth of a second added to each answer from the server: the ball was up
// for 80 to 330 ms on a thread, an agent chat, To-dos, Saved, Recordings, the wiki). So it waits before
// it shows, keeping its place meanwhile so nothing moves when it does, and then fades in: a load that finishes
// in time never shows it, and one that takes longer shows it a quarter of a second later than before.
export const LOADER_DELAY_MS = 250;
export const LOADER_FADE_MS = 150;
