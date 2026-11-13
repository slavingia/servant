import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const plugin = require("../../plugins/with-launch-credit.js");

test("reapplying the launch credit preserves the logo and adds only one footer", async () => {
  const logo = { $: { id: "logo", image: "SplashScreenLogo" } };
  const logoConstraints = ["centerX", "centerY"].map(attribute => ({
    $: { id: `logo-${attribute}`, firstItem: "logo", firstAttribute: attribute,
      secondItem: "container", secondAttribute: attribute },
  }));
  const existingLabel = { $: { id: "existing-label" } };
  const view = {
    $: { id: "container" },
    rect: [{ $: { width: "393", height: "852" } }],
    viewLayoutGuide: [{ $: { key: "safeArea", id: "safe-area" } }],
    subviews: [{ imageView: [structuredClone(logo)], label: [structuredClone(existingLabel)] }],
    constraints: [{ constraint: structuredClone(logoConstraints) }],
  };
  const storyboard = { document: { scenes: [{ scene: [{ objects: [{
    viewController: [{ view: [view] }],
  }] }] }] } };
  const config = plugin({ name: "test", slug: "test" });
  const apply = () => config.mods.ios.splashScreenStoryboard({
    ...config, modResults: storyboard, modRequest: {},
  });

  await apply();
  const firstResult = structuredClone(storyboard);
  await apply();

  assert.deepEqual(storyboard, firstResult, "a second prebuild cannot duplicate or shift the credit");
  assert.deepEqual(view.subviews[0].imageView, [logo], "the splash logo stays intact");
  assert.deepEqual(view.constraints[0].constraint.slice(0, 2), logoConstraints,
    "the logo remains centered independently of the footer");
  assert.deepEqual(view.subviews[0].label[0], existingLabel);
  assert.equal(view.subviews[0].label.length, 2, "exactly one footer is added");
  const footerId = view.subviews[0].label[1].$.id;
  const footerConstraints = view.constraints[0].constraint.filter(item => item.$.firstItem === footerId);
  assert.equal(footerConstraints.length, 3);
  assert.equal(new Set(footerConstraints.map(item => item.$.id)).size, 3);
});
