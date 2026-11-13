import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssist, findAsk, recentContext } from './meeting-assist.mjs';

test('the wake phrase is found the ways whisper writes it', () => {
  assert.equal(findAsk('Hey servant, what is the mileage rate?'), 'what is the mileage rate?');
  assert.equal(findAsk('hey Servant. look up St. Louis office hours'), 'look up St. Louis office hours');
  assert.equal(findAsk('Hey agent what time is it'), 'what time is it');
  assert.equal(findAsk('Okay, S, define de minimis'), 'define de minimis');
  assert.equal(findAsk('hey'), null);
  assert.equal(findAsk('they served the agent'), null);
  assert.equal(findAsk('hey sam, quick question'), null);
  assert.equal(findAsk(''), null);
});

test('recent context keeps only the last two minutes', () => {
  const lines = [{ name: 'A', text: 'old', seenAt: 0 }, { name: 'B', text: 'new', seenAt: 200000 }];
  assert.equal(recentContext(lines, 210000), 'B: new');
});

function rig({ research } = {}) {
  let t = 1000;
  const feed = { ann: [], bo: [] };
  const asked = [];
  const changes = [];
  const a = createAssist({
    people: () => [{ id: 'p1', userId: 'ann', name: 'Ann', muted: false, liveFile: 'a.webm' }, { id: 'p2', userId: 'bo', name: 'Bo', muted: false, liveFile: 'b.webm' }],
    transcribe: async (file) => { const q = feed[file[0] === 'a' ? 'ann' : 'bo']; const segs = q.splice(0); return { seconds: segs.length ? 8 : 0, segments: segs.map(text => ({ fromMs: 0, text })) }; },
    research: research || (async (o) => { asked.push(o); return 'It is 72.5 cents per mile (example.gov).'; }),
    onCards: (c) => changes.push(c.map(x => x.status).join()),
    now: () => t, log: { error() {} },
  });
  return { a, feed, asked, changes, tick: async (ms = 8000) => { t += ms; await a.tick(); } };
}

test('"hey servant" turns what follows into one question, after the asker goes quiet', async () => {
  const r = rig();
  r.feed.bo.push('We should check the rate.');
  await r.tick();
  r.feed.ann.push('Hey servant, what is the standard mileage rate');
  await r.tick();
  r.feed.ann.push('for twenty twenty six?');
  await r.tick();
  assert.equal(r.asked.length, 0, 'still listening while Ann talks');
  await r.tick(); await r.tick();
  await r.a.flush();
  assert.equal(r.asked.length, 1);
  assert.equal(r.asked[0].question, 'what is the standard mileage rate for twenty twenty six?');
  assert.equal(r.asked[0].asker, 'Ann');
  assert.match(r.asked[0].context, /Bo: We should check the rate/);
  assert.equal(r.a.cards[0].status, 'done');
  assert.match(r.a.cards[0].answer, /72\.5/);
});

test('ordinary talk never asks the agent, muted people are skipped', async () => {
  const r = rig();
  r.feed.ann.push('Let us talk about the budget'); r.feed.bo.push('Sounds good to me');
  for (let i = 0; i < 4; i++) await r.tick();
  assert.equal(r.asked.length, 0);
  assert.equal(r.a.cards.length, 0);
});

test('a failed lookup says so and the next one still works', async () => {
  let n = 0;
  const r = rig({ research: async () => { if (!n++) throw new Error('down'); return 'ok'; } });
  r.feed.ann.push('hey servant what is a W-2');
  await r.tick(); await r.tick(); await r.tick();
  await r.a.flush();
  assert.equal(r.a.cards[0].status, 'failed');
  r.feed.ann.push('hey servant what is a W-4');
  await r.tick(); await r.tick(); await r.tick();
  await r.a.flush();
  assert.equal(r.a.cards[1].status, 'done');
});

test('two asks in a row both get answered', async () => {
  const r = rig();
  r.feed.ann.push('hey servant what is a W-2');
  await r.tick();
  r.feed.bo.push('hey servant what is a 1099');
  await r.tick();
  await r.tick(); await r.tick();
  await r.a.flush();
  assert.deepEqual(r.asked.map(x => x.question), ['what is a W-2', 'what is a 1099']);
});
