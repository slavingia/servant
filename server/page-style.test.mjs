// The pages the server renders itself follow the design system through one stylesheet (page-style.mjs). Before it,
// each had its own: join used #202124 ink, #edf4fa buttons and a 12px corner; privacy #1b1b1b at 16px; the landing,
// support and terms pages #202124 at 17px with 8px corners; none followed dark mode or the workspace's color, and
// only some links were underlined.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageStyle } from "./page-style.mjs";
import { joinPage } from "./join-page.mjs";
import { landingPage, supportPage } from "./public-page.mjs";
import { privacyPage } from "./privacy-page.mjs";
import { termsPage } from "./terms-page.mjs";

const pages = {
  landing: theme => landingPage({ theme }),
  support: theme => supportPage({ theme, contactEmail: "privacy@example.gov" }),
  privacy: theme => privacyPage({ theme }),
  terms: theme => termsPage({ theme }),
  join: theme => joinPage({}, "https://servant.com", "", theme),
};
const styleOf = html => html.match(/<style>([\s\S]*?)<\/style>/)[1].trimStart();

test("the stylesheet is the app's palette, in light and dark", async () => {
  const { lightColors, darkColors } = await import("../app/src/lib/theme-colors.ts");
  const css = pageStyle();
  const [, light] = css.match(/:root\{color-scheme:light dark;([^}]*)\}/);
  const [, dark] = css.match(/@media \(prefers-color-scheme:dark\)\{:root\{([^}]*)\}\}/);
  for (const [declared, palette] of [[light, lightColors], [dark, darkColors]]) {
    const variables = [...declared.matchAll(/--(\w+):(#[0-9A-F]{6})/g)];
    assert.ok(variables.length >= 15, "found the variables");
    for (const [, name, value] of variables) assert.equal(value, palette[name].toUpperCase(), `--${name}`);
  }
  // Every color in the rules is one of those variables.
  const rules = css.replace(light, "").replace(dark, "");
  assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,8}\b/, "no color outside the variables");
});

test("links are always underlined, and buttons are the four kinds at 48 points", () => {
  const css = pageStyle();
  assert.match(css, /\na\{color:var\(--blue\);text-decoration:underline;/);
  assert.match(css, /\.button,\.primary,\.secondary,\.danger\{[^}]*min-height:48px;[^}]*border-radius:6px;/);
  assert.match(css, /\.button,\.primary\{background:var\(--primary\);color:var\(--onPrimary\)\}/);
  assert.match(css, /\.secondary\{background:var\(--background\);border-color:var\(--borderStrong\);color:var\(--ink\)\}/);
  assert.match(css, /\.danger\{background:var\(--background\);border-color:var\(--red\);color:var\(--red\)\}/, "destructive has a red outline");
  assert.match(css, /\.links a\{[^}]*min-height:44px;min-width:44px/, "links in a row are 44 points each way");
});

test("type and corners are the design system's", () => {
  const css = pageStyle();
  for (const [, px] of css.matchAll(/font-size:(\d+)px/g)) assert.ok([28, 18, 16, 15, 13].includes(Number(px)), `${px}px is not a type role (16 is the field size that stops iOS zooming)`);
  assert.match(css, /html\{font:15px\/22px /, "body");
  assert.match(css, /h1\{font-size:28px;line-height:34px/, "display");
  assert.match(css, /h2\{font-size:18px;line-height:24px/, "heading");
  for (const [, px] of css.matchAll(/border-radius:(\d+)px/g)) assert.ok([6, 10].includes(Number(px)), `corner ${px}px`);
});

test("every page starts with it and names no color of its own", () => {
  for (const [name, render] of Object.entries(pages)) {
    const html = render();
    const css = styleOf(html);
    assert.ok(css.startsWith(pageStyle()), `${name} uses the shared stylesheet`);
    assert.doesNotMatch(css.slice(pageStyle().length), /#[0-9a-fA-F]{3,8}\b/, `${name}'s own layout names no color`);
    assert.doesNotMatch(html.replace(/<style>[\s\S]*?<\/style>/, ""), /style="[^"]*(color|font-size)/, `${name} has no inline color or size`);
    assert.match(html, /<meta name="color-scheme" content="light dark">/, `${name} tells the browser it has both appearances`);
  }
});

test("every page takes the workspace's color", () => {
  for (const [name, render] of Object.entries(pages)) {
    const html = render({ primaryColor: "#7C3AED" });
    assert.match(html, /--primary:#7C3AED/, name);
    assert.doesNotMatch(styleOf(html), /#0071BC/i, `${name} has no default blue left`);
    assert.match(render({ primaryColor: "not a color" }), /--primary:#0071BC/, `${name} falls back to blue`);
  }
});

test("plain links on every page are underlined: only buttons and the wordmark are not", () => {
  for (const [name, render] of Object.entries(pages)) {
    const own = styleOf(render()).slice(pageStyle().length);
    const removed = [...own.matchAll(/([^{}]+)\{[^}]*text-decoration:none/g)].map(match => match[1].trim());
    assert.deepEqual(removed.filter(selector => selector !== "header a"), [], `${name}`);
  }
});
