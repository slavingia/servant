const { withMod } = require("expo/config-plugins");
const author = require("../project-credit.json");

const CREDIT_ID = "SERVANT-ProjectCredit";
const COLOR = {
  key: "NSColor",
  red: String(210 / 255),
  green: String(223 / 255),
  blue: String(236 / 255),
  alpha: "1",
  colorSpace: "custom",
  customColorSpace: "sRGB",
};

function fragment(content, underline = false) {
  const attributes = {
    font: [{ $: { key: "NSFont", metaFont: "system", size: "13" } }],
    color: [{ $: COLOR }],
    paragraphStyle: [{ $: {
      key: "NSParagraphStyle", alignment: "center", lineBreakMode: "clipping",
      baseWritingDirection: "natural", minimumLineHeight: "20", maximumLineHeight: "20",
    } }],
  };
  if (underline) attributes.integer = [{ $: { key: "NSUnderline", value: "1" } }];
  return { $: { content }, attributes: [attributes] };
}

// Register before expo-splash-screen. Its provider runs the logo mod first,
// then this mod appends the footer without changing the logo's constraints.
// Launch storyboards are static: the functional link lives in ProjectCredit.
module.exports = config => withMod(config, {
  platform: "ios",
  mod: "splashScreenStoryboard",
  action: config => {
    const view = config.modResults.document?.scenes?.[0]?.scene?.[0]
      ?.objects?.[0]?.viewController?.[0]?.view?.[0];
    const safeArea = view?.viewLayoutGuide?.find(guide => guide.$.key === "safeArea")?.$.id;
    if (!view?.$.id || !safeArea || typeof author.name !== "string" || !author.name.trim()) {
      throw new Error("Launch credit needs an Expo launch storyboard with a safe area and project-credit.json name");
    }
    const frame = view.rect[0].$;
    view.subviews ??= [{}];
    view.subviews[0].label = (view.subviews[0].label || []).filter(label => label.$.id !== CREDIT_ID);
    view.subviews[0].label.push({
      $: {
        id: CREDIT_ID, userLabel: "Project credit", opaque: "NO", userInteractionEnabled: "NO",
        contentMode: "left", usesAttributedText: "YES", textAlignment: "center",
        lineBreakMode: "tailTruncation", numberOfLines: "1", baselineAdjustment: "alignBaselines",
        adjustsFontSizeToFit: "NO", translatesAutoresizingMaskIntoConstraints: "NO",
      },
      rect: [{ $: {
        key: "frame", x: "16", y: String(Number(frame.height) - 78),
        width: String(Number(frame.width) - 32), height: "20",
      } }],
      attributedString: [{ $: { key: "attributedText" }, fragment: [
        fragment("Personal project of "), fragment(author.name, true), fragment(" ↗"),
      ] }],
      constraints: [{ constraint: [{ $: {
        firstAttribute: "height", constant: "20", id: `${CREDIT_ID}-height`,
      } }] }],
    });
    view.constraints ??= [{ constraint: [] }];
    const constraints = view.constraints[0].constraint || [];
    view.constraints[0].constraint = constraints.filter(item => !item.$.id.startsWith(`${CREDIT_ID}-`));
    for (const [attribute, constant] of [["leading", "16"], ["trailing", "-16"], ["bottom", "-24"]]) {
      view.constraints[0].constraint.push({ $: {
        firstItem: CREDIT_ID, firstAttribute: attribute,
        secondItem: safeArea, secondAttribute: attribute,
        constant, id: `${CREDIT_ID}-${attribute}`,
      } });
    }
    return config;
  },
});
