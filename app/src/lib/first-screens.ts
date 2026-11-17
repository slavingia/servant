// In a browser and the Mac app each screen's code is its own file, fetched the first time the screen is shown,
// and a screen whose code is on its way is an empty placeholder. On opening the app that placeholder was the
// whole window: the page drew the app's shape (public/index.html, LaunchScreen.tsx), went blank for about half
// a second while the first screen's code arrived, then drew the tab bar over an empty page, then the screen.
//
// The launch screen now stays until the code for the first screen is in (use-first-screens.web.ts). This file
// says which files that is: the screen the address points at, the layouts in the folders above it, and, when
// the address is "/", where the app lands. A phone has every screen's code in the app and waits for nothing.

const isScreenFile = (key: string) => /\.tsx?$/.test(key) && !/(^|\/)\+/.test(key);
const isLayout = (key: string) => /(^|\/)_layout\.tsx?$/.test(key);
const parts = (path: string) => path.split(/[?#]/)[0]!.split("/").filter(Boolean);

/** The address a route file answers to, as segments: groups such as (tabs) and a trailing index are not part of it. */
function routeSegments(key: string): string[] {
  const segments = key.replace(/^\.\//, "").replace(/\.tsx?$/, "").split("/").filter(segment => !/^\(.+\)$/.test(segment));
  if (segments.at(-1) === "index") segments.pop();
  return segments;
}

function answers(key: string, path: string[]): boolean {
  const route = routeSegments(key);
  for (let i = 0; i < route.length; i++) {
    const segment = route[i]!;
    if (/^\[\.\.\..+\]$/.test(segment)) return true;
    if (i >= path.length) return false;
    if (!/^\[.+\]$/.test(segment) && segment !== path[i]) return false;
  }
  return route.length === path.length;
}

/**
 * The route files the first frame needs, from every file the router knows (`keys`, named as it names them:
 * "./(tabs)/channels.tsx"). `landing` is where "/" sends a signed-in person.
 */
export function firstScreens(pathname: string, landing: string, keys: readonly string[]): string[] {
  const files = keys.filter(isScreenFile);
  const wanted: string[] = [];
  const want = (key: string) => { if (!wanted.includes(key)) wanted.push(key); };
  const add = (path: string) => {
    const segments = parts(path);
    // A file that names the address outright comes before one that takes any value ("/c/new" before "/c/[id]").
    const matches = files.filter(key => !isLayout(key) && answers(key, segments));
    const file = matches.find(key => !key.includes("[")) ?? matches[0];
    if (!file) return;
    // The layouts in the folders above the screen, outermost first. The root layout is the code already running.
    const folders = file.replace(/^\.\//, "").split("/").slice(0, -1);
    for (let depth = 1; depth <= folders.length; depth++) {
      const layout = files.find(key => isLayout(key) && key.replace(/\.tsx?$/, "") === `./${folders.slice(0, depth).join("/")}/_layout`);
      if (layout) want(layout);
    }
    want(file);
  };
  add(pathname);
  if (!parts(pathname).length) add(landing);
  return wanted;
}

/** How long the launch screen waits for that code before letting the app show its own placeholder, as before. */
export const FIRST_SCREENS_WAIT_MS = 4000;
