import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFeedback, feedbackPrompt, feedbackResult } from './feedback.mjs';

const report = (text='Keyboard covers the send button', requestId='request-123') => ({text,requestId,context:{screen:'/c/test',build:'14',token:'must not be included'}});
test('durable feedback is private, idempotent, serial, bounded and exposes only allowed context', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'feedback-'));
  const file=path.join(dir,'feedback.db');
  let finish; let calls=0;
  let q=createFeedback({file,run: async () => { calls++; return new Promise(r => { finish=r; }); }});
  try {
    const first=q.submit('a',report());
    assert.equal(q.submit('a',report()).id, first.id);
    assert.equal(q.list('b').length,0);
    assert.equal(first.context.token,undefined);
    assert.throws(()=>q.submit('a',report('', 'request-empty')), /Enter feedback/);
    const running=q.tick(); await q.tick(); assert.equal(calls,1);
    assert.equal(q.list('a')[0].status,'working');
    finish({status:'reviewed',summary:'Test result'}); await running;
    assert.equal(q.list('a')[0].status,'reviewed');
    q.close(); q=createFeedback({file,run:async()=>({status:'reviewed',summary:'done'})});
    assert.equal(q.list('a')[0].result,'Test result');
    for(let i=0;i<4;i++) q.submit('a',report('Another report','request-'+i));
    assert.throws(()=>q.submit('a',report('Too many','request-limit')), /five reports/);
  } finally { q.close(); fs.rmSync(dir,{recursive:true}); }
});
test('interrupted work is not automatically replayed; another user cannot retry it',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'feedback-'));
  const q=createFeedback({file:path.join(dir,'feedback.db'),run:async()=>{throw Error('offline');}});
  try {
    const r=q.submit('a',report()); await q.tick();
    assert.equal(q.list('a')[0].status,'interrupted');
    q.retry('b',r.id); assert.equal(q.list('a')[0].status,'interrupted');
    q.retry('a',r.id); assert.equal(q.list('a')[0].status,'queued');
  } finally {q.close(); fs.rmSync(dir,{recursive:true});}
});
test('agent instruction scopes work to Servant and rejects unstructured/private output',()=>{
  assert.match(feedbackPrompt({id:'test',...report()}),/untrusted bug evidence/);
  assert.equal(feedbackResult('internal log secret').status,'interrupted');
  assert.equal(feedbackResult('{"status":"released","summary":"Commit abc, build 14"}').status,'released');
});
