import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { joinPage } from "./join-page.mjs";

const key = "02" + "ab".repeat(32);
const discovery = "https://gist.githubusercontent.com/team/invite/raw/hub.json";
const params = new URLSearchParams({ code: "ABCDE-FGH23", key, d: discovery });
const webInvite = "https://team.servant.com/join?" + params;

// Exercise the actual inline script with browser input events, without a DOM dependency.
function page(url = "https://team.servant.com/join", navigator = {}, html = joinPage()) {
  const elements = Object.fromEntries([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => [id, {
    value: "", hidden: /\bhidden\b/.test(tag), disabled: /\bdisabled\b/.test(tag),
    action: tag.match(/action="([^"]+)"/)?.[1],
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
    focus() { this.focused = true; },
    select() { this.selected = true; },
  }]));
  const location = { href: url, search: new URL(url).search, origin: new URL(url).origin, protocol: new URL(url).protocol };
  vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], {
    document: { getElementById: id => elements[id] ?? null }, location, navigator, URL, URLSearchParams,
  });
  return {
    elements, location,
    paste(text) { elements.invite.value = text; elements.invite.oninput(); },
    submit() { elements.join.onsubmit({ preventDefault() {} }); },
  };
}

test("an invite is prefilled without opening an app; Continue preserves its pin and discovery on the web", () => {
  const p = page(webInvite + "&utm_source=mail");
  assert.equal(p.elements.invite.value, webInvite + "&utm_source=mail");
  assert.equal(p.location.href, webInvite + "&utm_source=mail", "loading the page never launches an app");
  assert.equal(p.elements.continue.disabled, false);
  assert.equal(p.elements.error.hidden, true);
  assert.equal(p.elements["app-actions"].hidden, false);
  assert.equal(p.elements.open.href, "servant://pair?" + params);
  p.submit();
  const target = new URL(p.location.href);
  assert.equal(target.origin + target.pathname, "https://servant.com/pair");
  assert.deepEqual([...target.searchParams], [...params]);
});

test("bare join and welcome pages accept pasted app or web invites, including links inside a message", () => {
  for (const route of ["/join", "/welcome", "/"]) {
    for (const link of [webInvite, "servant://pair?" + params]) {
      const p = page("https://team.servant.com" + route);
      assert.equal(p.elements.invite.value, "");
      assert.equal(p.elements.continue.disabled, true);
      p.paste("You are invited: " + link);
      assert.equal(p.elements.continue.disabled, false);
      p.submit();
      assert.equal(p.location.href, "https://servant.com/pair?" + params);
    }
  }
});

test("invalid or incomplete invites leave the form editable and never navigate", () => {
  for (const query of ["code=oops", "code=ABCDE-FGH23", params + "&server=javascript:alert(1)", String(params).replace(key, "bad-key"), String(params).replace("https%3A", "http%3A")]) {
    const url = "https://team.servant.com/join?" + query;
    const p = page(url);
    assert.equal(p.elements.error.hidden, false);
    p.submit();
    assert.equal(p.location.href, url);
    assert.equal(p.elements.invite.focused, true);
    assert.equal(p.elements["app-actions"].hidden, true);
    p.paste(webInvite);
    assert.equal(p.elements.error.hidden, true);
    p.submit();
    assert.equal(p.location.href, "https://servant.com/pair?" + params);
  }
});

test("editing a prefilled invite updates both web and native actions", () => {
  for (const field of ["server", "hub"]) {
    const p = page(webInvite);
    const other = new URLSearchParams({ code: "zfb5w-ukj68", key, [field]: "https://other.servant.com" });
    p.paste("servant://pair?" + other);
    other.set("code", "ZFB5W-UKJ68");
    assert.equal(p.elements.open.href, "servant://pair?" + other);
    p.submit();
    assert.equal(p.location.href, "https://servant.com/pair?" + other);
  }
});

test("Mac download appears only on Macs, above the iPhone download and below Continue", () => {
  for (const [platform, maxTouchPoints, hidden] of [["MacIntel", 0, false], ["MacIntel", 5, true], ["iPhone", 5, true], ["Win32", 0, true], ["Linux x86_64", 0, true]]) {
    assert.equal(page(webInvite, { platform, maxTouchPoints }).elements["mac-download"].hidden, hidden);
  }
  assert.match(joinPage({ ios: "https://testflight.apple.com/join/EXAMPLE1" }), /Continue in browser[\s\S]*Download for Mac[\s\S]*Download for iPhone/);
  // Store links come only from config: with none configured there is no iPhone or Android link.
  assert.doesNotMatch(joinPage(), /Download for iPhone|Download for Android/);
  assert.match(joinPage({ ios: "https://apps.apple.com/app/id123456789" }), /Download on the App Store/);
  assert.doesNotMatch(joinPage({ ios: "https://apps.apple.com/app/id123456789" }), /TestFlight/);
});

test("the join page's primary action meets WCAG AA text contrast, in both appearances and for a workspace color", () => {
  const luminance = hex => {
    const value = hex.length === 4 ? hex.slice(1).split("").map(c => c + c).join("") : hex.slice(1);
    return [0.2126, 0.7152, 0.0722].reduce((sum, weight, i) => {
      const c = parseInt(value.slice(i * 2, i * 2 + 2), 16) / 255;
      return sum + weight * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    }, 0);
  };
  for (const theme of [undefined, { primaryColor: "#7C3AED" }, { primaryColor: "#FFCC00" }]) {
    const html = joinPage({}, "https://servant.com", "", theme);
    assert.match(html, /\.button,\.primary\{background:var\(--primary\);color:var\(--onPrimary\)\}/, "the primary button is filled with the theme's primary");
    // The variables are declared once for light and once for dark.
    const declared = [...html.matchAll(/--primary:(#[0-9A-F]{6});--onPrimary:(#[0-9A-F]{6})/gi)];
    assert.equal(declared.length, 2);
    for (const [, background, foreground] of declared) {
      const values = [luminance(background), luminance(foreground)].sort((a, b) => b - a);
      assert.ok((values[0] + 0.05) / (values[1] + 0.05) >= 4.5, `${foreground} on ${background}`);
    }
  }
});

test("copy produces a usable web invite, with a selectable input when clipboard permission is unavailable", async () => {
  let copied;
  const p = page(webInvite, { clipboard: { writeText: async text => { copied = text; } } });
  p.elements.copy.onclick();
  await Promise.resolve();
  assert.equal(copied, "https://servant.com/join?" + params);
  assert.equal(p.elements.copy.textContent, "Copied");
  const denied = page(webInvite);
  denied.elements.copy.onclick();
  await Promise.resolve();
  assert.equal(denied.elements.invite.selected, true);
});

test("download and web-app URLs are safe and configurable, and the generated public page stays current", () => {
  assert.doesNotMatch(joinPage({ ios: "javascript:alert(1)", mac: "javascript:alert(1)" }), /javascript:/);
  assert.match(joinPage({ android: "https://play.google.com/x?a=1&b=2" }), /href="https:\/\/play.google.com\/x\?a=1&amp;b=2"/);
  assert.throws(() => joinPage({}, "javascript:alert(1)"));
  const p = page(webInvite, {}, joinPage({}, "https://app.example.com"));
  p.submit();
  assert.equal(new URL(p.location.href).origin, "https://app.example.com");
  assert.equal(fs.readFileSync(new URL("../app/public/join/index.html", import.meta.url), "utf8"), joinPage());
});

test('the join page shows the optional footer, escaped and capped, and nothing when unset', () => {
  const note = 'A personal project of Pat Tester, who does not speak for any agency';
  assert.match(joinPage({}, 'https://servant.example', note), /<p class="footer"[^>]*>A personal project of Pat Tester, who does not speak for any agency<\/p>\n<\/main>/);
  assert.doesNotMatch(joinPage(), /class="footer"/);
  assert.doesNotMatch(joinPage({}, 'https://servant.example', '<script>x</script>'), /<script>x/);
  assert.doesNotMatch(joinPage({}, 'https://servant.example', 'a'.repeat(400)), /a{301}/);
});

// The same example the app shows on Welcome, so a person can tell the link from the message around it.
test("the join page shows what an invite link looks like, and the example is one it accepts", async () => {
  const { INVITE_EXAMPLE } = await import("./join-page.mjs");
  assert.match(joinPage(), /<p id="invite-example" class="hint">Example: https:\/\/servant\.example\.gov\/join\?code=ABCDE-FGH23<\/p>/);
  assert.match(joinPage(), /aria-describedby="invite-example error"/);
  const app = fs.readFileSync(new URL("../app/src/lib/invite.ts", import.meta.url), "utf8");
  assert.ok(app.includes(`export const INVITE_EXAMPLE = "${INVITE_EXAMPLE}";`), "the app and the page show the same example");
  const p = page();
  p.paste(`${INVITE_EXAMPLE}&server=${encodeURIComponent("https://servant.example.gov")}`);
  assert.equal(p.elements["app-actions"].hidden, false, "with where the server is, it is a complete invite");
});
