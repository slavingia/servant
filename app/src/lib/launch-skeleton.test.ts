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
const plugin = require("../../plugins/with-launch-skeleton.js");
const config = JSON.parse(read("app.json")).expo;
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

test("the native launch screen has no logo and is the page's color", () => {
  const index = (name: string) => config.plugins.findIndex((entry: unknown) => (Array.isArray(entry) ? entry[0] : entry) === name);
  const splash = config.plugins[index("expo-splash-screen")][1];
  assert.deepEqual(splash, { backgroundColor: shape.colors.light.background, dark: { backgroundColor: shape.colors.dark.background } }, "a color for each appearance and no image");
  assert.ok(index("./plugins/with-launch-skeleton") >= 0 && index("./plugins/with-launch-skeleton") < index("expo-splash-screen"), "the skeleton registers first, so it runs after the storyboard is prepared");
  // A light status bar was for the navy logo screen; on a white page it would be invisible.
  assert.equal(config.ios.infoPlist.UIStatusBarStyle, undefined);
  assert.equal(fs.existsSync(path.join(app, "assets/splash-wordmark.png")), false);
});

// What expo-splash-screen hands on when no image is set: the template's storyboard with the logo's view taken
// out, and its constraints, its image and the system background left behind.
function storyboard() {
  return { document: {
    scenes: [{ scene: [{ objects: [{ viewController: [{ view: [{
      $: { id: "container" },
      rect: [{ $: { key: "frame", x: "0.0", y: "0.0", width: "393", height: "852" } }],
      subviews: [{ imageView: [] as unknown[] }],
      viewLayoutGuide: [{ $: { key: "safeArea", id: "safe-area" } }],
      constraints: [{ constraint: ["centerX", "centerY"].map(attribute => ({ $: { id: `logo-${attribute}`, firstItem: "logo", firstAttribute: attribute, secondItem: "container", secondAttribute: attribute } })) }],
      color: [{ $: { key: "backgroundColor", systemColor: "systemBackgroundColor" } }],
    }] }] }] }] }],
    resources: [{ image: [{ $: { name: "SplashScreenLogo", width: "100", height: "90" } }], systemColor: [{ $: { name: "systemBackgroundColor" } }] }],
  } };
}

test("the iOS launch screen draws the same bars from the top of the safe area", () => {
  const board = plugin.applyLaunchSkeleton(storyboard());
  const view = board.document.scenes[0].scene[0].objects[0].viewController[0].view[0];
  const drawn = view.subviews[0].view;
  assert.equal(drawn.length, phoneBars.length + 1, "one view per bar, and the rule under the filters");
  const pins = (id: string) => Object.fromEntries(view.constraints[0].constraint.filter((item: { $: { firstItem: string } }) => item.$.firstItem === id)
    .map((item: { $: { firstAttribute: string; secondItem: string; constant: string } }) => [item.$.firstAttribute, [item.$.secondItem, Number(item.$.constant)]]));
  const own = (item: { constraints: { constraint: { $: { firstAttribute: string; constant: string } }[] }[] }) => Object.fromEntries(item.constraints[0]!.constraint.map(c => [c.$.firstAttribute, Number(c.$.constant)]));
  phoneBars.forEach((bar, i) => {
    assert.deepEqual(pins(drawn[i].$.id), { leading: ["safe-area", bar.x], top: ["safe-area", bar.y] });
    assert.deepEqual(own(drawn[i]), { width: bar.width, height: bar.height });
    assert.deepEqual(drawn[i].color, [{ $: { key: "backgroundColor", name: "LaunchSkeleton" } }]);
    assert.equal(drawn[i].userDefinedRuntimeAttributes, undefined, "a launch screen may not use runtime attributes");
  });
  const rule = drawn.at(-1);
  assert.deepEqual(pins(rule.$.id), { leading: ["container", 0], trailing: ["container", 0], top: ["safe-area", shape.dividerY] });

  // Nothing of the logo is left to break the build: no constraint or image points at a view that is gone.
  const ids = new Set(["container", "safe-area", ...drawn.map((item: { $: { id: string } }) => item.$.id)]);
  for (const item of view.constraints[0].constraint) for (const id of [item.$.firstItem, item.$.secondItem]) assert.ok(id === undefined || ids.has(id), `${id} is not in the launch screen`);
  assert.deepEqual(board.document.resources[0].image, []);
  assert.equal(new Set(drawn.map((item: { $: { id: string } }) => item.$.id)).size, drawn.length);

  // The page's color in both appearances, not the system's, which is black in dark mode.
  assert.deepEqual(view.color, [{ $: { key: "backgroundColor", name: "SplashScreenBackground" } }]);
  assert.deepEqual(board.document.resources[0].namedColor.map((item: { $: { name: string } }) => item.$.name), ["SplashScreenBackground", "LaunchSkeleton"]);
  const hex = (color: { color: { components: Record<string, string> } }) => "#" + ["red", "green", "blue"].map(part => Math.round(Number(color.color.components[part]) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
  const set = plugin.colorSet();
  assert.deepEqual(set.colors.map(hex), [shape.colors.light.bar, shape.colors.dark.bar]);
  assert.deepEqual(set.colors[1].appearances, [{ appearance: "luminosity", value: "dark" }]);

  const once = structuredClone(board);
  assert.deepEqual(plugin.applyLaunchSkeleton(board), once, "a second prebuild adds nothing");
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
