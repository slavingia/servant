// Times one build of the web app on a phone-sized page with the processor slowed four times.
// usage: PERF_DIR=<working folder> node scripts/perf/measure.cjs <label> <runs> <out.json>
// The working folder holds state.json and state-jo.json (two signed-in browsers' storage, see README.md) and
// data/ (the test server's data directory). THROTTLE sets how many times slower the processor is (default 4).
const { chromium } = require('playwright');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const newest = () => { const db = new DatabaseSync(`${S}/data/messages.db`, { readOnly: true }); const row = db.prepare("SELECT m.text FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.name = 'general' AND m.thread_root IS NULL AND m.activity IS NULL ORDER BY m.seq DESC LIMIT 1").get(); db.close(); return row.text; };
const S = process.env.PERF_DIR || process.cwd();
const [,, label, runs = '3', out] = process.argv;
const BASE = process.env.PERF_APP || 'http://localhost:8099/';
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
const round = n => Math.round(n * 10) / 10;

async function one(browser, n) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: `${S}/state.json` });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const during = async work => { const a = await metrics(); const t = Date.now(); await work(); const b = await metrics(); return { wall: Date.now() - t, script: (b.ScriptDuration - a.ScriptDuration) * 1000, task: (b.TaskDuration - a.TaskDuration) * 1000, layout: (b.LayoutDuration - a.LayoutDuration) * 1000 + (b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000 }; };
  await page.addInitScript(() => {
    window.__long = [];
    try { new PerformanceObserver(list => { for (const e of list.getEntries()) window.__long.push(e.duration); }).observe({ entryTypes: ['longtask'] }); } catch {}
    window.__frames = null;
    const tick = t => { if (window.__frames) { if (window.__last) window.__frames.push(t - window.__last); window.__last = t; } requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.__keys = [];
    addEventListener('keydown', () => { const t = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => window.__keys.push(performance.now() - t))); }, true);
  });
  await page.goto(BASE + 'channels', { waitUntil: 'load' });
  await page.getByText('general', { exact: true }).first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(2500);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.THROTTLE || 4) });
  const result = { errors };

  // 1. Open a long channel: from the press to its newest message on screen, and until the page is quiet.
  let shown = 0;
  const last = newest();
  const open = await during(async () => {
    const t = Date.now();
    await page.getByText('general', { exact: true }).first().click();
    await page.getByPlaceholder('Message #general').waitFor();
    await page.getByText(last, { exact: true }).last().waitFor();
    shown = Date.now() - t;
    await page.waitForTimeout(2000);
  });
  result.open = { untilShown: shown, script: round(open.script), task: round(open.task) };

  // 2. Type sixty characters in the reply field.
  const box = page.getByPlaceholder('Message #general');
  await box.click();
  await page.evaluate(() => { window.__keys = []; });
  const typing = await during(async () => { await page.keyboard.type('The review moved to Tuesday at ten, in the usual room. Thanks', { delay: 40 }); await page.waitForTimeout(500); });
  const keys = await page.evaluate(() => window.__keys);
  result.type = { script: round(typing.script), task: round(typing.task), perKeyScript: round(typing.script / 60), keyToPaintP50: round(median(keys)), keyToPaintP95: round(pct(keys, 0.95)) };
  await box.fill('');

  // 3. Fifteen messages arrive from someone else while the channel is open.
  const other = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: `${S}/state-jo.json` });
  const jo = await other.newPage();
  await jo.goto(BASE + 'channels', { waitUntil: 'load' });
  await jo.getByText('general', { exact: true }).first().click();
  const joBox = jo.getByPlaceholder('Message #general');
  await joBox.waitFor({ timeout: 60000 });
  await jo.waitForTimeout(1500);
  const stamp = `${label}-${n}-${Date.now() % 100000}`;
  const incoming = await during(async () => {
    for (let i = 1; i <= 15; i++) { await joBox.fill(`Update ${i} of 15 for run ${stamp}`); await joBox.press('Enter'); await jo.waitForTimeout(150); }
    await page.getByText(`Update 15 of 15 for run ${stamp}`, { exact: true }).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(800);
  });
  result.incoming = { script: round(incoming.script), task: round(incoming.task), perMessageScript: round(incoming.script / 15) };
  await other.close();

  // 4. Scroll back through the history: 240 wheel steps of 400 points, one every 50 ms (12 seconds).
  const middle = { x: 195, y: 420 };
  await page.mouse.move(middle.x, middle.y);
  await page.evaluate(() => { window.__frames = []; window.__last = 0; window.__long = []; });
  const scroll = await during(async () => {
    for (let i = 0; i < 240; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(50); }
    await page.waitForTimeout(1500);
  });
  const frames = await page.evaluate(() => { const f = window.__frames; window.__frames = null; return f; });
  const long = await page.evaluate(() => window.__long);
  const after = await metrics();
  const oldest = await page.evaluate(() => { let min = Infinity; for (const m of document.body.innerText.matchAll(/\((\d{1,4})\)(?=\n|$)/g)) min = Math.min(min, Number(m[1])); return Number.isFinite(min) ? min : null; });
  // 5. The same distance for every build: keep scrolling back until a message 600 before the newest seeded one is on screen.
  const lowest = () => page.evaluate(() => { let min = Infinity; for (const m of document.body.innerText.matchAll(/\((\d{1,4})\)(?=\n|$)/g)) min = Math.min(min, Number(m[1])); return Number.isFinite(min) ? min : 99999; });
  await page.evaluate(() => { window.__frames2 = []; });
  const far = { steps: 0, reached: await lowest() };
  const t0 = Date.now();
  const farWork = await during(async () => {
    while (far.reached > 800 && far.steps < 1500) {
      for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(50); }
      far.steps += 10; far.reached = await lowest();
    }
  });
  far.seconds = round((Date.now() - t0) / 1000);
  result.reach800 = { seconds: far.seconds, wheelSteps: far.steps, script: round(farWork.script), reached: far.reached };
  result.scroll = { script: round(scroll.script), task: round(scroll.task), layout: round(scroll.layout), frames: frames.length, frameP50: round(median(frames)), frameP95: round(pct(frames, 0.95)), frameMax: round(Math.max(0, ...frames)),
    framesOver50: frames.filter(f => f > 50).length, framesOver100: frames.filter(f => f > 100).length, longTasks: long.length, longTaskTotal: round(long.reduce((a, b) => a + b, 0)),
    oldestMessageOnScreen: oldest, domNodes: after.Nodes, heapMB: round(after.JSHeapUsedSize / 1048576) };
  await context.close();
  return result;
}

(async () => {
  const browser = await chromium.launch();
  const all = [];
  for (let n = 1; n <= Number(runs); n++) { const r = await one(browser, n); all.push(r); console.log(label, 'run', n, JSON.stringify(r)); }
  await browser.close();
  const med = {};
  for (const part of ['open', 'type', 'incoming', 'scroll', 'reach800']) { med[part] = {}; for (const key of Object.keys(all[0][part])) med[part][key] = median(all.map(r => r[part][key])); }
  console.log(label, 'MEDIAN', JSON.stringify(med));
  if (out) fs.writeFileSync(out, JSON.stringify({ label, runs: all, median: med }, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
