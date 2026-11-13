import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSurveyRedactor, redactSurveyText } from './survey-pii.mjs';

const clear = () => createSurveyRedactor({ load: async () => ({ redact: async text => ({ text, spans: [] }) }) });
const safeFailure = error => {
  assert.equal(error.status, 503);
  assert.equal(error.code, 'survey_pii_unavailable');
  assert.equal(error.cause, undefined);
  assert.equal(error.message, 'Personal information removal is unavailable. Please try submitting your feedback again later.');
  return true;
};

test('survey redaction preserves useful text and removes model name spans even without a blocking verdict', async () => {
  const input = 'Ask Jo Park about the unclear instructions.';
  const redact = createSurveyRedactor({ load: async () => ({ redact: async text => {
    assert.equal(text, input);
    return { text: 'Ask [REDACTED] about the unclear instructions.', spans: [{ start: 4, end: 11, type: 'NAME' }] };
  } }) });
  assert.equal(await redact(input), 'Ask [REDACTED] about the unclear instructions.');
  assert.equal(await clear()('😀 The café ﬁle had clear instructions.'), '😀 The café ﬁle had clear instructions.');
});

test('supplemental spans redact public and role mailboxes plus numeric identifiers, retaining sentence punctuation', async () => {
  const input = 'Email help@example.gov. My account is 123456789. Keep the useful steps.';
  assert.equal(await clear()(input), 'Email [REDACTED]. My account is [REDACTED]. Keep the useful steps.');
  assert.equal(await clear()('Call 202-555-0182, then read page 5.'), 'Call [REDACTED], then read page 5.');
});

test('supplemental detection maps compatibility and hidden characters back to original UTF-16 text', async () => {
  const input = '😀 Keep café ﬁle notes. Email pat＠example.gov and ID １２３\u200b４５６７８９. Keep this.';
  assert.equal(await clear()(input), '😀 Keep café ﬁle notes. Email [REDACTED] and ID [REDACTED]. Keep this.');
});

test('overlapping model and supplemental spans redact their complete union without losing useful text', async () => {
  const redact = createSurveyRedactor({ load: async () => ({ redact: async () => ({ text: 'Call [REDACTED]-0182. Keep this.', spans: [{ start: 5, end: 12, type: 'PHONE' }] }) }) });
  assert.equal(await redact('Call 202-555-0182. Keep this.'), 'Call [REDACTED]. Keep this.');
});

test('valid UTF-16 spans retain neighboring emoji and unrelated text', async () => {
  const redact = createSurveyRedactor({ load: async () => ({ redact: async () => ({ text: '😀 [REDACTED] wrote this.', spans: [{ start: 3, end: 10, type: 'NAME' }] }) }) });
  assert.equal(await redact('😀 Jo Park wrote this.'), '😀 [REDACTED] wrote this.');
});

test('a missing or failing model rejects without logging raw text or provider diagnostics', async t => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args));
  for (const load of [async () => null, async () => ({ check: async () => ({ verdict: 'ALLOW', spans: [] }) }), async () => { throw new Error('Model diagnostic includes private@example.com'); }, async () => ({ redact: async () => { throw new Error('Input contained private@example.com'); } })]) {
    await assert.rejects(() => createSurveyRedactor({ load })('Private feedback'), safeFailure);
  }
  assert.deepEqual(logged, []);
});

test('malformed model results fail closed instead of returning unchecked text', async () => {
  const input = '😀 Jo Park';
  for (const result of [null, {}, { text: input }, { text: input, spans: null }, { text: 'changed', spans: [] },
    { text: input, spans: [{ start: 3, end: 10 }] },
    { text: input, spans: [{ start: -1, end: 2 }] },
    { text: input, spans: [{ start: 4, end: 3 }] },
    { text: input, spans: [{ start: 3.5, end: 5 }] },
    { text: input, spans: [{ start: 1, end: 2 }] },
    { text: input, spans: [{ start: 3, end: 5 }, { start: 4, end: 7 }] },
    { text: input, spans: [{ start: 3, end: 8 }] },
  ]) {
    const redact = createSurveyRedactor({ load: async () => ({ redact: async () => result }) });
    await assert.rejects(() => redact(input), safeFailure);
  }
});

test('empty feedback bypasses inference, oversized input fails closed and bounded input is never truncated', async () => {
  const seen = [];
  const redact = createSurveyRedactor({ load: async () => ({ redact: async text => { seen.push(text); return { text, spans: [] }; } }) });
  assert.equal(await redact(''), '');
  for (const input of [null, 5, 'x'.repeat(2001), '\uFDFA'.repeat(2000)]) await assert.rejects(() => redact(input), safeFailure);
  assert.deepEqual(seen, []);
  const input = 'x'.repeat(1992) + ' 1234567';
  assert.equal(await redact(input), 'x'.repeat(1992) + ' [REDACTED]');
  assert.deepEqual(seen, [input]);
});

test('the local model loads once concurrently and a failed load can recover on a later request', async () => {
  let attempts = 0;
  const redact = createSurveyRedactor({ load: async () => {
    if (++attempts === 1) throw new Error('not installed yet');
    return { redact: async text => ({ text, spans: [] }) };
  } });
  await assert.rejects(() => redact('A comment'), safeFailure);
  assert.deepEqual(await Promise.all([redact('One comment'), redact('Another comment')]), ['One comment', 'Another comment']);
  assert.equal(attempts, 2);
});

test('missing local runtime fails closed without trying a network download', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-survey-pii-'));
  const before = process.env.SERVANT_PII_DIR;
  t.after(() => { if (before === undefined) delete process.env.SERVANT_PII_DIR; else process.env.SERVANT_PII_DIR = before; fs.rmSync(dir, { recursive: true, force: true }); });
  process.env.SERVANT_PII_DIR = dir;
  const network = t.mock.method(globalThis, 'fetch', async () => { assert.fail('Survey redaction must never download a model'); });
  await assert.rejects(() => createSurveyRedactor()('Private feedback'), safeFailure);
  assert.equal(network.mock.callCount(), 0);
});

test('the installed real model removes names and identifiers while preserving useful feedback', { skip: !process.env.SERVANT_PII_REAL }, async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { assert.fail('The real survey model must remain local'); });
  assert.equal(await redactSurveyText('Contact Jo Park at jo.park@example.com. The form needs a larger button.'), 'Contact [REDACTED] at [REDACTED]. The form needs a larger button.');
  assert.equal(await redactSurveyText('My SSN is 452-78-1934. Please improve navigation.'), 'My SSN is [REDACTED]. Please improve navigation.');
  assert.equal(await redactSurveyText('😀 My phone is 202-555-0182. Keep the helpful examples.'), '😀 My phone is [REDACTED]. Keep the helpful examples.');
  assert.equal(await redactSurveyText('Email help@example.gov. Keep the useful steps.'), 'Email [REDACTED]. Keep the useful steps.');
  assert.equal(await redactSurveyText('Plans for next year’s filing season'), 'Plans for next year’s filing season');
  assert.equal(network.mock.callCount(), 0);
});

test('the real loader refuses a changed vocabulary instead of falling back to rules', { skip: !process.env.SERVANT_PII_REAL }, async t => {
  const installed = process.env.SERVANT_PII_DIR || path.join(os.homedir(), '.local/share/servant/models/rampart-edge');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-survey-pii-integrity-'));
  const before = process.env.SERVANT_PII_DIR;
  t.after(() => { if (before === undefined) delete process.env.SERVANT_PII_DIR; else process.env.SERVANT_PII_DIR = before; fs.rmSync(dir, { recursive: true, force: true }); });
  fs.symlinkSync(path.join(installed, 'node_modules'), path.join(dir, 'node_modules'));
  fs.symlinkSync(path.join(installed, 'onnx'), path.join(dir, 'onnx'));
  fs.writeFileSync(path.join(dir, 'vocab.txt'), 'changed vocabulary');
  process.env.SERVANT_PII_DIR = dir;
  await assert.rejects(() => createSurveyRedactor()('Private feedback'), safeFailure);
});
