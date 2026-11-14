// Opening Servant shows the signed-in app's shape, not a logo (docs/design-system.md, "Screen states"). The
// shape is drawn in four places that hand over to each other: the iOS launch screen, the web page before its
// script loads, the launch screen while the saved account is read, and Home while its list loads. These tests
// keep them the same shape in the same colors, so nothing moves or flashes between them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { darkColors, lightColors } from "./theme-colors.ts";

const require = createRequire(import.meta.url);
const app = path.join(import.meta.dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(app, file), "utf8");
type Bar = { x: number; y: number; width: number; height: number };
type Shape = { colors: Record<"light" | "dark", { background: string; bar: string }>; header: Bar[]; dividerY: number; listHeight: number; list: Bar[] };
const shape: Shape = require("../../launch-skeleton.json");
const listTop = shape.dividerY + 1;
const phoneBars: Bar[] = [...shape.header, ...shape.list.map(bar => ({ ...bar, y: bar.y + listTop }))];

test("the shapes are drawn in the page's own colors, light and dark", () => {
  assert.deepEqual(shape.colors.light, { background: lightColors.background, bar: lightColors.line });
  assert.deepEqual(shape.colors.dark, { background: darkColors.background, bar: darkColors.line });
});

test("the phone's shapes fit the smallest phone and sit on Home's rows", () => {
  for (const bar of phoneBars) {
    assert.ok(bar.width > 0 && bar.height > 0 && bar.x >= 0 && bar.y >= 0);
    assert.ok(bar.x + bar.width <= 320, `a bar ends at ${bar.x + bar.width}, past a 320-point phone`);
  }
  for (const bar of shape.header) assert.ok(bar.y + bar.height <= shape.dividerY, "the title and filters sit above the rule");
  for (const bar of shape.list) assert.ok(bar.y + bar.height <= shape.listHeight);
  // Home's rows are 44 points and a section starts 12 below the last (ChannelList.tsx): every row's glyph and
  // name share a middle, and the middles are 44 apart inside a section.
  const names = shape.list.filter(bar => bar.x === 54);
  const glyphs = shape.list.filter(bar => bar.x === 19);
  assert.equal(names.length, glyphs.length);
  const middles = names.map(bar => bar.y + bar.height / 2);
  names.forEach((bar, i) => assert.equal(glyphs[i]!.y + glyphs[i]!.height / 2, middles[i]));
  for (let i = 1; i < middles.length; i++) assert.ok([44, 100].includes(middles[i]! - middles[i - 1]!), "44 to the next row, or 100 across a section's name");
});

test("the app's launch screen and Home's loading rows are the same shapes", () => {
  const launch = read("src/components/LaunchScreen.tsx");
  assert.doesNotMatch(launch, /ServantWordmark|ProjectCredit/, "no logo on the launch screen");
  assert.match(launch, /<Bars bars=\{shape\.header\} \/>/);
  assert.match(launch, /<HomeListBars \/>/);
  assert.match(launch, /phoneHeader: \{ height: shape\.dividerY \}/);
  const skeleton = read("src/components/HomeSkeleton.tsx");
  assert.match(skeleton, /<Bars bars=\{shape\.list\} \/>/);
  assert.match(skeleton, /list: \{ height: shape\.listHeight \}/);
  // Home, the wide Home and the sidebar keep those shapes until their lists arrive.
  assert.match(read("src/components/ChannelList.tsx"), /<HomeListSkeleton label="Loading conversations" \/>/);
  assert.match(read("src/components/DesktopHome.tsx"), /loading \? <RecentSkeleton label="Loading recent conversations" \/>/);
  assert.match(read("src/components/Sidebar.tsx"), /conversations === null && !error \? <SidebarRowsSkeleton label="Loading channels" \/>/);
  // Every pulse starts at full strength, as the still frames before it are drawn.
  assert.match(read("src/components/Skeleton.tsx"), /new Animated\.Value\(1\)/);
});
