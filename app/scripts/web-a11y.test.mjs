// Browser-level accessibility checks for the research pilot screens, run in a
// real browser against the local /research-preview (synthetic data only; it
// makes no API, session or storage calls). Checks what the DOM actually
// renders and what the keyboard actually does.
//
//   npm run test:web                      (starts the Expo web dev server itself)
//   SERVANT_PREVIEW_URL=http://127.0.0.1:8081/research-preview npm run test:web
//
// Needs Playwright with Chromium (`npm i -g playwright && npx playwright install chromium`).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const require = createRequire(import.meta.url);
let playwright = null;
try { playwright = require("playwright"); } catch { /* reported below */ }
const skip = playwright ? false : "Playwright isn't installed";
const port = Number(process.env.SERVANT_WEB_TEST_PORT || 8093);
const url = process.env.SERVANT_PREVIEW_URL || `http://127.0.0.1:${port}/research-preview`;
let server = null, browser = null, page = null;

before(async () => {
  if (skip) return;
  if (!process.env.SERVANT_PREVIEW_URL) {
    server = spawn("npx", ["expo", "start", "--web", "--port", String(port)], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, CI: "1", BROWSER: "none" }, stdio: "ignore", detached: true });
    for (let i = 0; i < 180; i++) {
      try { if ((await fetch(url)).ok) break; } catch { /* starting */ }
      await sleep(1000);
    }
  }
  browser = await playwright.chromium.launch();
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(url, { waitUntil: "networkidle", timeout: 180000 });
  await page.getByText("Prototype for this study").first().waitFor({ timeout: 180000 });
});
after(async () => {
  await browser?.close();
  if (server) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* already stopped */ } }
});

const groups = () => page.evaluate(() => [...document.querySelectorAll('[role="radiogroup"]')].map(group => ({
  label: group.getAttribute("aria-label"),
  radios: [...group.querySelectorAll('[role="radio"]')].map(radio => ({ checked: radio.getAttribute("aria-checked"), tabIndex: radio.getAttribute("tabindex"), name: radio.getAttribute("aria-label") || radio.textContent })),
})));
const group = label => page.locator(`[role="radiogroup"][aria-label="${label}"]`);
const focusedName = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent);

test("every rendered radio has aria-checked, and each group has one Tab stop", { skip }, async () => {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), "no horizontal scrolling at 390px");
  const all = await groups();
  assert.ok(all.length >= 8, `found ${all.length} radio groups`);
  for (const { label, radios } of all) {
    assert.ok(label, "every radio group is labelled");
    assert.ok(radios.length > 0, `${label} has radios`);
    for (const radio of radios) assert.ok(["true", "false"].includes(radio.checked), `${label} › ${radio.name}: aria-checked=${radio.checked}`);
    assert.ok(radios.filter(radio => radio.checked === "true").length <= 1, `${label}: at most one checked`);
    assert.equal(radios.filter(radio => radio.tabIndex === "0").length, 1, `${label}: exactly one radio in the Tab order`);
    const checked = radios.findIndex(radio => radio.checked === "true");
    if (checked >= 0) assert.equal(radios[checked].tabIndex, "0", `${label}: the checked radio is the Tab stop`);
  }
});

test("Arrow keys, Home and End move focus and selection within a radio group; Tab leaves it", { skip }, async () => {
  const devices = group("Devices");
  const radios = devices.locator('[role="radio"]');
  await radios.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await radios.nth(1).getAttribute("aria-checked"), "true");
  assert.equal(await radios.nth(0).getAttribute("aria-checked"), "false");
  assert.equal(await focusedName(), "Laptops and desktops only");
  assert.equal(await radios.nth(1).getAttribute("tabindex"), "0", "the Tab stop follows the selection");
  await page.keyboard.press("ArrowDown");
  assert.equal(await radios.nth(0).getAttribute("aria-checked"), "true", "wraps around");
  await page.keyboard.press("End");
  assert.equal(await radios.nth(1).getAttribute("aria-checked"), "true");
  await page.keyboard.press("Home");
  assert.equal(await radios.nth(0).getAttribute("aria-checked"), "true");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await radios.nth(1).getAttribute("aria-checked"), "true");
  await page.keyboard.press("Tab");
  const inGroup = await page.evaluate(() => !!document.activeElement?.closest('[role="radiogroup"][aria-label="Devices"]'));
  assert.equal(inGroup, false, "Tab moves out of the group instead of through each radio");
  await radios.nth(0).click();
});

test("arrowing across Method only moves focus; the activity and its details stay as they were (audit 1)", { skip }, async () => {
  const method = page.locator('[role="radiogroup"][aria-label="Method"]').first();
  const radios = method.locator('[role="radio"]');
  const designA = page.getByLabel("Design A name").first();
  const checkedName = () => method.locator('[role="radio"][aria-checked="true"]').textContent();
  assert.equal(await checkedName(), "A/B implementation test");
  const stop = () => page.getByLabel(/^Stopping rule/).first().inputValue();
  const before = { name: await designA.inputValue(), rate: await page.getByLabel(/Expected control rate/).first().inputValue(), stop: await stop() };
  assert.ok(before.stop.length > 0);
  await radios.nth(1).focus();
  for (const key of ["ArrowRight", "ArrowRight", "ArrowLeft", "End", "Home", "ArrowLeft"]) {
    await page.keyboard.press(key);
    assert.equal(await checkedName(), "A/B implementation test", `${key} doesn't choose a method`);
  }
  assert.equal(await focusedName(), "Survey", "focus moved (Home, then wrapped to the last method)");
  assert.equal(await designA.inputValue(), before.name);
  assert.equal(await page.getByLabel(/Expected control rate/).first().inputValue(), before.rate);
  assert.equal(await radios.nth(1).getAttribute("tabindex"), "0", "the Tab stop stays on the chosen method");
  const describedBy = await method.getAttribute("aria-describedby");
  assert.match(await page.evaluate(id => document.getElementById(id)?.textContent, describedBy), /Space or Enter chooses one/);
  // Space chooses; switching back restores what was entered for A/B.
  await page.keyboard.press("Space");
  assert.equal(await checkedName(), "Survey");
  assert.equal(await page.getByLabel("Design A name").count(), 0);
  await radios.nth(1).focus();
  await page.keyboard.press("Enter");
  assert.equal(await checkedName(), "A/B implementation test");
  assert.equal(await page.getByLabel("Design A name").first().inputValue(), before.name, "switching back restores the designs");
  assert.equal(await page.getByLabel(/Expected control rate/).first().inputValue(), before.rate);
  assert.equal(await stop(), before.stop);
});

test("arrowing across Sort type doesn't change the sort or its goal (audit 1)", { skip }, async () => {
  const sort = page.locator('[role="radiogroup"][aria-label="Sort type"]').first();
  const checked = () => sort.locator('[role="radio"][aria-checked="true"]').textContent();
  const was = await checked();
  await sort.locator('[role="radio"][aria-checked="true"]').focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  assert.equal(await checked(), was);
});

test("arrowing onto a prototype option doesn't choose it; Space or Enter does (audit 5)", { skip }, async () => {
  const modes = page.locator('[role="radiogroup"][aria-label="Prototype for this study"]');
  assert.equal(await modes.count(), 1);
  const radios = modes.locator('[role="radio"]');
  const list = page.locator('[role="radiogroup"][aria-label="Existing prototype"]');
  assert.equal(await radios.count(), 3, "None, New (from the researcher's own findings) and Existing");
  assert.equal(await radios.nth(2).getAttribute("aria-checked"), "true", "starts on an existing prototype");
  await radios.nth(2).focus();
  await page.keyboard.press("ArrowUp");
  assert.match(await focusedName(), /^Create a new prototype/);
  await page.keyboard.press("ArrowUp");
  assert.match(await focusedName(), /^No prototype/);
  assert.equal(await radios.nth(2).getAttribute("aria-checked"), "true", "still the existing prototype");
  assert.equal(await list.count(), 1, "the prototype list is still shown");
  await page.keyboard.press("Space");
  assert.equal(await radios.nth(0).getAttribute("aria-checked"), "true");
  assert.equal(await list.count(), 0);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  assert.equal(await radios.nth(0).getAttribute("aria-checked"), "true", "arrowing onto 'Choose an existing prototype' doesn't open the list");
  assert.equal(await list.count(), 0);
  await page.keyboard.press("Enter");
  assert.equal(await radios.nth(2).getAttribute("aria-checked"), "true");
  assert.equal(await list.count(), 1);
});

test("preview: a new prototype from the researcher's own findings catches source-specific details and shows the exact unsent prompt", { skip }, async () => {
  const radios = page.locator('[role="radiogroup"][aria-label="Prototype for this study"] [role="radio"]');
  await radios.nth(1).click();
  const findings = page.getByLabel("What the research found, optional");
  await findings.waitFor({ timeout: 10000 });
  const show = page.getByRole("button", { name: "Show the build prompt" });
  await show.click();
  const prompt = await page.evaluate(() => document.body.innerText);
  assert.match(prompt, /BEGIN RESEARCH FINDINGS SUMMARIZED BY THE RESEARCHER/);
  assert.match(prompt, /tie each one to the numbered findings \(F1, F2…\) it addresses/);
  assert.match(prompt, /F1\. People weren't sure which action matched what they came to do\./);
  await findings.fill("Twelve people mentioned https://example.test.");
  await page.getByText("Before this can go to the prototype agent").first().waitFor({ timeout: 10000 });
  assert.equal(await page.getByRole("button", { name: "Show the build prompt" }).getAttribute("aria-disabled"), "true");
  assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /BEGIN RESEARCH FINDINGS/);
  await findings.fill("People weren't sure which action matched what they came to do.");
  await radios.nth(2).click();
});

test("direction labels follow the primary outcome", { skip }, async () => {
  const direction = page.locator('[role="radiogroup"][aria-label^="Planning direction"]').first();
  assert.deepEqual(await direction.locator('[role="radio"]').allTextContents(), ["Higher task success", "Lower task success", "Different (either way)"]);
  await page.locator('[role="radiogroup"][aria-label^="Primary outcome"]').first().locator('[role="radio"]').nth(1).click();
  assert.deepEqual(await direction.locator('[role="radio"]').allTextContents(), ["Higher self-reported completion", "Lower self-reported completion", "Different (either way)"]);
  await page.locator('[role="radiogroup"][aria-label^="Primary outcome"]').first().locator('[role="radio"]').nth(0).click();
});

test("making Design B the control visibly reorders the designs and announces it", { skip }, async () => {
  const designA = page.getByLabel("Design A name").first();
  assert.equal(await designA.inputValue(), "Current flow");
  await page.getByRole("button", { name: "Make Design B (New flow) the control" }).click();
  assert.equal(await designA.inputValue(), "New flow");
  assert.equal(await page.getByLabel("Design B name").first().inputValue(), "Current flow");
  assert.ok(await page.getByText("Design A (New flow) is the control.").first().isVisible());
  const live = await page.evaluate(() => [...document.querySelectorAll('[aria-live]')].map(node => node.textContent).join(" | "));
  assert.match(live, /New flow is now Design A, the control/);
  await page.getByRole("button", { name: "Make Design B (Current flow) the control" }).click();
});

test("the stopping-rule checkbox renders aria-checked; a disabled Save is described by its visible reason", { skip }, async () => {
  const checkbox = page.getByRole("checkbox", { name: /reviewed this stopping rule/ }).first();
  assert.equal(await checkbox.getAttribute("aria-checked"), "false");
  const save = page.getByRole("button", { name: /View working draft/ });
  assert.equal(await save.getAttribute("aria-disabled"), "true");
  const describedBy = await save.getAttribute("aria-describedby");
  assert.ok(describedBy, "Save has aria-describedby");
  const description = await page.evaluate(id => document.getElementById(id)?.textContent, describedBy);
  assert.match(description, /^Save is unavailable until 1 item is fixed: Activity 1 \(A\/B implementation test\): review the stopping rule and confirm it\.$/);
  assert.equal(await save.evaluate(node => node.disabled), true, "a real disabled button");
  await checkbox.focus();
  await page.keyboard.press("Space");
  assert.equal(await checkbox.getAttribute("aria-checked"), "true");
  assert.equal(await save.getAttribute("aria-disabled"), null);
  assert.equal(await save.getAttribute("aria-describedby"), null);
  assert.equal(await save.evaluate(node => node.disabled), false);
});

test("a newly appearing problem is announced in a live region", { skip }, async () => {
  const title = page.getByLabel("Working title").first();
  const before = await title.inputValue();
  await title.fill("");
  await sleep(1200);
  const live = await page.evaluate(() => [...document.querySelectorAll('[aria-live="polite"]')].map(node => node.textContent).join(" | "));
  assert.match(live, /New item to fix before saving: Add a working title of at least three letters or numbers\./);
  await title.fill(before);
});

test("a blank loss allowance shows no recruit numbers, and a valid one brings them back (audit 9)", { skip }, async () => {
  const allowance = page.getByLabel(/^Loss allowance before randomization or start/).first();
  const before = await allowance.inputValue();
  const text = () => page.evaluate(() => document.body.innerText);
  assert.match(await text(), /Recruit about \d+/);
  await allowance.fill("");
  await sleep(300);
  assert.doesNotMatch(await text(), /Recruit about \d+|No loss allowance is set/);
  assert.match(await text(), /How many to recruit appears once the loss allowance is a whole number from 0 to 50%\./);
  await allowance.fill("75");
  await sleep(300);
  assert.doesNotMatch(await text(), /Recruit about \d+/);
  await allowance.fill(before);
  await sleep(300);
  assert.match(await text(), /Recruit about \d+/);
});

test("a removed activity's set-aside details never come back in a new activity (review)", { skip }, async () => {
  const methods = page.locator('[role="radiogroup"][aria-label="Method"]');
  const before = await methods.count();
  const add = async method => {
    await page.getByRole("button", { name: /^Add (a study|another) activity$/ }).click();
    await page.getByRole("button", { name: `Add ${method}` }).click();
    await methods.nth(before).waitFor();
  };
  const tree = () => page.getByLabel(/^Tree\b/).last();
  // A tree test whose details are set aside when it becomes a survey, then removed.
  await add("Tree testing");
  await tree().fill("Home\n  Removed secret destination *");
  await methods.nth(before).getByRole("radio", { name: "Survey" }).click();
  await page.getByRole("button", { name: `Remove activity ${before + 1}` }).click();
  assert.equal(await methods.count(), before);
  // The next activity gets the same key. Switching it to a tree test must start fresh.
  await add("Survey");
  await methods.nth(before).getByRole("radio", { name: "Tree testing" }).click();
  assert.doesNotMatch(await tree().inputValue(), /Removed secret destination/);
  await page.getByRole("button", { name: `Remove activity ${before + 1}` }).click();
});
