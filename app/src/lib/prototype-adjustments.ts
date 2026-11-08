// Quick adjustments to a design prototype: the app side of the in-page script
// the server adds to a prototype opened with ?servant-adjust=1
// (server/prototype-adjust.mjs).
//
// Adjustments are previewed in the person's own browser only. The author turns
// them into a request for the design's agent (left unsent in the message box,
// to review and send); a reviewer posts them as a suggestion in the design's
// review thread. Everything the page sends is untrusted: it's checked here,
// shortened, and only ever becomes text a person reads before sending.

export const ADJUST_STYLES = ["color", "background-color", "font-size", "font-weight", "text-align", "padding", "margin", "border-radius", "width", "height"] as const;
export type AdjustStyle = (typeof ADJUST_STYLES)[number];
export type AdjustProp = "text" | "hidden" | "move" | "comment" | AdjustStyle;
export const MAX_ADJUSTMENTS = 40;
/** Screen sizes a style or hide can be limited to; the page applies them with matching @media rules. */
export type AdjustScope = "phone" | "tablet" | "desktop";
export const DEVICE_SIZES = [
  { id: "fit", label: "Full width", width: null },
  { id: "phone", label: "Phone", width: 390 },
  { id: "tablet", label: "Tablet", width: 768 },
  { id: "desktop", label: "Desktop", width: 1280 },
] as const;
export type DeviceSize = (typeof DEVICE_SIZES)[number]["id"];
const SCOPE_WORDS: Record<AdjustScope, string> = {
  phone: "phone sizes only, under 600px wide",
  tablet: "tablet sizes only, 600–1023px wide",
  desktop: "desktop sizes only, 1024px wide and up",
};
export const scopeName = (scope: AdjustScope) => ({ phone: "Phone", tablet: "Tablet", desktop: "Desktop" })[scope];
/** A design-kit token the page defines: a CSS custom property on :root. */
export type DesignToken = { name: string; value: string };

export type AdjustNeighbor = { id: string; kind: string; label: string };
export type AdjustElement = {
  id: string; tag: string; kind: string; label: string; path: string;
  /** The element's text when it holds only text (so it can be edited); otherwise null. */
  text: string | null;
  styles: Record<AdjustStyle, string>;
  /** Styles the page sets from a design-kit token, by property: { color: "--brand-blue" }. */
  tokens: Partial<Record<AdjustStyle, string>>;
  /** The color behind the element's text (the nearest background that isn't see-through). */
  backdrop: string;
  /** How it looked before any change: every change is measured from this, however often the page reports it since. */
  original: { text: string | null; styles: Record<AdjustStyle, string>; hidden: boolean };
  hidden: boolean;
  previous: AdjustNeighbor | null;
  next: AdjustNeighbor | null;
  hasParent: boolean;
  hasChildren: boolean;
};
export type ElementRef = Pick<AdjustElement, "id" | "tag" | "kind" | "label" | "path">;
export type Adjustment =
  | { element: ElementRef; prop: "text"; from: string; to: string }
  | { element: ElementRef; prop: AdjustStyle; from: string; to: string; scope?: AdjustScope }
  | { element: ElementRef; prop: "hidden"; from: boolean; to: boolean; scope?: AdjustScope }
  | { element: ElementRef; prop: "move"; to: "earlier" | "later"; past: AdjustNeighbor }
  | { element: ElementRef; prop: "comment"; to: string };
/** Text on the page with its colors, from the accessibility check. */
export type ScannedText = { id: string; kind: string; label: string; color: string; backdrop: string; size: string; weight: string };
export type ScanIssue = { id: string | null; kind: string; label: string; problem: "no-lang" | "no-h1" | "heading-skip" | "no-alt" | "no-name" | "no-label" | "small-target" };
export type Layer = { id: string; kind: string; label: string; depth: number; hidden: boolean };
export type AdjustMessage =
  | { type: "ready"; title: string; tokens: DesignToken[] }
  | { type: "picking"; on: boolean }
  | { type: "editing"; on: boolean }
  | { type: "selected"; element: AdjustElement }
  | { type: "edited"; element: AdjustElement; text: string }
  | { type: "scanned"; issues: ScanIssue[]; texts: ScannedText[] }
  | { type: "layers"; items: Layer[] }
  | { type: "replayed"; failed: number[] };

// ---------- checking what the page sends ----------
const clean = (value: unknown, limit: number) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
const ID = /^e\d{1,7}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function neighbor(value: unknown): AdjustNeighbor | null {
  if (!isRecord(value) || typeof value.id !== "string" || !ID.test(value.id)) return null;
  return { id: value.id, kind: clean(value.kind, 30) || "Element", label: clean(value.label, 60) };
}
function element(value: unknown): AdjustElement | null {
  if (!isRecord(value) || typeof value.id !== "string" || !ID.test(value.id)) return null;
  const tag = clean(value.tag, 20).toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) return null;
  const raw = isRecord(value.styles) ? value.styles : {};
  const styles = Object.fromEntries(ADJUST_STYLES.map(prop => [prop, clean(raw[prop], 60)])) as Record<AdjustStyle, string>;
  const rawTokens = isRecord(value.tokens) ? value.tokens : {};
  const tokens: Partial<Record<AdjustStyle, string>> = {};
  for (const prop of ADJUST_STYLES) if (typeof rawTokens[prop] === "string" && TOKEN.test(rawTokens[prop])) tokens[prop] = rawTokens[prop];
  const text = typeof value.text === "string" ? String(value.text).slice(0, 2000) : null;
  const first = isRecord(value.original) ? value.original : null;
  const firstStyles = first && isRecord(first.styles) ? first.styles : null;
  const original = {
    text: first ? (typeof first.text === "string" && text !== null ? String(first.text).slice(0, 2000) : null) : text,
    styles: firstStyles ? Object.fromEntries(ADJUST_STYLES.map(prop => [prop, clean(firstStyles[prop], 60)])) as Record<AdjustStyle, string> : styles,
    hidden: first ? first.hidden === true : value.hidden === true,
  };
  return {
    id: value.id, tag, kind: clean(value.kind, 30) || "Element", label: clean(value.label, 60), path: clean(value.path, 300) || tag,
    text, styles, tokens, original, backdrop: clean(value.backdrop, 60) || "rgb(255, 255, 255)", hidden: value.hidden === true,
    previous: neighbor(value.previous), next: neighbor(value.next), hasParent: value.hasParent === true, hasChildren: value.hasChildren === true,
  };
}
const TOKEN = /^--[A-Za-z0-9_-]{1,40}$/;
const PROBLEMS = new Set<ScanIssue["problem"]>(["no-lang", "no-h1", "heading-skip", "no-alt", "no-name", "no-label", "small-target"]);
const list = (value: unknown, limit: number) => Array.isArray(value) ? value.slice(0, limit).filter(isRecord) : [];
/** A message from the prototype page, checked and shortened; null for anything else. */
export function readAdjustMessage(data: unknown): AdjustMessage | null {
  if (!isRecord(data) || data.source !== "servant-adjust" || data.version !== 1) return null;
  if (data.type === "ready") {
    const tokens = list(data.tokens, 60).filter(t => typeof t.name === "string" && TOKEN.test(t.name)).map(t => ({ name: t.name as string, value: clean(t.value, 60) }));
    return { type: "ready", title: clean(data.title, 120), tokens };
  }
  if (data.type === "picking" || data.type === "editing") return { type: data.type, on: data.on === true };
  if (data.type === "selected") { const el = element(data.element); return el ? { type: "selected", element: el } : null; }
  if (data.type === "edited") {
    const el = element(data.element);
    return el && el.text !== null && typeof data.text === "string" ? { type: "edited", element: el, text: clean(data.text, 2000) } : null;
  }
  if (data.type === "scanned") {
    const issues = list(data.issues, 60).filter(i => PROBLEMS.has(i.problem as ScanIssue["problem"]) && (i.id === null || (typeof i.id === "string" && ID.test(i.id))))
      .map(i => ({ id: i.id as string | null, kind: clean(i.kind, 30) || "Element", label: clean(i.label, 60), problem: i.problem as ScanIssue["problem"] }));
    const texts = list(data.texts, 200).filter(t => typeof t.id === "string" && ID.test(t.id))
      .map(t => ({ id: t.id as string, kind: clean(t.kind, 30) || "Element", label: clean(t.label, 60), color: clean(t.color, 60), backdrop: clean(t.backdrop, 60), size: clean(t.size, 20), weight: clean(t.weight, 10) }));
    return { type: "scanned", issues, texts };
  }
  if (data.type === "layers") {
    const items = list(data.items, 150).filter(i => typeof i.id === "string" && ID.test(i.id))
      .map(i => ({ id: i.id as string, kind: clean(i.kind, 30) || "Element", label: clean(i.label, 60), depth: Math.max(0, Math.min(6, Number.isInteger(i.depth) ? i.depth as number : 0)), hidden: i.hidden === true }));
    return { type: "layers", items };
  }
  if (data.type === "replayed") return { type: "replayed", failed: Array.isArray(data.failed) ? data.failed.filter((n): n is number => Number.isInteger(n)).slice(0, MAX_ADJUSTMENTS) : [] };
  return null;
}
/** A command for the page (window.postMessage). */
export const adjustCommand = (type: "pick" | "select" | "replay" | "edit" | "scan" | "layers", extra: Record<string, unknown> = {}) => ({ source: "servant-adjust-cmd", version: 1, type, ...extra });
/** What the page replays: the list in order, as the in-page script applies it. Comments change nothing on the page. */
export const replayChanges = (list: readonly Adjustment[]) => list.filter(item => item.prop !== "comment")
  .map(item => ({ id: item.element.id, prop: item.prop, value: item.to, ...("scope" in item && item.scope ? { scope: item.scope } : {}) }));

// ---------- which links can be adjusted ----------
const FOLDER = /^[a-z0-9][a-z0-9-]{2,40}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/**
 * The prototype page's address when `url` is one of this server's prototype
 * pages (its origin, then /p/<folder>/), otherwise null. Only those open for
 * adjustments; HTTPS, or HTTP on this computer.
 */
export function prototypePageUrl(url: unknown, origin: string | null | undefined): string | null {
  if (typeof url !== "string" || !origin) return null;
  let page: URL, home: URL;
  try { page = new URL(url.trim()); home = new URL(origin); } catch { return null; }
  if (page.origin !== home.origin || page.username || page.password) return null;
  if (page.protocol !== "https:" && !(page.protocol === "http:" && LOOPBACK.has(page.hostname))) return null;
  const match = page.pathname.match(/^\/p\/([^/]+)\/(index\.html)?$/);
  if (!match || !FOLDER.test(match[1]!)) return null;
  return `${page.origin}/p/${match[1]}/`;
}
/** A kept version's read-only page on this server (its origin, then /p/<folder>.v<n>/), otherwise null. */
export function prototypeVersionUrl(url: unknown, origin: string | null | undefined): string | null {
  if (typeof url !== "string" || !origin) return null;
  let page: URL, home: URL;
  try { page = new URL(url.trim()); home = new URL(origin); } catch { return null; }
  if (page.origin !== home.origin || page.username || page.password || page.search || page.hash) return null;
  if (page.protocol !== "https:" && !(page.protocol === "http:" && LOOPBACK.has(page.hostname))) return null;
  const match = page.pathname.match(/^\/p\/([^/]+)\.v([1-9]\d{0,5})\/$/);
  return match && FOLDER.test(match[1]!) ? `${page.origin}${page.pathname}` : null;
}
/** The page with the adjustments script, and a fresh copy each time. */
export const adjustPageUrl = (page: string, version = Date.now()) => `${page}?servant-adjust=1&v=${version}`;

// ---------- the change list ----------
const LENGTH = "(?:\\d{1,4}(?:\\.\\d{1,2})?(?:px|rem|em|%|vw|vh)|0)";
const VALUE_RULES: Record<AdjustStyle, RegExp> = {
  color: /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]{5,40}\)|[a-z]{3,20})$/i,
  "background-color": /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]{5,40}\)|[a-z]{3,20})$/i,
  "font-size": new RegExp(`^${LENGTH}$`),
  "font-weight": /^(normal|bold|[1-9]00)$/,
  "text-align": /^(left|center|right|justify|start|end)$/,
  padding: new RegExp(`^${LENGTH}(\\s+${LENGTH}){0,3}$`),
  margin: new RegExp(`^(${LENGTH}|auto)(\\s+(${LENGTH}|auto)){0,3}$`),
  "border-radius": new RegExp(`^${LENGTH}(\\s+${LENGTH}){0,3}$`),
  width: new RegExp(`^(${LENGTH}|auto|fit-content|max-content|min-content)$`),
  height: new RegExp(`^(${LENGTH}|auto|fit-content|max-content|min-content)$`),
};
const VAR = /^var\(--[A-Za-z0-9_-]{1,40}\)$/;
/** Whether a style value is one the page will accept (and that reads clearly in a request). Design-kit tokens, var(--name), always are. */
export const validStyleValue = (prop: AdjustStyle, value: string) => value.length <= 60 && (VALUE_RULES[prop].test(value.trim()) || VAR.test(value.trim()));

/** Measured values tidied for people: 13.3333px → 13.3px, 103.125px → 103px. */
export function tidyValue(value: string) {
  return value.replace(/(-?\d+\.\d+)px/g, (_, n: string) => {
    const rounded = Math.round(Number(n) * 10) / 10;
    return `${Math.abs(rounded - Math.round(rounded)) < 0.05 || Math.abs(rounded) >= 100 ? Math.round(rounded) : rounded}px`;
  });
}

const ref = (el: AdjustElement): ElementRef => ({ id: el.id, tag: el.tag, kind: el.kind, label: el.label, path: el.path });
/**
 * Adds a change, or updates the earlier change to the same thing. A change back
 * to how it started removes it. Moves add up in order. At most MAX_ADJUSTMENTS.
 */
export function addAdjustment(list: readonly Adjustment[], el: AdjustElement, prop: AdjustProp, to: string | boolean, scope?: AdjustScope): Adjustment[] {
  if (prop === "move") {
    if (to !== "earlier" && to !== "later") return [...list];
    const past = to === "earlier" ? el.previous : el.next;
    if (!past || list.length >= MAX_ADJUSTMENTS) return [...list];
    return [...list, { element: ref(el), prop: "move", to, past }];
  }
  // Text and comments are the same at every size.
  const sized = prop === "text" || prop === "comment" ? undefined : scope;
  const at = list.findIndex(item => item.element.id === el.id && item.prop === prop && ("scope" in item ? item.scope : undefined) === sized);
  const earlier = at >= 0 ? list[at]! : null;
  let next: Adjustment;
  if (prop === "comment") {
    if (typeof to !== "string") return [...list];
    const value = clean(to, 500);
    if (!value) return list.filter((_, index) => index !== at);
    next = { element: ref(el), prop, to: value };
  } else if (prop === "hidden") {
    if (typeof to !== "boolean") return [...list];
    const from = earlier?.prop === "hidden" ? earlier.from : sized ? false : el.original.hidden;
    next = { element: ref(el), prop, from, to, ...(sized ? { scope: sized } : {}) };
    if (from === to) return list.filter((_, index) => index !== at);
  } else {
    if (typeof to !== "string") return [...list];
    const value = prop === "text" ? to.slice(0, 2000) : to.trim();
    if (prop !== "text" && !validStyleValue(prop, value)) return [...list];
    if (prop === "text" && el.text === null) return [...list];
    // "from" is the page's exact value, so the agent can find it in the source; people see it rounded.
    const from = earlier && earlier.prop === prop ? (earlier as { from: string }).from : prop === "text" ? el.original.text ?? "" : el.original.styles[prop];
    next = prop === "text" ? { element: ref(el), prop, from, to: value } : { element: ref(el), prop, from, to: value, ...(sized ? { scope: sized } : {}) };
    if (from === value || (prop !== "text" && tidyValue(from) === value)) return list.filter((_, index) => index !== at);
  }
  if (at >= 0) return list.map((item, index) => index === at ? next : item);
  return list.length >= MAX_ADJUSTMENTS ? [...list] : [...list, next];
}
export const removeAdjustment = (list: readonly Adjustment[], index: number) => list.filter((_, i) => i !== index);
/** Every change to one element gone at once. */
export const removeElementAdjustments = (list: readonly Adjustment[], id: string) => list.filter(item => item.element.id !== id);
/** The changes by element, in the order first changed, for showing as one row each. */
export function groupAdjustments(list: readonly Adjustment[], { forPeople = true } = {}): { element: ElementRef; changes: string[] }[] {
  const groups: { element: ElementRef; changes: string[] }[] = [];
  for (const item of list) {
    let group = groups.find(g => g.element.id === item.element.id);
    if (!group) { group = { element: item.element, changes: [] }; groups.push(group); }
    group.changes.push(describeChange(item, { forPeople }));
  }
  return groups;
}

// ---------- design kit ----------
/** The token a value is, when it's one: "var(--brand)" → "--brand". */
export const tokenName = (value: string) => value.trim().match(/^var\((--[A-Za-z0-9_-]{1,40})\)$/)?.[1] ?? null;
const sameColor = (a: string, b: string) => { const x = parseColor(a), y = parseColor(b); return !!x && !!y && x.every((n, i) => Math.abs(n - y[i]!) < 0.01); };
/** Tokens that fit a property: colors for colors, sizes for sizes. */
export function tokensFor(prop: AdjustStyle, tokens: readonly DesignToken[]) {
  const color = prop === "color" || prop === "background-color";
  return tokens.filter(t => color ? !!parseColor(t.value) : !parseColor(t.value) && validStyleValue(prop, t.value));
}
/**
 * Whether a typed value sits outside the page's design kit: the kit has tokens
 * for this kind of property and the value is neither a token nor one of their values.
 */
export function offSystem(prop: AdjustStyle, value: string, tokens: readonly DesignToken[]) {
  const fitting = tokensFor(prop, tokens);
  if (!fitting.length || tokenName(value)) return false;
  const color = prop === "color" || prop === "background-color";
  return !fitting.some(t => color ? sameColor(t.value, value) : t.value.trim() === value.trim());
}

// ---------- contrast ----------
const NAMED: Record<string, [number, number, number]> = { white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128] };
/** [r, g, b, alpha] from #hex, rgb()/rgba() or a few names; null when unreadable. */
export function parseColor(value: string): [number, number, number, number] | null {
  const v = value.trim().toLowerCase();
  if (v === "transparent") return [0, 0, 0, 0];
  if (NAMED[v]) return [...NAMED[v]!, 1];
  const hex = v.match(/^#([0-9a-f]{3,8})$/)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length <= 4 ? [...hex].map(c => c + c).join("") : hex;
    const n = (i: number) => parseInt(full.slice(i * 2, i * 2 + 2), 16);
    return [n(0), n(1), n(2), full.length === 8 ? n(3) / 255 : 1];
  }
  const rgb = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
  return null;
}
const luminance = ([r, g, b]: number[]) => {
  const c = [r!, g!, b!].map(n => { const s = Math.min(255, n) / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
/** The WCAG contrast ratio of text over a background (a see-through text color is blended in); null when a color is unreadable. */
export function contrastRatio(text: string, background: string): number | null {
  const fg = parseColor(text), bg = parseColor(background);
  if (!fg || !bg) return null;
  const base = bg[3] < 1 ? [0, 1, 2].map(i => bg[i]! * bg[3] + 255 * (1 - bg[3])) : bg;
  const mixed = [0, 1, 2].map(i => fg[i]! * fg[3] + base[i]! * (1 - fg[3]));
  const [a, b] = [luminance(mixed), luminance(base)];
  return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
}
/** A ratio for people: one decimal, rounded down so a failing 4.48 never reads as a passing 4.5. */
export const ratioText = (ratio: number) => `${Math.floor(ratio * 10) / 10}:1`;
/** Large text (24px, or 18.66px bold) needs 3:1; other text 4.5:1 (WCAG 2.2 AA). */
export function contrastCheck(color: string, background: string, size: string, weight: string) {
  const px = Number.parseFloat(size), bold = Number(weight) >= 700 || weight === "bold";
  const needed = px >= 24 || (bold && px >= 18.66) ? 3 : 4.5;
  const ratio = contrastRatio(color, background);
  return { ratio, needed, ok: ratio === null || ratio >= needed };
}
const PROBLEM_TEXT: Record<ScanIssue["problem"], string> = {
  "no-lang": "Doesn't say what language it's in, so screen readers may mispronounce it.",
  "no-h1": "Has no main heading.",
  "heading-skip": "Skips a heading level.",
  "no-alt": "Has no alt text.",
  "no-name": "Has no name for screen readers.",
  "no-label": "Has no label.",
  "small-target": "Is smaller than 24 × 24 px, so it's hard to tap.",
};
export type Finding = { id: string | null; name: string; problem: string };
/** A finding turned into a comment for the agent (or, for the whole page, a line for the note). */
export const findingComment = (finding: Finding) => `Accessibility check: ${finding.name === "Page" ? "the page" : "this"} ${finding.problem.charAt(0).toLowerCase()}${finding.problem.slice(1)} Please fix it.`;
/** What the accessibility check found, contrast first. A quick check, not a full audit. */
export function scanFindings(issues: readonly ScanIssue[], texts: readonly ScannedText[]): Finding[] {
  const contrast = texts.flatMap(t => {
    const check = contrastCheck(t.color, t.backdrop, t.size, t.weight);
    return check.ok || check.ratio === null ? [] : [{ id: t.id, name: elementName(t), problem: `Has low text contrast: ${ratioText(check.ratio)} (needs ${check.needed}:1).` }];
  });
  return [...contrast, ...issues.map(i => ({ id: i.id, name: i.id ? elementName(i) : "Page", problem: PROBLEM_TEXT[i.problem] }))];
}

// ---------- words ----------
const STYLE_NAMES: Record<AdjustStyle, string> = {
  color: "text color", "background-color": "background color", "font-size": "font size", "font-weight": "font weight", "text-align": "text alignment",
  padding: "padding", margin: "margin", "border-radius": "corner radius", width: "width", height: "height",
};
const quote = (text: string, limit = 200) => `"${clean(text, limit).replace(/"/g, "'")}"`;
/** rgb(26, 115, 232) → #1a73e8, so colors read the way people write them. */
export function readableColor(value: string) {
  const rgb = value.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (!rgb) return value;
  if (rgb[4] !== undefined && Number(rgb[4]) === 0) return "transparent";
  return `#${[rgb[1], rgb[2], rgb[3]].map(n => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("")}`;
}
const shown = (prop: AdjustStyle, value: string, forPeople: boolean) =>
  (prop === "color" || prop === "background-color" ? readableColor(value) : forPeople ? tidyValue(value) : value) || "unset";
export const elementName = (el: Pick<ElementRef, "kind" | "label">) => el.label ? `${el.kind} ${quote(el.label, 60)}` : el.kind;
/** One change, in words: "text color #333333 → #1a73e8". For people, sizes are rounded; for the agent, they're exact. */
export function describeChange(item: Adjustment, { forPeople = true } = {}): string {
  if (item.prop === "text") return `change the text to ${quote(item.to, 2000)}`;
  if (item.prop === "comment") return `comment: ${quote(item.to, 500)}`;
  if (item.prop === "move") return `move it ${item.to === "earlier" ? "before" : "after"} ${elementName(item.past)}`;
  const where = item.scope ? ` (${SCOPE_WORDS[item.scope]})` : "";
  if (item.prop === "hidden") return `${item.to ? "hide it" : "show it again"}${where}`;
  return `${STYLE_NAMES[item.prop]} ${shown(item.prop, item.from, forPeople)} → ${shown(item.prop, item.to, forPeople)}${where}`;
}
/** The changes grouped by element, in the order first changed: "1. Heading "Your balance" (h1 at main > h1:nth-of-type(1)): …". */
export function adjustmentLines(list: readonly Adjustment[]): string[] {
  return groupAdjustments(list, { forPeople: false }).map((g, index) => `${index + 1}. ${elementName(g.element)} (${g.element.tag} at ${g.element.path}): ${g.changes.join("; ")}.`);
}
/**
 * A request or suggestion line as people read it: no CSS path, sizes rounded.
 * "1. Paragraph "Due" (p at main > p:nth-of-type(1)): font size 13.3333px → 16px." → "Paragraph "Due": font size 13.3px → 16px."
 */
export function readableLine(line: string) {
  return tidyValue(line.replace(/^\d{1,2}\. /, "").replace(/ \([a-z][a-z0-9-]* at [^)]*(?:\([^)]*\)[^)]*)*\):/, ":"));
}
// Said only when the list has these kinds of items.
function extraGuidance(lines: string) {
  return [
    ...(/sizes only, /.test(lines) ? ["A change marked for one screen size applies at that size only (use a media query for that width range)."] : []),
    ...(/: comment: "|; comment: "/.test(lines) ? ["Comments are notes, not exact changes: act on them where they're clear, and ask me about any that aren't."] : []),
    ...(/^Reviewer's note: /m.test(lines) ? ["The reviewer's note is context for me, not a change to make."] : []),
  ];
}
/** The request for the design's agent, left in the message box for the author to review and send. */
export function adjustmentPrompt({ title, page, list, note = "" }: { title: string; page: string; list: readonly Adjustment[]; note?: string }) {
  return [
    `Please apply these quick adjustments to the prototype "${clean(title, 120)}". I made them on the live preview (${page}); they aren't saved anywhere yet.`,
    "Find each element by its description and CSS path, change only what's listed, keep everything else as it is, then republish the preview.",
    ...extraGuidance(adjustmentLines(list).join("\n")),
    "",
    ...adjustmentLines(list),
    ...(note.trim() ? ["", `Also: ${clean(note, 1000)}`] : []),
  ].join("\n");
}
const SUGGESTION_HEADER = /^Suggested adjustments for (.{1,120}):$/;
/**
 * A reviewer's suggestion, posted as an ordinary reply in the design's review
 * thread. The lines keep each element's CSS path and exact values, because the
 * author can pass them to the agent; this app shows them as a card without those.
 */
export function suggestionText({ title, list, note = "" }: { title: string; list: readonly Adjustment[]; note?: string }) {
  return [
    `Suggested adjustments for ${clean(title, 120)}:`,
    ...adjustmentLines(list),
    ...(note.trim() ? [`Reviewer's note: ${clean(note, 1000)}`] : []),
    "Only the design's author can add these to their design chat.",
  ].join("\n");
}
/** A reply that's a suggestion: its title, its numbered changes and the reviewer's note. ("Note: " is how older replies labeled it.) */
export function parseSuggestion(text: string): { title: string; body: string; changes: string[]; note: string | null } | null {
  const lines = String(text || "").split("\n");
  const head = lines[0]?.match(SUGGESTION_HEADER);
  if (!head) return null;
  const changes = lines.slice(1).filter(line => /^\d{1,2}\. /.test(line));
  const noteLine = lines.slice(1).find(line => /^(Reviewer's note|Note): /.test(line));
  const note = noteLine ? noteLine.replace(/^(Reviewer's note|Note): /, "") : null;
  const body = [...changes, ...(note ? [`Reviewer's note: ${note}`] : [])].join("\n");
  return changes.length || note ? { title: head[1]!, body, changes, note } : null;
}
/** The request for the agent made from a reviewer's suggestion, for the author to review and send. */
export function suggestionPrompt({ reviewer, title, page, body }: { reviewer: string; title: string; page: string; body: string }) {
  return [
    `${clean(reviewer, 80) || "A reviewer"} suggested these quick adjustments to the prototype "${clean(title, 120)}" on its live preview (${page}). Please apply them.`,
    "Find each element by its description and CSS path, change only what's listed, keep everything else as it is, then republish the preview.",
    ...extraGuidance(body),
    "",
    body,
  ].join("\n");
}
/** A design-review message (designReviewText): its title and preview link, if it has one. */
export function parseDesignReview(text: string): { title: string; preview: string; status: string | null; focus: string | null } | null {
  const lines = String(text || "").split("\n");
  const title = lines[0]?.match(/^Design review: (.{1,200})$/)?.[1];
  const preview = lines.find(line => line.startsWith("Preview: "))?.slice("Preview: ".length).trim();
  if (!title || !preview || !/^https?:\/\//.test(preview)) return null;
  const field = (name: string) => lines.find(line => line.startsWith(`${name}: `))?.slice(name.length + 2).trim() || null;
  return { title, preview, status: field("Status"), focus: field("Review focus") };
}
