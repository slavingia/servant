import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodeRequests, normalizeCode, CODE_REQUEST_LIMIT } from './code-requests.mjs';

const pat = { id: 'usr_pat' }, jo = { id: 'usr_jo' };
const runner = { id: 'dev_runner', label: 'QA runner' }, phone = { id: 'dev_phone', label: 'Phone' };
function store() { let at = 1_000_000; const s = createCodeRequests({ clock: () => at }); return { s, tick: ms => { at += ms; } }; }

test('the asking device gets the code once, after the phone answers', () => {
  const { s } = store();
  const r = s.create(pat, runner, { label: 'Login.gov sign-in', hint: 'Texted to the number ending 0000' });
  assert.equal(r.status, 'pending');
  assert.equal(r.device, 'QA runner');
  assert.deepEqual(s.list(pat).map(x => x.id), [r.id]);
  assert.equal(s.claim(r.id, pat, runner).status, 'pending');
  s.answer(r.id, pat, phone, ' 554-100 ');
  assert.deepEqual(s.claim(r.id, pat, runner), { status: 'answered', code: '554100' });
  assert.deepEqual(s.claim(r.id, pat, runner), { status: 'claimed' }, 'a second pickup gets nothing');
  assert.deepEqual(s.list(pat), [], 'nothing left waiting');
});

test('nobody else can see, answer or pick up a request', () => {
  const { s } = store();
  const r = s.create(pat, runner, { label: 'Login.gov sign-in' });
  assert.throws(() => s.get(r.id, jo), { status: 404 });
  assert.throws(() => s.answer(r.id, jo, phone, '123456'), { status: 404 });
  assert.throws(() => s.claim(r.id, pat, phone), { status: 404 }, 'only the device that asked picks it up');
  assert.throws(() => s.answer(r.id, pat, runner, '123456'), { status: 403 }, 'the asking device cannot answer itself');
  assert.equal(s.pending(r.id, jo.id), null);
});

test('views never include the code', () => {
  const { s } = store();
  const r = s.create(pat, runner, { label: 'Login.gov sign-in' });
  const answered = s.answer(r.id, pat, phone, '554100');
  for (const v of [answered, s.get(r.id, pat), ...s.list(pat)]) assert.ok(!JSON.stringify(v).includes('554100'));
});

test('expiry, cancel and answering twice', () => {
  const { s, tick } = store();
  const a = s.create(pat, runner, { label: 'Login.gov sign-in', ttlSeconds: 60 });
  tick(61_000);
  assert.throws(() => s.answer(a.id, pat, phone, '123456'), { status: 410, code: 'code_request_expired' });
  assert.deepEqual(s.claim(a.id, pat, runner), { status: 'expired' });
  const b = s.create(pat, runner, { label: 'Login.gov sign-in' });
  s.answer(b.id, pat, phone, '123456');
  assert.throws(() => s.answer(b.id, pat, phone, '654321'), { status: 410, code: 'code_request_answered' });
  s.cancel(b.id, pat);
  assert.deepEqual(s.claim(b.id, pat, runner), { status: 'cancelled' }, 'a cancelled answer is dropped');
  tick(16 * 60_000);
  assert.throws(() => s.get(b.id, pat), { status: 404 }, 'finished requests are forgotten');
});

test('limits and validation', () => {
  const { s } = store();
  assert.throws(() => s.create(pat, runner, {}), { status: 400 });
  for (let i = 0; i < CODE_REQUEST_LIMIT; i++) s.create(pat, runner, { label: `Code ${i}` });
  assert.throws(() => s.create(pat, runner, { label: 'One more' }), { status: 429 });
  const other = s.create(jo, runner, { label: 'x', ttlSeconds: 99999 });
  assert.equal(other.expiresAt - other.createdAt, 15 * 60_000, 'other people are unaffected, and lifetimes are capped');
  for (const bad of ['', '12', 'abc def ghi jkl mno', '<script>', 42]) assert.throws(() => normalizeCode(bad), { status: 400 });
  assert.equal(normalizeCode('ab12 cd'), 'ab12cd');
  s.forget(pat.id);
  assert.deepEqual(s.list(pat), []);
});

test('a request can say how long its code is, so the phone sends it without a tap', () => {
  const { s } = store();
  const made = s.create(pat, runner, { label: 'Login.gov sign-in', length: 6 });
  assert.equal(made.length, 6);
  assert.equal(s.get(made.id, pat).length, 6, 'the phone sees it');
  assert.equal(s.create(pat, runner, { label: 'No length' }).length, undefined, 'it stays optional');
  assert.equal(s.create(pat, runner, { label: 'Null length', length: null }).length, undefined);
  for (const bad of [3, 13, 6.5, 'six', -6]) assert.throws(() => s.create(jo, runner, { label: 'x', length: bad }), { status: 400 }, String(bad));
});
