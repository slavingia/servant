// Controls are at least 44 points by their own size (docs/design-system.md, "Space and shape"). Hit slop does
// nothing in a browser or the Mac app, so a control that leans on it is as small there as it is drawn: the work
// email nudge's button was 32 points and its close 28, the wide layout's Back was 30 points tall, a project's
// release rows and stage chips were 32, the browser's own switch is 40 by 20, and a dialog's close was the 18-point
// icon alone.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const style = (source: string, name: string) => source.match(new RegExp(`\\n  ${name}: \\{([^\\n]*)\\},`))?.[1] ?? "";
const screens = (fs.readdirSync(root, { recursive: true, encoding: "utf8" }) as string[]).filter(file => /\.tsx$/.test(file)).sort();

// Opening tags of one component, read character by character so "=>" and braces in props do not end them early.
function openingTags(source: string, name: string): { text: string; line: number }[] {
  const tags: { text: string; line: number }[] = [];
  for (let from = 0; ;) {
    const start = source.indexOf(`<${name}`, from);
    if (start < 0) return tags;
    if (!/[\s>]/.test(source[start + name.length + 1] ?? "")) { from = start + 1; continue; }
    let depth = 0, quote = "", end = start;
    for (; end < source.length; end++) {
      const c = source[end]!;
      if (quote) { if (c === quote && source[end - 1] !== "\\") quote = ""; continue; }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    tags.push({ text: source.slice(start, end + 1), line: source.slice(0, start).split("\n").length });
    from = end + 1;
  }
}
const heights = (declaration: string) => [...declaration.matchAll(/\b(?:minHeight|height): (\d+)\b/g)].map(match => Number(match[1]));

// A pressable's styles that set a height under 44. The wide layout's sidebar is the one place that stays compact
// (32-point rows, 26-point section headers): it is a dense list for a mouse or trackpad, and taller rows there were
// tried and turned down.
const COMPACT: Record<string, string[]> = {
  "components/Sidebar.tsx": ["iconButton", "item", "sectionToggle", "sectionAdd"],
  "components/Omnibar.tsx": ["sidebarTrigger"],
  "components/DeepWorkSwitch.tsx": ["navyRow"],
};
function undersized(source: string, compact: string[] = []): string[] {
  const found: string[] = [];
  for (const tag of openingTags(source, "Pressable")) {
    const names = [...new Set([...tag.text.matchAll(/styles\.(\w+)/g)].map(match => match[1]!))];
    for (const name of names) {
      const low = heights(style(source, name)).filter(size => size < 44);
      if (low.length && !compact.includes(name)) found.push(`line ${tag.line}: ${name} is ${low.join(" and ")} points`);
    }
    const inline = tag.text.match(/style=\{\{([^]*?)\}\}/)?.[1] ?? "";
    for (const size of heights(inline)) if (size < 44) found.push(`line ${tag.line}: an inline height of ${size} points`);
  }
  return found;
}

test("the detector reads a control's own height, and passes only a style that is listed", () => {
  const sheet = (rows: string) => `\nconst useStyles = () => StyleSheet.create({${rows}\n});`;
  assert.deepEqual(undersized(`<Pressable onPress={() => { go(); }} style={styles.row}>` + sheet(`\n  row: { minHeight: 32, flexDirection: "row" },`)), ["line 1: row is 32 points"]);
  assert.deepEqual(undersized(`<Pressable style={state => [styles.row, hovered(state) && styles.hovered]}>` + sheet(`\n  row: { minHeight: 32 },`), ["row"]), []);
  assert.deepEqual(undersized(`<Pressable style={{ minHeight: 28, justifyContent: "center" }}>`), ["line 1: an inline height of 28 points"]);
  assert.deepEqual(undersized(`<Pressable style={styles.target}><View style={styles.pill} /></Pressable>` + sheet(`\n  target: { minHeight: 44 },\n  pill: { minHeight: 32 },`)), [], "a small picture inside a full-size control is fine");
});

test("no control sets its own height under 44 points, apart from the wide layout's sidebar", () => {
  const small = screens.flatMap(file => undersized(read(file), COMPACT[file]).map(found => `${file} ${found}`));
  assert.deepEqual(small, [], "make the control 44 points, or put the smaller shape inside a 44-point control");
  for (const [file, names] of Object.entries(COMPACT)) for (const name of names) assert.ok(heights(style(read(file), name)).some(size => size < 44), `${file} ${name} is still compact; take it off the list if not`);
});

test("no control leans on hit slop", () => {
  const leaning = screens.filter(file => /\bhitSlop=/.test(read(file)));
  assert.deepEqual(leaning, [], "hit slop does nothing in a browser or the Mac app: give the control a real size");
});

test("an icon alone is pressed in a 44-point square", () => {
  const button = read("components/Button.tsx");
  assert.match(button, /export const ICON_TARGET = 44;/);
  assert.match(style(button, "icon"), /width: ICON_TARGET, height: ICON_TARGET/);
  // The closes that were an 18-point icon with hit slop around it.
  for (const [file, label] of [["components/ForwardSheet.tsx", "Cancel"], ["app/channel-info.tsx", "Hide details"], ["app/chat/[id].tsx", "Hide full title"], ["app/chat/[id].tsx", "Remove waiting message"], ["app/chat/[id].tsx", "Don't forward this message"]] as const) {
    assert.match(read(file), new RegExp(`<IconButton icon="close" label="${label}"`), `${file}: ${label}`);
  }
  // A close is the close icon, not the letter-like sign.
  for (const file of screens) assert.doesNotMatch(read(file), />[✕✖×]</, `${file} draws a close with a character`);
});

test("a small shape sits inside a 44-point control", () => {
  const releases = read("components/ProjectReleases.tsx");
  assert.match(style(releases, "chipTarget"), /minHeight: 44/);
  assert.match(releases, /style=\{\(\{ pressed \}\) => \[styles\.chipTarget,[^\n]*\n\s*<View style=\{\[styles\.chip,/, "the stage chip's pill is the picture, not the control");
  assert.match(style(releases, "cardHead"), /minHeight: 44/);
  const chat = read("app/chat/[id].tsx");
  assert.match(style(chat, "aboutTarget"), /minHeight: 44/);
  assert.match(chat, /minHeight: 44, minWidth: 44, alignItems: "center"/, "a header link is 44 points wide as well as tall");
  const messaging = read("components/Messaging.tsx");
  assert.match(messaging, /width: Math\.max\(size, AVATAR_TARGET\), height: Math\.max\(size, AVATAR_TARGET\)/, "an avatar that opens a direct message");
});

test("the work email nudge is a small pill and a corner close, each inside a 44-point control", () => {
  const nudge = read("components/EmailNudge.tsx");
  assert.match(style(nudge, "actionTarget"), /minHeight: 44/);
  assert.match(style(nudge, "action"), /minHeight: 32, justifyContent: "center", paddingHorizontal: space\.sm, borderRadius: radius\.sm, backgroundColor: colors\.primary/, "the pill as it was drawn before");
  assert.match(style(nudge, "actionText"), /\.\.\.typography\.captionStrong/);
  assert.match(nudge, /<IconButton icon="close" size=\{16\} label="Not now"/);
  assert.doesNotMatch(nudge, /hitSlop/);
  assert.doesNotMatch(nudge, /<Button label="Add work email"/, "not the large button: it read as an unexplained main action");
});

test("the wide layout's Back is a 44-point chevron with no word", () => {
  const back = read("components/WideBack.tsx");
  assert.match(back, /<IconButton icon="back" label="Back"/, "an icon button, so it keeps the 44-point target and its spoken name");
  assert.doesNotMatch(back, />Back</, "no visible word beside the chevron");
  assert.match(back, /icon="back"[^>]*color=\{colors\.blue\}/, "the chevron stays link blue");
});
