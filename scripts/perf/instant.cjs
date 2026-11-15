// Times presses from inside the page: from the pointer (or key) going down until what was asked for is on screen
// and opaque, checked on every frame, plus one frame for it to be painted.
// usage: PERF_DIR=<folder> node instant.cjs <label> [throttle] [delay ms added to every server answer]
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const S = process.env.PERF_DIR || __dirname;
const BASE = process.env.PERF_APP || 'http://localhost:8099/';
const [,, label = '', throttle = '1', delay = '0'] = process.argv;
const newest = () => { const db = new DatabaseSync(`${S}/data/messages.db`, { readOnly: true }); const row = db.prepare("SELECT m.text FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.name = 'general' AND m.thread_root IS NULL AND m.activity IS NULL ORDER BY m.seq DESC LIMIT 1").get(); db.close(); return row.text; };
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: `${S}/state.json` });
  const page = await context.newPage();
  page.on('pageerror', e => console.log('pageerror', e.message));
  if (Number(delay)) await page.route(/127\.0\.0\.1:8788|localhost:8788/, async route => { await new Promise(r => setTimeout(r, Number(delay))); await route.continue(); });
  await page.addInitScript(() => {
    window.__arm = wants => {
      window.__took = null;
      const turn = window.__turn = (window.__turn || 0) + 1;
      const visible = el => { const b = el.getBoundingClientRect(); if (b.height === 0 || b.width === 0 || b.bottom <= 0 || b.top >= innerHeight || b.right <= 0 || b.left >= innerWidth) return false; let o = 1; for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); o *= Number(s.opacity); if (s.visibility === 'hidden' || s.display === 'none') return false; } return o > 0.95; };
      const has = want => { if (want.css) return [...document.querySelectorAll(want.css)].some(visible); const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.nodeValue === want.text && visible(n.parentElement)) return true; return false; };
      let begun = false; const start = () => { if (begun || turn !== window.__turn) return; begun = true; const t0 = performance.now(); const tick = now => { if (turn !== window.__turn) return; if (wants.every(has)) { requestAnimationFrame(() => { if (turn === window.__turn) window.__took = Math.round(performance.now() - t0); }); return; } if (now - t0 < 8000) requestAnimationFrame(tick); else window.__took = -1; }; requestAnimationFrame(tick); };
      addEventListener('pointerdown', start, { capture: true, once: true });
      addEventListener('keydown', e => { if (e.key === 'Enter') start(); }, { capture: true, once: true });
    };
  });
  await page.goto(BASE + 'channels', { waitUntil: 'load' });
  await page.getByText('general', { exact: true }).first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(3000);
  if (throttle !== '1') await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: Number(throttle) });
  const last = newest();
  const results = [];
  const press = async target => { if (Array.isArray(target)) return page.mouse.click(target[0], target[1]); if (typeof target === 'function') return target(); const box = await target.boundingBox({ timeout: 5000 }); await page.mouse.click(box.x + Math.min(8, box.width / 2), box.y + box.height / 2); };
  const step = async (name, target, wants) => {
    try {
      await page.evaluate(w => window.__arm(w), wants.map(w => typeof w === 'string' ? { text: w } : w));
      await press(target);
      await page.waitForFunction(() => window.__took !== null, null, { timeout: 12000 });
      results.push([name, await page.evaluate(() => window.__took)]);
    } catch (e) { results.push([name, 'could not run: ' + String(e.message).split('\n')[0].slice(0, 60)]); }
    await page.waitForTimeout(1000);
  };
  const back = [26, 32];
  const tab = name => page.locator(`a[role=tab][aria-label^="${name}"]`).first();
  const row = name => page.locator(`[role=button][aria-label="${name}"]`).first();

  await step('open #general, first visit', row('#general'), [last]);
  await step('open a thread, first visit', async () => { await page.locator('[aria-label^="Actions for"]').last().click(); await page.getByText('Reply in thread', { exact: true }).first().click(); }, [{ css: 'textarea[placeholder="Reply"]' }]);
  await step('back to the channel', back, [{ css: 'textarea[placeholder="Message #general"]' }]);
  await step('Details', page.getByText('Details', { exact: true }).first(), ['Members']);
  await step('back to the channel from Details', back, [{ css: 'textarea[placeholder="Message #general"]' }]);
  const stamp = `Instant check ${Date.now() % 100000}`;
  await page.locator('textarea[placeholder="Message #general"]').fill(stamp);
  await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
  await step('back to Home', back, ['Channels', 'Projects']);
  await step('open #general, second visit', row('#general'), [stamp]);
  await step('back to Home again', back, ['Channels', 'Projects']);
  await step('open #whats-new, first visit', row('#whats-new'), [{ css: 'textarea[placeholder="Message #whats-new"]' }]);
  await step('back to Home from #whats-new', back, ['Channels', 'Projects']);
  await step('open the agent chat, first visit', page.locator('[role=button][aria-label^="Agent"]').first(), [{ css: 'textarea' }]);
  await step('back to Home from the agent chat', back, ['Channels', 'Projects']);
  await step('tab: Chats', tab('Chats'), [{ css: '[aria-label^="New message"], [aria-label*="New chat"]' }]);
  await step('tab: Agent', tab('Agent'), [{ css: 'textarea, [aria-label*="New"]' }]);
  await step('tab: People', tab('People'), ['Jo Park']);
  await step('tab: You', tab('You'), ['Notifications']);
  await step('You → Notifications', page.getByText('Notifications', { exact: true }).first(), [{ css: '[role=switch], [role=button][aria-label*="otification"]' }]);
  await step('back to You', back, ['Notifications']);
  await step('tab: Home', tab('Home'), ['Channels', 'Projects']);
  for (const [name, ms] of results) console.log(label.padEnd(10), String(ms).padStart(6), typeof ms === 'number' ? 'ms ' : '   ', name);
  const times = results.map(r => r[1]).filter(v => typeof v === 'number' && v >= 0);
  console.log(label.padEnd(10), 'slowest', Math.max(...times), 'ms; over 300 ms:', results.filter(r => typeof r[1] !== 'number' || r[1] > 300 || r[1] < 0).map(r => r[0]).join('; ') || 'none');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
