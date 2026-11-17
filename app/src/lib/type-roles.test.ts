// Type comes from the roles in the theme (docs/design-system.md, "Type"). The wide layout's sidebar had a size of
// its own (14/20) on every row, its section names and counts re-weighted the smallest role, a screen's header title
// was 16 points in the wide layout and nowhere else, and a handful of one-off sizes sat beside the roles: 13/20,
// 12/17, 19/26, 32 and 40. Initials in a small avatar were 0.4 of the circle: 7 points in the sidebar.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const style = (source: string, name: string) => source.match(new RegExp(`\\b${name}: \\{([^{}]*)\\}`))?.[1] ?? "";
const sources = (fs.readdirSync(root, { recursive: true, encoding: "utf8" }) as string[]).filter(file => /\.tsx$/.test(file)).sort();

test("the sidebar's rows, section names and counts are the body, label and captionStrong roles", () => {
  const sidebar = read("components/Sidebar.tsx");
  assert.match(style(sidebar, "itemLabel"), /^ \.\.\.typography\.body,/);
  assert.match(style(sidebar, "sectionTitle"), /^ \.\.\.typography\.label,/);
  assert.match(style(sidebar, "badge"), /^ \.\.\.typography\.captionStrong,/);
  assert.match(style(read("components/DeepWorkSwitch.tsx"), "navyLabel"), /^ \.\.\.typography\.body /);
  assert.match(style(read("components/WebTabBar.tsx"), "badgeText"), /^ \.\.\.typography\.captionStrong,/, "the tab bar's count is the same role as every other count");
  for (const file of ["components/Sidebar.tsx", "components/DeepWorkSwitch.tsx", "components/WebTabBar.tsx"]) assert.doesNotMatch(read(file), /\bfontSize: *\d/, `${file} sets a size of its own`);
});

test("a screen's header title is one style: the heading role when wide, bodyStrong on a phone", () => {
  assert.match(read("lib/theme.tsx"), /export const headerTitleType = \(wide: boolean\) => \{\s*const role = wide \? typography\.heading : typography\.bodyStrong;/);
  assert.match(read("app/_layout.tsx"), /headerTitleStyle: headerTitleType\(wide\),/);
  assert.match(read("app/chat/[id].tsx"), /const size = headerTitleType\(wide\);/);
  for (const file of ["app/_layout.tsx", "app/chat/[id].tsx"]) assert.doesNotMatch(read(file), /fontSize: 16\b/, file);
});

test("one-off sizes use the nearest role", () => {
  for (const [file, name, role] of [
    ["components/ProjectCredit.tsx", "text", "caption"], ["components/AgentSteps.tsx", "code", "meta"],
    ["components/MessageText.tsx", "h1", "heading"], ["components/MessageText.tsx", "code", "caption"], ["app/leaderboard.tsx", "totalValue", "display"], ["lib/typing.tsx", "text", "caption"],
  ] as const) assert.match(style(read(file), name), new RegExp(`^ \\.\\.\\.typography\\.${role}\\b`), `${file} ${name}`);
});

test("initials in a small avatar are one letter that can be read", () => {
  const messaging = read("components/Messaging.tsx");
  assert.match(messaging, /const SMALL_AVATAR = 26;/);
  assert.match(messaging, /\.slice\(0, small \? 1 : 2\)/);
  assert.match(messaging, /fontSize: Math\.round\(size \* \(small \? 0\.55 : 0\.4\)\)/);
  // The sidebar's 18-point avatar and a stage chip's 22: about 10 and 12 points, where two letters were 7 and 9.
  assert.ok(Math.round(18 * 0.55) >= 10 && Math.round(22 * 0.55) >= 12);
});

test("a picture is an icon from the set, not a character", () => {
  assert.match(read("components/AppIcon.tsx"), /\n  play: "/);
  for (const file of sources) assert.doesNotMatch(read(file), />[▶►✓✔✕✖×]</, `${file} draws an icon with a character`);
});
