const fs = require("fs");
const path = require("path");
const { IOSConfig, withDangerousMod, withMod } = require("expo/config-plugins");
const shape = require("../launch-skeleton.json");

// The iOS launch screen is Home's shape, not a logo: the same bars the app draws while it starts
// (src/components/LaunchScreen.tsx), measured from the top of the safe area, so the app appears to be
// there from the first frame. A launch screen is a still picture made of plain views: square corners
// (it allows no runtime attributes) in a color that follows light and dark.
const PREFIX = "SERVANT-Skeleton";
const COLOR = "LaunchSkeleton";
// expo-splash-screen's own color set: app.json's splash background, light and dark.
const BACKGROUND = "SplashScreenBackground";
const RULE = 0.5;

const components = hex => [1, 3, 5].map(at => (parseInt(hex.slice(at, at + 2), 16) / 255).toPrecision(15));

function bars() {
  const listTop = shape.dividerY + 1;
  return [...shape.header, ...shape.list.map(bar => ({ ...bar, y: bar.y + listTop }))];
}

function applyLaunchSkeleton(storyboard) {
  const view = storyboard.document?.scenes?.[0]?.scene?.[0]?.objects?.[0]?.viewController?.[0]?.view?.[0];
  const safeArea = view?.viewLayoutGuide?.find(guide => guide.$.key === "safeArea")?.$.id;
  if (!view?.$.id || !safeArea) throw new Error("The launch skeleton needs an Expo launch storyboard with a safe area");
  const container = view.$.id;
  const width = Number(view.rect?.[0]?.$.width) || 393;

  if (!view.subviews?.[0] || typeof view.subviews[0] !== "object") view.subviews = [{}];
  const subviews = view.subviews[0];
  subviews.view = (subviews.view || []).filter(item => !item.$.id.startsWith(PREFIX));
  if (!view.constraints?.[0] || typeof view.constraints[0] !== "object") view.constraints = [{}];
  const constraints = (view.constraints[0].constraint || []).filter(item => !item.$.id.startsWith(PREFIX));
  view.constraints[0].constraint = constraints;

  const add = (id, label, frame, own, pins) => {
    subviews.view.push({
      $: { id, userLabel: label, userInteractionEnabled: "NO", contentMode: "scaleToFill", translatesAutoresizingMaskIntoConstraints: "NO" },
      rect: [{ $: { key: "frame", x: String(frame.x), y: String(frame.y), width: String(frame.width), height: String(frame.height) } }],
      color: [{ $: { key: "backgroundColor", name: COLOR } }],
      constraints: [{ constraint: own.map(([attribute, constant]) => ({ $: { firstAttribute: attribute, constant: String(constant), id: `${id}-${attribute}` } })) }],
    });
    for (const [attribute, item, constant] of pins) {
      constraints.push({ $: { firstItem: id, firstAttribute: attribute, secondItem: item, secondAttribute: attribute, constant: String(constant), id: `${id}-${attribute}` } });
    }
  };

  bars().forEach((bar, i) => add(`${PREFIX}-${i + 1}`, "Skeleton bar", bar,
    [["width", bar.width], ["height", bar.height]],
    [["leading", safeArea, bar.x], ["top", safeArea, bar.y]]));
  // The rule under Home's filters runs edge to edge.
  add(`${PREFIX}-Rule`, "Skeleton rule", { x: 0, y: shape.dividerY, width, height: RULE },
    [["height", RULE]],
    [["leading", container, 0], ["trailing", container, 0], ["top", safeArea, shape.dividerY]]);

  // Without a logo, expo-splash-screen takes the logo's view out and leaves three things behind: the
  // constraints that centered it, its image in the resources, and the template's system background, which
  // is black in dark mode. Drop what points at nothing, and use the page's own color in both appearances.
  const present = new Set([container, safeArea, ...Object.values(subviews).flatMap(items => Array.isArray(items) ? items.map(item => item.$?.id) : [])]);
  view.constraints[0].constraint = constraints.filter(item => [item.$.firstItem, item.$.secondItem].every(id => id === undefined || present.has(id)));
  view.color = [{ $: { key: "backgroundColor", name: BACKGROUND } }];

  const resources = storyboard.document.resources?.[0] && typeof storyboard.document.resources[0] === "object"
    ? storyboard.document.resources[0] : (storyboard.document.resources = [{}])[0];
  const pictures = new Set((subviews.imageView || []).map(item => item.$.image));
  if (resources.image) resources.image = resources.image.filter(item => pictures.has(item.$.name));
  const named = (name, hex) => {
    const [red, green, blue] = components(hex);
    return { $: { name }, color: [{ $: { alpha: "1.000", blue, green, red, customColorSpace: "sRGB", colorSpace: "custom" } }] };
  };
  resources.namedColor = [
    ...(resources.namedColor || []).filter(item => item.$.name !== COLOR && item.$.name !== BACKGROUND),
    named(BACKGROUND, shape.colors.light.background),
    named(COLOR, shape.colors.light.bar),
  ];
  return storyboard;
}

// The bars' color in the asset catalog, with its dark appearance beside it.
function colorSet() {
  const entry = (hex, appearances) => {
    const [red, green, blue] = components(hex);
    return { color: { "color-space": "srgb", components: { alpha: "1.000", blue, green, red } }, idiom: "universal", ...(appearances ? { appearances } : {}) };
  };
  return {
    colors: [entry(shape.colors.light.bar), entry(shape.colors.dark.bar, [{ appearance: "luminosity", value: "dark" }])],
    info: { version: 1, author: "servant" },
  };
}

// Register before expo-splash-screen. Its provider prepares the storyboard first (the background, no
// logo), then this mod adds the bars.
function withLaunchSkeleton(config) {
  config = withMod(config, {
    platform: "ios",
    mod: "splashScreenStoryboard",
    action: config => {
      config.modResults = applyLaunchSkeleton(config.modResults);
      return config;
    },
  });
  return withDangerousMod(config, ["ios", async config => {
    const folder = path.join(IOSConfig.Paths.getSourceRoot(config.modRequest.projectRoot), "Images.xcassets", `${COLOR}.colorset`);
    await fs.promises.mkdir(folder, { recursive: true });
    await fs.promises.writeFile(path.join(folder, "Contents.json"), JSON.stringify(colorSet(), null, 2));
    return config;
  }]);
}

module.exports = withLaunchSkeleton;
module.exports.applyLaunchSkeleton = applyLaunchSkeleton;
module.exports.colorSet = colorSet;
module.exports.bars = bars;
