import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecordings } from './recordings.mjs';

const ann = { id: 'ann', name: 'Ann' }, bo = { id: 'bo', name: 'Bo' };
function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-rec-'));
  const started = [];
  const rec = createRecordings({ dir, log: { error() {} }, users: () => ({ ann, bo }),
    transcribe: async () => [{ fromMs: 0, text: 'Bo drafts the post by Friday' }],
    summarize: async () => JSON.stringify({ title: 'Launch sync', summary: 'Planned the launch', notes: ['Ship Friday'], steps: [{ text: 'Draft the post', owner: 'Bo' }, { text: 'Book review' }] }),
    startWork: async o => { started.push(o); return { id: `cht_${started.length}` }; }, ...over });
  const upload = (user = ann, bytes = Buffer.alloc(2048, 1)) => {
    const { id } = rec.create(user, { size: bytes.length, durationMs: 5000, ext: 'm4a' });
    rec.chunk(user, id, { offset: 0, data: bytes.toString('base64') });
    return id;
  };
  const settled = async id => { for (let i = 0; i < 50 && ['processing', 'uploading'].includes(rec.detail(id, ann).status); i++) await new Promise(r => setTimeout(r, 10)); return rec.detail(id, ann); };
  return { rec, started, upload, settled };
}

test('a recording becomes notes and next steps, kept as a meeting', async () => {
  const { rec, upload, settled } = setup();
  const id = upload();
  rec.finish(ann, id);
  const m = await settled(id);
  assert.equal(m.status, 'done');
  assert.equal(m.title, 'Launch sync');
  assert.deepEqual(m.notes, ['Ship Friday']);
  assert.equal(m.steps.length, 2);
  assert.match(m.transcript, /Bo drafts the post/);
  await rec.close();
});

test('meetings are private to the person who recorded them', async () => {
  const { rec, upload } = setup();
  const id = upload();
  assert.throws(() => rec.detail(id, bo), /gone/);
  assert.throws(() => rec.chunk(bo, id, { offset: 0, data: 'AA==' }), /gone/);
  await rec.close();
});

test('uploads resume at the right offset and reject overruns', async () => {
  const { rec } = setup();
  const { id } = rec.create(ann, { size: 6, ext: 'm4a' });
  rec.chunk(ann, id, { offset: 0, data: Buffer.from('abc').toString('base64') });
  assert.throws(() => rec.chunk(ann, id, { offset: 0, data: 'AA==' }), e => e.code === 'upload_offset');
  assert.throws(() => rec.finish(ann, id), e => e.code === 'upload_offset');
  assert.throws(() => rec.chunk(ann, id, { offset: 3, data: Buffer.from('abcd').toString('base64') }), /didn't fit/);
  await rec.close();
});

test('a failed transcript can be retried', async () => {
  let fail = true;
  const { rec, upload, settled } = setup({ transcribe: async () => { if (fail) throw new Error('nope'); return [{ fromMs: 0, text: 'hello there' }]; } });
  const id = upload();
  rec.finish(ann, id);
  assert.equal((await settled(id)).status, 'failed');
  fail = false;
  await rec.retry(ann, id);
  assert.equal((await settled(id)).status, 'done');
  await rec.close();
});

test('sending a step to the agent starts one work chat, once', async () => {
  const { rec, started, upload, settled } = setup();
  const id = upload();
  rec.finish(ann, id);
  await settled(id);
  await Promise.all([rec.act(ann, { id: 'd1' }, id, '0', 'send'), rec.act(ann, { id: 'd1' }, id, '0', 'send')]);
  assert.equal(started.length, 1);
  assert.match(started[0].transcript, /Draft the post/);
  const m = await rec.act(ann, { id: 'd1' }, id, 'all', 'send');
  assert.equal(started.length, 2);
  assert.ok(m.steps.every(s => s.status === 'accepted' && s.chatId));
  await rec.close();
});

test('deleting a meeting removes it and its audio', async () => {
  const { rec, upload } = setup();
  const id = upload();
  rec.remove(ann, id);
  assert.throws(() => rec.detail(id, ann), /gone/);
  await rec.close();
});
