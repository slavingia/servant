// Signed-in browser checks of the real research and Design Studio screens,
// against a local loopback Servant server with synthetic people and fake
// agents (signed-in-harness.mjs). Covers what the /research-preview checks
// can't: the signed-in study builder (prototype picker, Save, the recheck
// before saving), onboarding, and Design Studio (create, share for review,
// the Researcher hold, owner visibility, sandboxed prototype pages).
//
//   npm run test:web:signed-in
//
// Needs Playwright with Chromium, like test:web. Starts the harness and its own
// Expo web dev server (port SERVANT_SIGNED_IN_WEB_PORT, default 8096).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const require = createRequire(import.meta.url);
let playwright = null;
try { playwright = require("playwright"); } catch { /* reported below */ }
const skip = playwright ? false : "Playwright isn't installed";
const port = Number(process.env.SERVANT_SIGNED_IN_WEB_PORT || 8096);
const APP = `http://127.0.0.1:${port}`;
const appDir = new URL("..", import.meta.url).pathname;
const accountsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "servant-signed-in-accounts-")), "accounts.json");
let accounts, harness, web, browser, page, cfgFile, indexFile;
const setHold = on => { const c = JSON.parse(fs.readFileSync(cfgFile, "utf8")); if (on) delete c.researchHold; else c.researchHold = false; fs.writeFileSync(cfgFile, JSON.stringify(c)); };
const restorePage = () => fs.writeFileSync(indexFile, accounts.samplePage);

before(async () => {
  if (skip) return;
  harness = spawn(process.execPath, ["scripts/signed-in-harness.mjs", accountsFile], { cwd: appDir, stdio: "ignore" });
  for (let i = 0; i < 120 && !fs.existsSync(accountsFile); i++) await sleep(500);
  accounts = JSON.parse(fs.readFileSync(accountsFile, "utf8"));
  cfgFile = path.join(accounts.dir, "config.json");
  indexFile = path.join(accounts.dir, "prototypes", accounts.folder, "index.html");
  web = spawn("npx", ["expo", "start", "--web", "--port", String(port)], { cwd: appDir, env: { ...process.env, CI: "1", BROWSER: "none" }, stdio: "ignore", detached: true });
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(APP)).ok) break; } catch { /* starting */ }
    await sleep(1000);
  }
  browser = await playwright.chromium.launch();
});
after(async () => {
  await browser?.close();
  if (web) { try { process.kill(-web.pid, "SIGTERM"); } catch { /* already stopped */ } }
  harness?.kill("SIGTERM");
  if (accounts) fs.rmSync(accounts.dir, { recursive: true, force: true });
  fs.rmSync(path.dirname(accountsFile), { recursive: true, force: true });
});

async function open(account, route, viewport = { width: 390, height: 844 }) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  // Prototype links use the server's public address (https://tsoa.example.test): serve them from the local server.
  await context.route("https://tsoa.example.test/**", async route => {
    const target = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: `${accounts.base}${target.pathname}${target.search}` }) });
  });
  page = await context.newPage();
  await page.goto(APP + "/", { waitUntil: "domcontentloaded" });
  await page.evaluate(acct => { localStorage.clear(); localStorage.setItem("servant.account", JSON.stringify(acct)); }, account);
  await page.goto(APP + route, { waitUntil: "domcontentloaded" });
}
// On phones, Share for review is in the row's More menu; wider, it's on the row.
async function shareOffered(title) {
  const inline = page.getByRole("button", { name: `Share ${title} for review` });
  if (await inline.count()) return inline.isVisible();
  const more = page.getByRole("button", { name: `More for ${title}` });
  if (!await more.count()) return false;
  await more.click();
  const offered = await page.getByRole("menuitem", { name: "Share for review" }).count() > 0;
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
  return offered;
}
async function openShare(title) {
  const inline = page.getByRole("button", { name: `Share ${title} for review` });
  if (await inline.count()) return inline.click();
  await page.getByRole("button", { name: `More for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Share for review" }).click();
}
const modes = () => page.locator('[role="radiogroup"][aria-label="Prototype for this study"] [role="radio"]');
const checkedMode = async () => (await modes().evaluateAll(rs => rs.filter(r => r.getAttribute("aria-checked") === "true").map(r => r.getAttribute("aria-label"))))[0] ?? null;
const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent);
const picker = () => page.getByTestId("research-prototype-picker");
const bodyText = () => page.evaluate(() => document.body.innerText);
const text = bodyText;
const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= 390);
const designs = () => page.getByRole("button", { name: /, (Published|Draft|Building|Archived)/ });

test("hold on: arrowing onto 'Choose an existing prototype' doesn't open the picker; Space does; the chosen prototype is used", { skip }, async () => {
  setHold(true);
  await open(accounts.researcher, "/research-new?kind=study");
  await page.getByText("Prototype for this study").first().waitFor({ timeout: 120000 });
  assert.equal(await modes().count(), 3, "researchers can create a new prototype while the hold is on");
  assert.match(await checkedMode(), /^No prototype/);
  await modes().nth(0).focus();
  await page.keyboard.press("ArrowDown");
  assert.match(await focused(), /^Create a new prototype/);
  await page.keyboard.press("ArrowDown");
  assert.match(await focused(), /^Choose an existing prototype/);
  await sleep(600);
  assert.equal(await picker().count(), 0, "arrowing doesn't open the picker");
  assert.match(await checkedMode(), /^No prototype/);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await picker().waitFor({ timeout: 10000 });
  await page.getByText("Balance lookup prototype").first().waitFor({ timeout: 10000 });
  const options = page.locator('[role="radiogroup"][aria-label="Available prototypes"] [role="radio"]');
  assert.equal(await options.count(), 1);
  await options.first().click();
  assert.equal(await options.first().getAttribute("aria-checked"), "true");
  await page.getByRole("button", { name: "Use this prototype" }).click();
  await sleep(400);
  assert.equal(await picker().count(), 0);
  assert.match(await checkedMode(), /^Choose an existing prototype/);
  assert.match(await bodyText(), /Balance lookup prototype/);
});

test("Method on the real screen: arrows don't change it or its details; Space does, and switching back restores them", { skip }, async () => {
  await page.getByRole("button", { name: /Add a study activity/ }).click();
  await page.getByRole("button", { name: "Add Prototype usability" }).click();
  await page.getByLabel(/^Instructions for participants/).fill("Find how much the sample account owes.");
  await page.getByLabel("People per round").fill("7");
  const method = page.locator('[role="radiogroup"][aria-label="Method"]').first();
  const checked = () => method.locator('[role="radio"][aria-checked="true"]').textContent();
  await method.locator('[role="radio"]').first().focus();
  for (const key of ["ArrowRight", "ArrowRight", "End", "Home", "ArrowLeft"]) await page.keyboard.press(key);
  assert.equal(await checked(), "Prototype usability");
  assert.equal(await page.getByLabel("People per round").inputValue(), "7");
  await page.keyboard.press("Enter"); // on Survey (wrapped)
  assert.equal(await checked(), "Survey");
  await method.locator('[role="radio"]').first().focus();
  await page.keyboard.press("Space");
  assert.equal(await checked(), "Prototype usability");
  assert.equal(await page.getByLabel("People per round").inputValue(), "7", "restored");
  assert.equal(await page.getByLabel(/^Instructions for participants/).inputValue(), "Find how much the sample account owes.");
});

test("a blank loss allowance shows no recruit numbers on the real screen", { skip }, async () => {
  const allowance = page.getByLabel(/^Loss allowance/);
  await allowance.fill("");
  await sleep(300);
  assert.doesNotMatch(await bodyText(), /Recruit about \d+/);
  assert.match(await bodyText(), /How many to recruit appears once the loss allowance is a whole number from 0 to 50%/);
  assert.match(await bodyText(), /Enter a loss allowance from 0 to 50%/);
  await allowance.fill("20");
  await sleep(300);
  assert.match(await bodyText(), /Recruit about \d+/);
});

test("Save writes a working draft with the chosen prototype and Research Studio's numbers explained", { skip }, async () => {
  await page.getByLabel("Working title").fill("Balance lookup study");
  await page.getByLabel(/^Decision this study should inform/).fill("Whether to ship the new balance page");
  await page.getByLabel(/^Research question/).fill("Can people find what they owe?");
  await page.getByLabel(/^People to learn from/).fill("People with a sample account balance");
  const save = page.getByRole("button", { name: "Save working draft" });
  await sleep(300);
  assert.equal(await save.getAttribute("aria-disabled"), null, await bodyText().then(t => t.slice(t.indexOf("Needed"), t.indexOf("Needed") + 400)));
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), save.click()]);
  const file = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
  assert.equal(download.suggestedFilename(), "balance-lookup-study.working-draft.json");
  assert.equal(file.prototypeUrl, `https://tsoa.example.test/p/${accounts.folder}/`);
  assert.match(file.plan.participants.recruitment, /^Recruit about 18 people for the largest need \(Untitled|^Recruit about 18 people for the largest need/);
  assert.doesNotMatch(file.plan.participants.recruitment + file.plan.participants.exclusions, /\n/, "one-line fields, as Research Studio edits them");
  assert.match(file.plan.participants.recruitment, /Research Studio's sample-size summary shows about 14 "plus extra for drop-out": that's the analysis target, and the 18 here already includes the extra\./);
  assert.match(file.plan.analysis, /^Sample size and recruitment\n/);
  assert.match(file.plan.analysis, /target 7 per round \(14 in total\), shown by Research Studio as 14; recruit about 9 per round \(18 in total\)\./);
  assert.ok(!JSON.stringify(file).includes(accounts.researcher.token), "no credentials in the file");
  await page.getByText(/Saved working draft balance-lookup-study\.working-draft\.json/).first().waitFor({ timeout: 5000 });
});

test("a prototype that stops being ready is caught at save time: nothing is saved and the selection is cleared", { skip }, async () => {
  fs.rmSync(indexFile);
  try {
    let downloaded = false;
    page.once("download", () => { downloaded = true; });
    await page.getByRole("button", { name: "Save working draft" }).click();
    await sleep(2500);
    assert.equal(downloaded, false);
    assert.match(await bodyText(), /That prototype is no longer available or published, so the working draft wasn't saved\./);
    assert.match(await checkedMode(), /^Choose an existing prototype/);
    assert.ok(await page.getByRole("button", { name: "Choose prototype" }).isVisible(), "the selection was cleared");
    assert.equal(await page.getByRole("button", { name: "Save working draft" }).getAttribute("aria-disabled"), "true");
  } finally { restorePage(); }
});

test("hold off: arrowing onto 'Create a new prototype' keeps the chosen prototype; choosing it is deliberate", { skip }, async () => {
  setHold(false);
  await open(accounts.researcher, "/research-new?kind=study");
  await page.getByText("Prototype for this study").first().waitFor({ timeout: 120000 });
  await sleep(1000);
  assert.equal(await modes().count(), 3);
  await modes().nth(2).click();
  await picker().waitFor({ timeout: 10000 });
  await page.locator('[role="radiogroup"][aria-label="Available prototypes"] [role="radio"]').first().click();
  await page.getByRole("button", { name: "Use this prototype" }).click();
  await sleep(400);
  assert.match(await checkedMode(), /^Choose an existing prototype/);
  await modes().nth(2).focus();
  await page.keyboard.press("ArrowUp");
  assert.match(await focused(), /^Create a new prototype/);
  await sleep(400);
  assert.match(await checkedMode(), /^Choose an existing prototype/, "still the existing prototype");
  assert.match(await bodyText(), /Balance lookup prototype/, "the selection is kept");
  await page.keyboard.press("Space");
  assert.match(await checkedMode(), /^Create a new prototype/);
  setHold(true);
});

test("hold on: a researcher starts a prototype from a study and their own findings; source-specific details are caught first; the prompt is unsent", { skip }, async () => {
  setHold(true);
  await open(accounts.researcher, "/research-new?kind=study");
  await page.getByText("Prototype for this study").first().waitFor({ timeout: 120000 });
  await page.getByLabel("Working title").fill("Balance lookup");
  await page.getByLabel("Decision this study should inform, required").fill("Choose which balance layout to test.");
  await page.getByLabel("Research question, required").fill("Can people find what they owe?");
  await page.getByLabel("People to learn from, required").fill("Account holders, including screen-reader users.");
  await page.getByLabel("What you already know, optional").fill("See the earlier report link.");
  await modes().nth(1).click();
  assert.match(await checkedMode(), /^Create a new prototype/);
  await page.getByLabel("Prototype purpose, required").fill("Let people find their balance and due date.");
  const findings = page.getByLabel("What the research found, optional");
  await findings.fill('About 12 people said "I gave up" in March.');
  await page.getByText("Before this can go to the prototype agent").first().waitFor({ timeout: 10000 });
  const body = await text();
  for (const problem of [/Leave out numbers \(“12”\)/, /Leave out dates \(“March”\)/, /Paraphrase instead of quoting people/]) assert.match(body, problem);
  assert.equal(await page.getByRole("button", { name: "Show the build prompt" }).getAttribute("aria-disabled"), "true", "no prompt to show until the findings are fixed");
  await page.getByRole("button", { name: "Create prototype workspace" }).click();
  await page.getByRole("alert").filter({ hasText: /Check what the research found/ }).first().waitFor({ timeout: 10000 });
  assert.match(page.url(), /research-new/, "nothing is created until the findings are fixed");
  await findings.fill("People weren't sure where their balance was.\nSimilar labels made people hesitate.");
  assert.equal(await page.getByText("Before this can go to the prototype agent").count(), 0);
  // The exact prompt can be read before anything is created.
  await page.getByRole("button", { name: "Show the build prompt" }).click();
  const shown = await text();
  assert.match(shown, /F1\. People weren't sure where their balance was\./);
  assert.match(shown, /F2\. Similar labels made people hesitate\./);
  await page.getByRole("button", { name: "Create prototype workspace" }).click();
  await page.waitForURL(/\/chat\/cht_/, { timeout: 30000 });
  const id = page.url().match(/chat\/(cht_[\w-]+)/)[1];
  const composer = page.getByPlaceholder("Message the agent").locator("visible=true").first();
  await composer.waitFor({ timeout: 30000 });
  const draft = await composer.inputValue();
  await page.getByText("Your build prompt is ready").first().waitFor({ timeout: 10000 });
  // The message box grows to show the prompt (up to 40% of the window), and can be made larger to read it through.
  const boxHeight = () => composer.evaluate(el => el.getBoundingClientRect().height);
  const auto = await boxHeight();
  assert.ok(auto > 250 && auto <= 0.4 * 844 + 2, `grown to fit, within 40% of the window: ${auto}`);
  await page.getByRole("button", { name: "Make the message box larger" }).locator("visible=true").first().click();
  assert.ok(await boxHeight() > auto + 100, "larger");
  await page.getByRole("button", { name: "Make the message box smaller" }).locator("visible=true").first().click();
  assert.ok(Math.abs(await boxHeight() - auto) < 2, "back to the usual size");
  assert.equal(await page.getByRole("button", { name: /^Start from:/ }).count(), 0, "no starters to add to a prepared prompt");
  assert.match(draft, /BEGIN RESEARCH FINDINGS SUMMARIZED BY THE RESEARCHER/);
  assert.match(draft, /^F1\. People weren't sure where their balance was\.$/m);
  assert.match(draft, /suggest design directions for this study before building/);
  assert.doesNotMatch(draft, /earlier report link/, "“What you already know” stays with the study plan");
  const { testFetch } = await import(new URL("../../server/encrypted-test-client.mjs", import.meta.url).href);
  const headers = { Authorization: `Bearer ${accounts.researcher.token}` };
  const chat = (await (await testFetch(accounts.dir, `${accounts.base}/v1/chats/${id}`, { headers })).json()).chat;
  assert.equal(chat.agentRole, "prototype");
  const messages = (await (await testFetch(accounts.dir, `${accounts.base}/v1/chats/${id}/messages`, { headers })).json()).messages ?? [];
  assert.equal(messages.length, 0, "nothing is sent until the researcher reviews and sends it");
});

test("a study form is kept as a draft on this device: leaving, reloading right after typing, and coming back restore it; Start over clears it", { skip }, async () => {
  setHold(true);
  await open(accounts.researcher, "/research-new?kind=study");
  await page.getByText("Prototype for this study").first().waitFor({ timeout: 120000 });
  await page.getByLabel("Working title").fill("Draft keeper");
  await page.getByLabel("Decision this study should inform, required").fill("Choose a balance layout.");
  await modes().nth(1).click();
  await page.getByLabel("Prototype purpose, required").fill("Find the balance.");
  await page.getByLabel("What the research found, optional").fill("People filing Form 1040 missed the due date.");
  await page.getByText(/^Your answers are saved on this device as you go \(last saved at /).first().waitFor({ timeout: 10000 });
  // Leave through another part of the app, then come back from Research Studio.
  await page.goto(`${APP}/designs`, { waitUntil: "domcontentloaded" });
  await page.getByText("Balance lookup prototype").first().waitFor({ timeout: 60000 });
  await page.goto(`${APP}/research`, { waitUntil: "domcontentloaded" });
  const card = page.getByRole("button", { name: "Build a research study" }).first();
  await page.getByText(/^Continue where you left off: Draft keeper \(last saved at /).first().waitFor({ timeout: 60000 });
  await card.click();
  await page.getByText(/^Picked up where you left off \(last saved at /).first().waitFor({ timeout: 60000 });
  assert.equal(await page.getByLabel("Working title").inputValue(), "Draft keeper");
  assert.equal(await page.getByLabel("Decision this study should inform, required").inputValue(), "Choose a balance layout.");
  assert.match(await checkedMode(), /^Create a new prototype/);
  assert.equal(await page.getByLabel("Prototype purpose, required").inputValue(), "Find the balance.");
  assert.equal(await page.getByLabel("What the research found, optional").inputValue(), "People filing Form 1040 missed the due date.");
  assert.equal(await page.getByText("Before this can go to the prototype agent").count(), 0, "a form number is fine");
  assert.equal(await page.getByRole("button", { name: "Cancel", exact: true }).count(), 0, "leaving keeps the form, so there's no Cancel");
  // A reload straight after typing keeps the last change.
  await page.getByLabel("Constraints, optional").fill("Mobile first; plain language");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText(/^Picked up where you left off/).first().waitFor({ timeout: 60000 });
  assert.equal(await page.getByLabel("Working title").inputValue(), "Draft keeper");
  assert.equal(await page.getByLabel("Constraints, optional").inputValue(), "Mobile first; plain language");
  // "Use in a study plan" while this plan is in progress asks before changing it.
  await page.goto(`${APP}/research-new?kind=study&prototype=cht_sample_ready`, { waitUntil: "domcontentloaded" });
  await page.getByText("You have a study plan in progress").first().waitFor({ timeout: 60000 });
  assert.match(await text(), /“Draft keeper”, last saved at .+\. Use Balance lookup prototype in this plan, or start a new study plan with it\?/);
  assert.match(await checkedMode(), /^Create a new prototype/, "nothing changes until the researcher chooses");
  await page.getByRole("button", { name: "Use it in this plan" }).click();
  assert.match(await checkedMode(), /^Choose an existing prototype/);
  assert.equal(await page.getByLabel("Working title").inputValue(), "Draft keeper");
  assert.equal(await page.getByText("You have a study plan in progress").count(), 0);
  await sleep(1000);
  // The same prototype again: nothing to ask.
  await page.goto(`${APP}/research-new?kind=study&prototype=cht_sample_ready`, { waitUntil: "domcontentloaded" });
  await page.getByText(/^Picked up where you left off/).first().waitFor({ timeout: 60000 });
  await sleep(2000);
  assert.equal(await page.getByText("You have a study plan in progress").count(), 0);
  // Start over clears it.
  await page.getByRole("button", { name: "Start over" }).first().click();
  await page.getByText("Start over?").waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Start over" }).last().click();
  await sleep(800);
  assert.equal(await page.getByLabel("Working title").inputValue(), "");
  assert.match(await checkedMode(), /^No prototype/);
  assert.equal(await page.getByText(/^Picked up where you left off/).count(), 0);
  await page.goto(`${APP}/research-new?kind=study`, { waitUntil: "domcontentloaded" });
  await page.getByText("Prototype for this study").first().waitFor({ timeout: 60000 });
  await sleep(1500);
  assert.equal(await page.getByLabel("Working title").inputValue(), "", "the draft is gone");
  assert.doesNotMatch(await page.evaluate(() => localStorage.getItem("servant.formDrafts") ?? ""), /Draft keeper/);
  // Starting a new plan for a prototype, after confirming, clears the one in progress.
  await page.getByLabel("Working title").fill("Second plan");
  await sleep(1200);
  await page.goto(`${APP}/research-new?kind=study&prototype=cht_sample_ready`, { waitUntil: "domcontentloaded" });
  await page.getByText("You have a study plan in progress").first().waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "Start a new study plan" }).click();
  await page.getByText("Start a new study plan?").waitFor({ timeout: 10000 });
  assert.match(await text(), /This clears your answers to “Second plan” on this device and starts a new plan with Balance lookup prototype\./);
  await page.getByRole("button", { name: "Start a new study plan" }).last().click();
  await sleep(800);
  assert.equal(await page.getByLabel("Working title").inputValue(), "");
  assert.match(await checkedMode(), /^Choose an existing prototype/);
  assert.match(await text(), /Using Balance lookup prototype as this study's prototype\./);
});

test("onboarding (signed in): role radios render with one Tab stop and work from the keyboard", { skip }, async () => {
  await open({ ...accounts.designer, uxOnboarding: { version: 1, step: "role", role: null, goals: [], startedAt: Date.now(), updatedAt: Date.now() } }, "/");
  await page.waitForURL(/\/onboarding/, { timeout: 120000 });
  const roles = page.locator('[role="radiogroup"][aria-label="How do you work?"] [role="radio"]');
  await roles.first().waitFor({ timeout: 60000 });
  const states = await roles.evaluateAll(rs => rs.map(r => [r.getAttribute("aria-checked"), r.getAttribute("tabindex")]));
  assert.ok(states.every(([c]) => ["true", "false"].includes(c)));
  assert.equal(states.filter(([, t]) => t === "0").length, 1);
  await roles.first().focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await roles.nth(1).getAttribute("aria-checked"), "true", "role choice follows focus (no side effects)");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 390), true);
});

test("designer (tier 3): Design Studio lists own designs with status, and offers New design", { skip }, async () => {
  await open(accounts.designer, "/designs");
  await page.getByText("Balance lookup prototype").first().waitFor({ timeout: 120000 });
  const names = await designs().evaluateAll(els => els.map(e => e.getAttribute("aria-label")));
  assert.ok(names.includes("Balance lookup prototype, Published"), names.join(" | "));
  assert.ok(names.includes("Private sketch, Draft"), names.join(" | "));
  // A draft with no published page can't be shared for review (no dead preview link).
  assert.equal(await shareOffered("Private sketch"), false, "a draft with no page can't be shared");
  assert.ok(await shareOffered("Balance lookup prototype"));
  assert.ok(await page.getByRole("button", { name: "New design" }).first().isVisible());
  assert.ok(await noOverflow(), "no horizontal scrolling at 390px");
});

test("designer: New design opens a design workspace, and the agent answers in it", { skip }, async () => {
  const before = await designs().count();
  await page.getByRole("button", { name: "New design" }).first().click();
  await page.waitForURL(/\/chat\/cht_/, { timeout: 30000 });
  const chatId = page.url().match(/chat\/(cht_[\w-]+)/)[1];
  const box = page.getByRole("textbox").last();
  await box.waitFor({ timeout: 30000 });
  await box.fill("Make a page that shows a sample balance");
  await page.keyboard.press("Enter");
  await page.getByText("Sample reply from the test agent.").first().waitFor({ timeout: 30000 });
  assert.ok(await noOverflow());
  await page.goto(APP + "/designs", { waitUntil: "domcontentloaded" });
  await page.getByText("Balance lookup prototype").first().waitFor({ timeout: 60000 });
  const names = await designs().evaluateAll(els => els.map(e => e.getAttribute("aria-label")));
  assert.equal(names.length, before + 1, `the new design is listed: ${names.join(" | ")}`);
  assert.ok(chatId);
});

test("designer: Share for review posts a plain-text message with title, status and preview link, then opens its thread", { skip }, async () => {
  await openShare("Balance lookup prototype");
  const sheet = page.getByTestId("design-review-sheet");
  await sheet.waitFor({ timeout: 10000 });
  const radios = page.locator('[role="radiogroup"][aria-label="Share destination"] [role="radio"]');
  await radios.first().waitFor({ timeout: 30000 });
  const states = await radios.evaluateAll(rs => rs.map(r => [r.getAttribute("aria-label"), r.getAttribute("aria-checked"), r.getAttribute("tabindex")]));
  assert.ok(states.every(([, c]) => ["true", "false"].includes(c)), JSON.stringify(states));
  assert.equal(states.filter(([, , t]) => t === "0").length, 1, "one Tab stop");
  const general = states.findIndex(([label]) => /general/i.test(label));
  assert.ok(general >= 0, JSON.stringify(states));
  await radios.nth(general).click();
  assert.equal(await radios.nth(general).getAttribute("aria-checked"), "true");
  assert.ok(await noOverflow(), "share sheet fits at 390px");
  await page.getByRole("button", { name: /^Share/ }).last().click();
  await page.waitForURL(/\/thread/, { timeout: 30000 });
  // This app shows the review as a card; the message itself stays plain text for every client.
  await page.getByText("Design review", { exact: true }).first().waitFor({ timeout: 30000 });
  assert.ok(await page.getByRole("button", { name: "Open preview" }).first().isVisible());
  const { testFetch } = await import(new URL("../../server/encrypted-test-client.mjs", import.meta.url).href);
  const conversations = (await (await testFetch(accounts.dir, `${accounts.base}/v1/conversations`, { headers: { Authorization: `Bearer ${accounts.designer.token}` } })).json()).conversations;
  const generalChannel = conversations.find(c => c.name === "general");
  const posted = ((await (await testFetch(accounts.dir, `${accounts.base}/v1/conversations/${generalChannel.id}/messages`, { headers: { Authorization: `Bearer ${accounts.designer.token}` } })).json()).messages ?? [])
    .find(p => /^Design review: Balance lookup prototype/.test(p.text));
  assert.match(posted.text, /Status: Published/);
  assert.match(posted.text, new RegExp(`Preview: https://tsoa\\.example\\.test/p/${accounts.folder}/`));
  assert.match(posted.text, /Please leave feedback in this message's thread\./);
  assert.doesNotMatch(await text(), /Status: Published/, "the card replaces the text in this app");
});

test("researcher (tier 4) with the hold on: New design is offered, shared designs still reviewable", { skip }, async () => {
  setHold(true);
  await open(accounts.researcher, "/designs");
  await page.getByText("Balance lookup prototype").first().waitFor({ timeout: 120000 });
  assert.ok(await page.getByRole("button", { name: "New design" }).first().isVisible(), "researchers can make prototypes during the pilot");
  assert.doesNotMatch(await text(), /paused for the research pilot/);
  const names = await designs().evaluateAll(els => els.map(e => e.getAttribute("aria-label")));
  assert.ok(!names.some(n => /Private sketch/.test(n)), "someone else's private draft isn't listed");
  assert.ok(await shareOffered("Balance lookup prototype"));
});

test("researcher with the hold off: New design creates a workspace on the separate prototype lane", { skip }, async () => {
  setHold(false);
  await open(accounts.researcher, "/designs");
  await page.getByText("Balance lookup prototype").first().waitFor({ timeout: 120000 });
  await page.getByRole("button", { name: "New design" }).first().click();
  await page.waitForURL(/\/chat\/cht_/, { timeout: 30000 });
  const id = page.url().match(/chat\/(cht_[\w-]+)/)[1];
  const { testFetch } = await import(new URL("../../server/encrypted-test-client.mjs", import.meta.url).href);
  const r = await testFetch(accounts.dir, `${accounts.base}/v1/chats/${id}`, { headers: { Authorization: `Bearer ${accounts.researcher.token}` } });
  const chat = (await r.json()).chat;
  assert.equal(chat.agentRole, "prototype", `the Researcher's design runs on the prototype lane: ${JSON.stringify(chat).slice(0, 300)}`);
  setHold(true);
});

test("owner: a teammate's private draft is labeled private and can't be reshared", { skip }, async () => {
  await open(accounts.boss, "/designs");
  await page.getByText("Private sketch").first().waitFor({ timeout: 120000 });
  assert.ok(await page.getByRole("button", { name: "Private sketch, Draft, private, visible to admins" }).isVisible());
  assert.match(await text(), /Private · visible to admins/);
  assert.equal(await shareOffered("Private sketch"), false);
});

test("the published prototype is served sandboxed by the server itself", { skip }, async () => {
  const r = await fetch(`${accounts.base}/p/${accounts.folder}/`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), accounts.samplePage);
  assert.match(r.headers.get("content-security-policy") || "", /^sandbox /);
  assert.equal((await fetch(`${accounts.base}/p/proto-${"f".repeat(20)}/`)).status, 404, "an unpublished draft has no page");
});

// ---------- quick adjustments (web and Mac) ----------
const WIDE = { width: 1280, height: 900 };
const preview = () => page.frameLocator('iframe[title^="Preview of"]');
const adjustStatus = () => page.locator('[aria-live="polite"]').first();
async function waitForPreview() {
  // Selecting is on as soon as the preview connects.
  await page.getByRole("button", { name: "Selecting: on" }).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => !document.body.innerText.includes("Connecting to the preview…"), null, { timeout: 30000 });
}
// Polls until read() gives `want` (the preview applies changes as messages arrive), then returns the last value.
async function settle(read, want, ms = 5000) {
  let value;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { value = await read(); if (value === want) break; }
  return value;
}
const changeCount = async () => Number((await bodyText()).match(/Changes \((\d+)\)/)?.[1] ?? 0);
// The adjust panel's tabs: Edit, Changes (n) and Accessibility.
const showTab = name => page.getByRole("radiogroup", { name: "Adjust panel" }).getByRole("radio", { name: new RegExp(`^${name}`) }).click();
// The review step: read the whole request (or suggestion), then add or post it.
async function reviewAndConfirm(review, confirm) {
  await page.getByRole("button", { name: review }).click();
  await page.getByRole("button", { name: confirm }).click();
}
const field = label => page.getByLabel(label, { exact: true });

test("author: adjust a design on its preview (text, color, size, order), then add the request to the design chat's message box, unsent", { skip }, async () => {
  await open(accounts.designer, "/chat/cht_sample_ready", WIDE);
  await page.getByTestId("open-preview").click({ timeout: 120000 });
  await page.getByRole("button", { name: "Adjust design" }).first().click();
  await page.waitForURL(/\/adjust\?/);
  await waitForPreview();
  // Pick the heading in the preview (selecting is already on).
  await preview().locator("h1").click();
  await page.getByRole("heading", { name: 'Heading "Your balance"' }).waitFor();
  await field("Text").fill("What you owe");
  await page.getByRole("button", { name: "Apply text" }).click();
  await assert.doesNotReject(preview().locator("h1", { hasText: "What you owe" }).waitFor({ timeout: 5000 }), "the preview shows the new text");
  await field("Text color").fill("#1a73e8");
  await field("Text color").press("Enter");
  assert.equal(await settle(() => preview().locator("h1").evaluate(el => getComputedStyle(el).color), "rgb(26, 115, 232)"), "rgb(26, 115, 232)");
  // Move to the button with the keyboard-reachable panel controls, then reorder and resize it.
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("heading", { name: /^Paragraph "\$50\.00/ }).waitFor();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("heading", { name: 'Button "Pay now"' }).waitFor();
  await page.getByRole("button", { name: "Move earlier" }).click();
  await field("Width").fill("240px");
  await field("Width").press("Enter");
  assert.equal(await settle(() => preview().locator("button").evaluate(el => getComputedStyle(el).width), "240px"), "240px");
  assert.deepEqual(await preview().locator("main > *").evaluateAll(els => els.map(el => el.tagName)), ["H1", "BUTTON", "P", "A"], "the button now comes before the paragraph");
  assert.equal(await changeCount(), 4);
  // Invalid values are explained, not applied.
  await field("Height").fill("tall");
  await field("Height").press("Enter");
  assert.match(await bodyText(), /Enter a valid height, like 320px, 50% or auto\./);
  assert.equal(await changeCount(), 4);
  // Undo takes back the last change, in the list and the preview.
  await page.getByRole("button", { name: "Undo" }).click();
  assert.equal(await changeCount(), 3);
  assert.notEqual(await settle(() => preview().locator("button").evaluate(el => getComputedStyle(el).width), "x"), "240px");
  await field("Width").fill("240px");
  await field("Width").press("Enter");
  assert.equal(await changeCount(), 4);
  // Layers pick things that are hard to click. Changing the text back to how it was removes that change.
  await page.getByRole("button", { name: "Layers" }).click();
  await page.getByRole("list", { name: "Layers" }).getByRole("button", { name: /^Heading "Your balance", level 2$/ }).click();
  await page.getByRole("heading", { name: 'Heading "Your balance"' }).waitFor();
  await field("Text").fill("Your balance");
  await page.getByRole("button", { name: "Apply text" }).click();
  await assert.doesNotReject(preview().locator("h1", { hasText: "Your balance" }).waitFor({ timeout: 5000 }));
  assert.equal(await changeCount(), 3);
  // Each element's changes are one row with one remove button.
  await page.getByRole("list", { name: "Layers" }).getByRole("button", { name: /^Link "Help"/ }).click();
  await page.getByRole("heading", { name: 'Link "Help"' }).waitFor();
  await page.getByRole("button", { name: "Hide element" }).click();
  await assert.doesNotReject(preview().locator("a").waitFor({ state: "hidden", timeout: 5000 }));
  assert.equal(await changeCount(), 4);
  await showTab("Changes");
  await page.getByRole("button", { name: 'Remove changes to Link "Help"' }).click();
  await assert.doesNotReject(preview().locator("a").waitFor({ state: "visible", timeout: 5000 }));
  assert.equal(await changeCount(), 3);
  await page.getByLabel("Note for the agent (optional)").fill("Keep the button full width on phones.");
  await showTab("Edit");
  await page.getByRole("button", { name: "Hide layers" }).click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scrolling");
  // The whole request is shown before it goes to the design chat.
  await page.getByRole("button", { name: "Review request" }).click();
  await page.getByText("Review your request").waitFor();
  assert.match(await bodyText(), /Please apply these quick adjustments to the prototype "Balance lookup prototype"/);
  await page.getByRole("button", { name: "Add to design chat" }).click();
  await page.waitForURL(/\/chat\/cht_sample_ready/);
  const box = page.getByPlaceholder("Message the agent");
  await box.waitFor();
  const draft = await box.inputValue();
  assert.match(draft, /^Please apply these quick adjustments to the prototype "Balance lookup prototype"\./);
  assert.match(draft, /1\. Heading "Your balance" \(h1 at main:nth-of-type\(1\) > h1:nth-of-type\(1\)\): text color #000000 → #1a73e8\./);
  assert.match(draft, /2\. Button "Pay now" \(button at .*\): move it before Paragraph "\$50\.00 is due on the 15th\."; width .* → 240px\./);
  assert.match(draft, /Also: Keep the button full width on phones\.$/);
  // Nothing was sent: the request waits in the message box.
  assert.equal((await bodyText()).split("Please apply these quick adjustments").length - 1, 0, "not in the conversation, only in the message box");
  // The prototype itself is unchanged.
  assert.equal(fs.readFileSync(indexFile, "utf8"), accounts.samplePage);
  await box.fill("");
});

test("reviewer: suggest adjustments from the design review thread; the reply is plain text everyone can read", { skip }, async () => {
  const { testFetch } = await import(new URL("../../server/encrypted-test-client.mjs", import.meta.url).href);
  const call = async (token, route) => (await testFetch(accounts.dir, `${accounts.base}${route}`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const general = (await call(accounts.boss.token, "/v1/conversations")).conversations.find(c => c.name === "general");
  const posts = (await call(accounts.boss.token, `/v1/conversations/${general.id}/messages`)).messages ?? [];
  const review = posts.find(p => /^Design review: Balance lookup prototype/.test(p.text));
  assert.ok(review, "the review shared earlier");
  await open(accounts.boss, `/thread?conv=${general.id}&root=${review.id}`, WIDE);
  await page.getByRole("button", { name: "Suggest adjustments" }).click({ timeout: 120000 });
  assert.equal(await page.getByRole("button", { name: "Adjust design" }).count(), 0, "not the author");
  await page.waitForURL(/\/adjust\?/);
  await waitForPreview();
  await page.getByRole("button", { name: "Select first element" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: 'Heading "Your balance"' }).waitFor();
  await field("Font size").fill("40px");
  await field("Font size").press("Enter");
  await page.getByRole("radio", { name: "Center" }).click();
  assert.equal(await changeCount(), 2);
  await page.getByRole("button", { name: "Review suggestion" }).click();
  await page.getByText("Review your suggestion").waitFor();
  assert.doesNotMatch(await bodyText(), /nth-of-type/, "teammates don't see CSS paths");
  await page.getByRole("button", { name: "Post to the thread" }).click();
  // The reviewer lands in the thread, where the suggestion shows as a card.
  await page.waitForURL(/\/thread\?/);
  await page.locator('text=/Heading "Your balance": font size 32px → 40px; text alignment start → center\\./ >> visible=true').first().waitFor({ timeout: 30000 });
  const replies = (await call(accounts.boss.token, `/v1/conversations/${general.id}/threads/${review.id}`)).replies;
  const suggestion = replies.find(p => p.text.startsWith("Suggested adjustments for Balance lookup prototype:"));
  assert.ok(suggestion);
  assert.match(suggestion.text, /1\. Heading "Your balance" \(h1 at main:nth-of-type\(1\) > h1:nth-of-type\(1\)\): font size 32px → 40px; text alignment start → center\./);
  assert.equal(fs.readFileSync(indexFile, "utf8"), accounts.samplePage, "the prototype is unchanged");
});

test("author: a reviewer's suggestion goes to the design chat's message box, unsent", { skip }, async () => {
  const { testFetch } = await import(new URL("../../server/encrypted-test-client.mjs", import.meta.url).href);
  const call = async (token, route) => (await testFetch(accounts.dir, `${accounts.base}${route}`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const general = (await call(accounts.designer.token, "/v1/conversations")).conversations.find(c => c.name === "general");
  const review = ((await call(accounts.designer.token, `/v1/conversations/${general.id}/messages`)).messages ?? []).find(p => /^Design review: Balance lookup prototype/.test(p.text));
  await open(accounts.designer, `/thread?conv=${general.id}&root=${review.id}`, WIDE);
  await page.getByRole("button", { name: "Adjust design" }).waitFor({ timeout: 120000 });
  assert.equal(await page.getByRole("button", { name: "Suggest adjustments" }).count(), 0, "the author adjusts directly");
  await page.getByRole("button", { name: "Add to design chat" }).click();
  await page.waitForURL(/\/chat\/cht_sample_ready/);
  const box = page.getByPlaceholder("Message the agent");
  await box.waitFor();
  const draft = await box.inputValue();
  assert.match(draft, /^Olive Owner suggested these quick adjustments to the prototype "Balance lookup prototype" on its live preview \(https:\/\/tsoa\.example\.test\/p\//);
  assert.match(draft, /1\. Heading "Your balance" .*font size 32px → 40px; text alignment start → center\./);
  await box.fill("");
});

test("adjustments open only for this server's prototype pages, and only for the author or a review thread", { skip }, async () => {
  await open(accounts.researcher, "/adjust?chat=cht_sample_ready", WIDE);
  await page.getByText("Only the design's author can adjust it here. Others can suggest adjustments from its review thread.").waitFor({ timeout: 120000 });
  assert.equal(await page.locator("iframe").count(), 0);
  // Someone else's private draft: the server won't even show it.
  await page.goto(`${APP}/adjust?chat=cht_sample_draft`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Back" }).last().waitFor({ timeout: 60000 });
  assert.equal(await page.locator("iframe").count(), 0);
  await page.goto(`${APP}/adjust`, { waitUntil: "domcontentloaded" });
  await page.getByText("Open Adjust design from a design's preview or its review thread.").waitFor({ timeout: 60000 });
});

// ---------- designer walk-through fixes and additions ----------
const kitFile = () => path.join(accounts.dir, "prototypes", accounts.kitFolder, "index.html");
const fontSize = locator => locator.evaluate(el => getComputedStyle(el).fontSize);

test("adjust: tidy values, design-kit tokens, contrast, the accessibility check, a phone-only change, comments, editing on the page and before/after", { skip }, async () => {
  await open(accounts.designer, "/adjust?chat=cht_sample_kit", WIDE);
  await waitForPreview();
  await page.getByRole("button", { name: "Select first element" }).click();
  await page.getByRole("heading", { name: 'Heading "Kit heading"' }).waitFor();
  assert.equal(await field("Text color").inputValue(), "var(--ink)", "a style set from the kit shows its token");
  await page.getByRole("button", { name: /^Design kit brand, #1a73e8/ }).first().click();
  assert.equal(await settle(() => preview().locator("h1").evaluate(el => getComputedStyle(el).color), "rgb(26, 115, 232)"), "rgb(26, 115, 232)");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("heading", { name: /^Paragraph "Fine print/ }).waitFor();
  assert.equal(await field("Font size").inputValue(), "13.3px", "measured sizes are rounded");
  assert.equal(await field("Width").inputValue(), "auto", "a width nobody set reads as auto");
  assert.match(await bodyText(), /Low text contrast: 2\.3:1 \(needs 4\.5:1\)\./);
  await field("Text color").fill("#123456");
  await page.getByText("Not one of this page's design-kit colors.").waitFor();
  await field("Text color").fill("#333333");
  await field("Text color").press("Enter");
  await page.getByText("Text contrast 12.6:1 (needs 4.5:1).").waitFor();
  // The quick accessibility check finds the page's problems; a finding becomes a comment for the agent.
  await showTab("Accessibility");
  await page.getByRole("button", { name: "Check accessibility" }).click();
  await page.getByText(/The check found \d+ things to look at\./).waitFor();
  const text = await bodyText();
  assert.match(text, /Page: Doesn't say what language it's in/);
  assert.match(text, /Image: Has no alt text\./);
  assert.doesNotMatch(text, /low text contrast/i, "the paragraph was fixed before the check");
  await page.getByRole("button", { name: "Add as a comment" }).first().click();
  await page.getByText('Added a comment to Image for the agent.').waitFor();
  await showTab("Edit");
  await page.getByRole("heading", { name: "Image" }).waitFor();
  // At phone size, a change can be for phones only: other sizes keep the current style.
  await page.getByRole("radio", { name: "Phone", exact: true }).click();
  assert.equal(await page.locator('iframe[title^="Preview of"]').evaluate(el => el.getBoundingClientRect().width), 390);
  // A size-only choice shows above the preview, and ends when another element is selected.
  await page.getByRole("radio", { name: "Phone only" }).click();
  await page.getByText("Style changes to this element apply to phone sizes only.").waitFor();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.getByRole("heading", { name: /^Paragraph "Fine print/ }).waitFor();
  assert.equal(await page.getByText("Style changes to this element apply to phone sizes only.").count(), 0, "a new element starts at all sizes");
  await page.getByRole("radio", { name: "Phone only" }).click();
  await field("Font size").fill("18px");
  await field("Font size").press("Enter");
  assert.equal(await settle(() => fontSize(preview().locator("p")), "18px"), "18px");
  await page.getByRole("radio", { name: "Desktop" }).click();
  assert.equal(await settle(() => fontSize(preview().locator("p")), "13.3333px"), "13.3333px", "wider screens keep the page's size");
  // A comment for things that aren't a quick change.
  await field("Comment for the agent (optional)").fill("Feels cramped next to the image");
  await page.getByRole("button", { name: "Add comment" }).click();
  // Text edited straight on the page.
  await page.getByRole("radio", { name: "Full width" }).click();
  await page.getByRole("button", { name: "Select first element" }).click();
  await page.getByRole("heading", { name: 'Heading "Kit heading"' }).waitFor();
  await page.getByRole("button", { name: "Edit on page" }).click();
  await preview().locator("h1[contenteditable]").waitFor();
  await page.keyboard.type("Kit title");
  await page.keyboard.press("Enter");
  await assert.doesNotReject(preview().locator("h1", { hasText: "Kit title" }).waitFor({ timeout: 5000 }));
  assert.equal(await preview().locator("[contenteditable]").count(), 0, "the page isn't left editable");
  // Before and after.
  await page.getByRole("button", { name: "Show original" }).click();
  await assert.doesNotReject(preview().locator("h1", { hasText: "Kit heading" }).waitFor({ timeout: 5000 }));
  await page.getByRole("button", { name: "Show changes" }).click();
  await assert.doesNotReject(preview().locator("h1", { hasText: "Kit title" }).waitFor({ timeout: 5000 }));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scrolling");
  await reviewAndConfirm("Review request", "Add to design chat");
  await page.waitForURL(/\/chat\/cht_sample_kit/);
  const box = page.getByPlaceholder("Message the agent");
  await box.waitFor();
  const draft = await box.inputValue();
  assert.match(draft, /A change marked for one screen size applies at that size only/);
  assert.match(draft, /Comments are notes, not exact changes/);
  assert.match(draft, /1\. Heading "Kit heading" .*: text color #333333 → var\(--brand\); change the text to "Kit title"\./);
  assert.match(draft, /2\. Paragraph "Fine print that is hard to read\." .*: text color #aaaaaa → #333333; font size 13\.3333px → 18px \(phone sizes only, under 600px wide\); comment: "Feels cramped next to the image"\./, "the page's exact value, so the agent can find it");
  assert.match(draft, /\d\. Image \(img at .*\): comment: "Accessibility check: this has no alt text\. Please fix it\."\./);
  assert.equal(fs.readFileSync(kitFile(), "utf8"), accounts.kitPage, "the prototype itself is unchanged");
  await box.fill("");
});

test("adjust on a phone: the panel stacks under the preview with no sideways scrolling", { skip }, async () => {
  await open(accounts.designer, "/adjust?chat=cht_sample_kit");
  await waitForPreview();
  await page.getByRole("button", { name: "Select first element" }).click();
  await page.getByRole("heading", { name: 'Heading "Kit heading"' }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scrolling");
  await page.getByRole("radio", { name: "Desktop" }).click();
  const frame = await page.locator('iframe[title^="Preview of"]').evaluate(el => el.getBoundingClientRect().width);
  assert.ok(frame <= 390, `the desktop size is scaled down to fit (${frame}px)`);
  // Leaving with changes asks first.
  await page.getByRole("button", { name: "Hide element" }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
  await page.getByText("Leave without your changes?").waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
  assert.match(page.url(), /\/adjust\?/, "staying keeps the changes");
  assert.equal(await changeCount(), 1);
  await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
  await page.getByRole("button", { name: "Leave" }).click();
  await settle(() => page.url().includes("/adjust"), false);
});

test("library: search, lists, rename, duplicate and archive; inside a design the sidebar shows Designs", { skip }, async () => {
  await open(accounts.designer, "/designs", WIDE);
  await page.getByText("Kit check").first().waitFor({ timeout: 120000 });
  await page.getByLabel("Search designs").fill("kit");
  const rows = () => page.getByRole("button", { name: /, (Published|Draft|Building|Archived)/ }).evaluateAll(els => els.map(el => el.getAttribute("aria-label")));
  assert.deepEqual(await rows(), ["Kit check, Published"]);
  await page.getByLabel("Search designs").fill("");
  await page.getByRole("button", { name: "More for Kit check" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByLabel("Design name").fill("Kit check two");
  await page.getByRole("button", { name: "Save name" }).click();
  await page.getByText("Kit check two").first().waitFor();
  await page.getByRole("button", { name: "More for Kit check two" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await page.waitForURL(/\/chat\/cht_/);
  await page.locator('text="Copy of Kit check two" >> visible=true').first().waitFor({ timeout: 30000 });
  // The sidebar marks where you are with aria-current (selected isn't a button state on the web).
  const designsNav = () => page.getByRole("button", { name: "Designs", exact: true }).getAttribute("aria-current");
  assert.equal(await settle(designsNav, "page"), "page", "a design workspace keeps Designs selected");
  await page.getByTestId("open-preview").waitFor({ timeout: 30000 });
  // Archive the copy: it leaves the main list and shows under Archived.
  await page.goto(`${APP}/designs`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "More for Copy of Kit check two" }).waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "More for Copy of Kit check two" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" }).catch(() => {});
  assert.equal(await settle(() => page.getByRole("button", { name: "More for Copy of Kit check two" }).count(), 0), 0, "out of the main list");
  await page.getByRole("radio", { name: "Archived" }).click();
  await page.getByRole("button", { name: "More for Copy of Kit check two" }).waitFor();
  // A design opened without the Design Studio marker (from a list or search) still selects Designs.
  await page.goto(`${APP}/chat/cht_sample_kit`, { waitUntil: "domcontentloaded" });
  await page.locator('text="Kit check two" >> visible=true').first().waitFor({ timeout: 60000 });
  assert.equal(await settle(designsNav, "page"), "page");
  assert.deepEqual(await page.locator('[aria-current="page"]').evaluateAll(els => els.map(el => el.getAttribute("aria-label"))), ["Designs"], "only Designs, not Agent");
});

test("version history: kept after changes, compared side by side, restored by the author with the current page kept", { skip }, async () => {
  const v1 = fs.readFileSync(kitFile(), "utf8");
  await open(accounts.designer, "/versions?chat=cht_sample_kit", WIDE);
  await page.getByRole("button", { name: /^Version 1 · Latest/ }).waitFor({ timeout: 120000 });
  // The agent republishes the page.
  fs.writeFileSync(kitFile(), v1.replace("Kit heading", "Kit heading, updated"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /^Version 2 · Latest/ }).waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: /^Version 1,/ }).click();
  await page.getByRole("button", { name: "Compare with latest" }).click();
  const frames = page.locator('iframe[title^="Version"]');
  await frames.nth(1).waitFor();
  assert.equal(await frames.count(), 2);
  await assert.doesNotReject(page.frameLocator('iframe[title^="Version 1 of"]').locator("h1", { hasText: /^Kit heading$/ }).waitFor({ timeout: 10000 }));
  await assert.doesNotReject(page.frameLocator('iframe[title^="Version 2"]').locator("h1", { hasText: "Kit heading, updated" }).waitFor({ timeout: 10000 }));
  await page.getByRole("button", { name: "Restore version 1" }).click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByRole("button", { name: /^Version 3 · Latest, .*restored from version 1/ }).waitFor({ timeout: 30000 });
  assert.equal(fs.readFileSync(kitFile(), "utf8"), v1);
  assert.ok(await page.getByRole("button", { name: /^Version 2,/ }).isVisible(), "the page before the restore is kept");
  assert.match(await bodyText(), /To go back, restore version 2\./);
  // The agent hears about it only when the author sends the note waiting in the design chat.
  await sleep(1000); // unsent drafts are saved to the device shortly after a change
  await page.goto(`${APP}/chat/cht_sample_kit`, { waitUntil: "domcontentloaded" });
  const box = page.getByPlaceholder("Message the agent");
  await box.waitFor({ timeout: 60000 });
  assert.match(await box.inputValue(), /I restored version 1 of the page, so it's now version 3\./);
  await box.fill("");
});

test("someone else's design: versions can be looked at, not restored", { skip }, async () => {
  await open(accounts.boss, "/versions?chat=cht_sample_ready", WIDE);
  await page.getByRole("button", { name: /^Version 1 · Latest/ }).waitFor({ timeout: 120000 });
  assert.equal(await page.getByRole("button", { name: /^Restore/ }).count(), 0);
});

test("start page: the sidebar works from it, and choosing anywhere else finishes it", { skip }, async () => {
  const fresh = { ...accounts.designer, uxOnboarding: { version: 1, role: "product-designer", goals: ["prototype"], step: "ready", startedAt: 1, updatedAt: 2, completedAt: 2 } };
  await open(fresh, "/", WIDE);
  await page.waitForURL(/\/start$/, { timeout: 120000 });
  await page.getByText("Starting points").waitFor();
  await page.getByRole("button", { name: "Designs" }).click();
  await page.waitForURL(/\/designs$/);
  await page.getByText("Design Studio").first().waitFor();
  await sleep(500);
  assert.match(page.url(), /\/designs$/, "not sent back to the start page");
  await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/channels$/, { timeout: 60000 });
});

test("a new design: Untitled design, starters that only fill the message box, no Preview until published; review cards in channels", { skip }, async () => {
  await open(accounts.designer, "/designs", WIDE);
  await page.getByRole("button", { name: "New design" }).first().click({ timeout: 120000 });
  await page.waitForURL(/\/chat\/cht_/);
  await page.getByText("What should we build?").waitFor({ timeout: 30000 });
  assert.ok(await page.getByText("Untitled design").first().isVisible());
  assert.equal(await page.getByTestId("open-preview").count(), 0, "nothing to preview yet");
  await page.getByRole("button", { name: "Start from: Pricing page" }).click();
  assert.match(await page.getByPlaceholder("Message the agent").inputValue(), /^Build a pricing page that compares three plans/);
  assert.match(await bodyText(), /What should we build\?/, "nothing was sent");
  await page.getByPlaceholder("Message the agent").fill("");
  // A design can be renamed from inside its workspace too.
  await page.getByTestId("open-options").click();
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("Design name").fill("Pricing idea");
  await page.getByRole("button", { name: "Save name" }).click();
  await page.locator('text="Pricing idea" >> visible=true').first().waitFor({ timeout: 30000 });
  await page.keyboard.press("Escape");
  // A design that already has a page (a duplicate, say) doesn't offer to start from scratch.
  await page.goto(`${APP}/chat/cht_sample_ready`, { waitUntil: "domcontentloaded" });
  await page.getByText("This design already has a page").waitFor({ timeout: 60000 });
  assert.equal(await page.getByRole("button", { name: /^Start from:/ }).count(), 0);
  // The design review shared earlier shows as a card in the channel.
  const { testFetch } = await import(new URL("../../server/encrypted-test-client.mjs", import.meta.url).href);
  const general = (await (await testFetch(accounts.dir, `${accounts.base}/v1/conversations`, { headers: { Authorization: `Bearer ${accounts.boss.token}` } })).json()).conversations.find(c => c.name === "general");
  await open(accounts.boss, `/c/${general.id}`, WIDE);
  await page.getByText("Design review", { exact: true }).first().waitFor({ timeout: 120000 });
  await page.locator('role=button[name="Open preview"] >> visible=true').first().waitFor({ timeout: 30000 });
  await page.locator('role=button[name="Suggest adjustments"] >> visible=true').first().waitFor({ timeout: 30000 });
});
