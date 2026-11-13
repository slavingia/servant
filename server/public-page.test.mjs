import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { landingPage, supportPage } from "./public-page.mjs";
import { termsPage } from "./terms-page.mjs";
import { privacyPage } from "./privacy-page.mjs";

test("support and terms show only the configured contact and keep it readable without JavaScript", () => {
  for (const render of [supportPage, termsPage]) {
    const html = render({ contactEmail: " privacy@example.gov " });
    assert.match(html, /<!--email_off--><a href="mailto:privacy@example\.gov">privacy@example\.gov<\/a><!--\/email_off-->/);
    assert.doesNotMatch(html, /<script/);
    assert.doesNotMatch(render(), /mailto:/);
    assert.doesNotMatch(render({ contactEmail: 'hello@example.gov"><script>bad</script>', footer: '<script>bad</script>' }), /<script>/);
    assert.doesNotMatch(render({ footer: "a".repeat(400) }), /a{301}/);
  }
});

test("public export has current pages and keeps app deep links separate from the landing page", () => {
  const pages = { site: landingPage, support: supportPage, privacy: privacyPage, terms: termsPage };
  for (const [name, render] of Object.entries(pages)) {
    assert.equal(fs.readFileSync(new URL(`../app/public/${name}/index.html`, import.meta.url), "utf8"), render());
  }
  const { rewrites } = JSON.parse(fs.readFileSync(new URL("../app/public/vercel.json", import.meta.url), "utf8"));
  const destination = route => rewrites.find(rule => new RegExp(`^${rule.source}$`).test(route))?.destination;
  assert.equal(destination("/"), "/site/index.html");
  for (const route of ["/support", "/privacy", "/terms"]) assert.equal(destination(route), `${route}/index.html`);
  for (const route of ["/welcome", "/pair", "/channels"]) assert.equal(destination(route), "/index.html");
});
