// Encrypted phone API + independent worker + real SQLite, with deterministic
// bridge responses. Killing API/worker processes must not submit the run twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { testFetch } from './encrypted-test-client.mjs';

async function until(check) {
  for (let i = 0; i < 300; i++) { const value = await check(); if (value) return value; await sleep(20); }
  throw new Error('Timed out waiting for private turn');
}
async function fixture(t, { durable = true, restricted = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-turn-api-'));
  const children = [], runs = new Map(), histories = new Map([['session', []]]), approvals = [];
  let historyOffline = false, pollsOffline = 0, controlsOffline = 0, startCount = 0;
  const emit = (run, event, body = {}) => {
    const payload = { event, ...body };
    if (run.response && !run.response.destroyed) run.response.write(`data: ${JSON.stringify(payload)}\n\n`);
    else run.events.push(payload);
  };
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (req.headers.authorization !== 'Bearer fixture-key') return res.writeHead(401).end();
    const json = (status, value) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (req.url === '/v1/capabilities') return json(durable || restricted ? 200 : 404, {
      features: { servant_durable_media_runs: durable, servant_exact_approvals: durable, servant_member_isolation: restricted },
      servant: { memberPolicy: { version: 1, persistentMemory: false, localContext: false, localMedia: false, allowedTools: [] } },
    });
    if (req.url === '/api/sessions/session/chat/stream' && req.method === 'POST') {
      startCount++;
      runs.set(`legacy_${startCount}`, { input: [{ role: 'user', content: body.message }] });
      histories.get('session').push({ id: `user_${startCount}`, role: 'user', content: body.message });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end('event: assistant.completed\ndata: {"content":"Read exact input"}\n\n');
    }
    if (req.url === '/api/sessions/session/messages') return json(historyOffline ? 503 : 200, { data: histories.get('session') });
    if (req.url === '/v1/runs' && req.method === 'POST') {
      startCount++;
      const id = `run_${startCount}`;
      runs.set(id, { id, status: 'running', input: body.input, events: [], response: null, subscriptions: 0 });
      histories.get('session').push({ id: `user_${startCount}`, role: 'user', content: body.input.at(-1).content });
      return json(202, { run_id: id });
    }
    const match = req.url.match(/^\/v1\/runs\/([^/]+)(\/.*)?$/), run = runs.get(match?.[1]);
    if (!run) return json(404, {});
    if (match[2] === '/events') {
      // Native Hermes consumes its event queue once. A replacement worker must
      // recover final status/approval without requiring a replayable SSE queue.
      if (run.subscriptions++) return json(404, {});
      run.response = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n');
      for (const event of run.events.splice(0)) emit(run, event.event, event);
      return;
    }
    if (['/stop', '/approval'].includes(match[2]) && controlsOffline-- > 0) return json(503, {});
    if (match[2] === '/stop') { run.status = 'cancelled'; emit(run, 'run.cancelled'); return json(200, { status: 'stopping' }); }
    if (match[2] === '/approval') {
      if (body.approval_id !== run.pending?.approval_id) return json(409, {});
      approvals.push(body); run.pending = null; run.status = 'running'; return json(200, { resolved: 1 });
    }
    if (!match[2] && req.method === 'GET') {
      if (pollsOffline-- > 0) return json(503, {});
      return json(200, { run_id: run.id, status: run.status, output: run.output, usage: run.usage, pending_approval: run.pending });
    }
    return json(404, {});
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const up = { url: `http://127.0.0.1:${upstream.address().port}`, key: 'fixture-key' };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 0, agentAccess: restricted ? 'limited' : 'full', upstreams: { owner: up, member: up } }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    users: { owner: { id: 'owner', role: 'owner', name: 'Owner' }, stranger: { id: 'stranger', role: 'owner', name: 'Stranger' } },
    devices: Object.fromEntries(['owner', 'stranger'].map(id => [crypto.createHash('sha256').update(id).digest('hex'), { id: `device_${id}`, userId: id }])),
    chats: { chat: { id: 'chat', userId: 'owner', role: restricted ? 'member' : 'owner', hermesSessionId: 'session', title: 'Test', createdAt: 1, updatedAt: 1 } }, invites: {},
  }));
  let apiChild, workerChild, base;
  const start = async name => {
    const child = spawn(process.execPath, [new URL(`./${name}.mjs`, import.meta.url).pathname], {
      env: { ...process.env, SERVANT_DATA_DIR: dir, SERVANT_PORT: '0', SERVANT_WORKER_MODE: 'external' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const item = { child, closed: once(child, 'close'), output: '' }; children.push(item);
    child.stdout.on('data', b => { item.output += b; }); child.stderr.on('data', b => { item.output += b; });
    await until(() => name === 'server' ? (base = item.output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]) : item.output.includes('durable worker ready'));
    return item;
  };
  apiChild = await start('server'); workerChild = await start('worker');
  t.after(async () => {
    for (const item of children) if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL');
    await Promise.all(children.map(c => c.closed)); upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
  });
  const api = (route, method = 'GET', body, user = 'owner') => testFetch(dir, base + route, { method,
    headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const latest = async () => (await (await api('/v1/chats/chat/turns')).json()).turns[0];
  return { dir, api, latest, runs, approvals, startCount: () => startCount,
    disconnectEvents: run => run.response?.destroy(),
    offlineHistory: value => { historyOffline = value; }, offlinePolls: count => { pollsOffline = count; },
    offlineControls: count => { controlsOffline = count; },
    emit: (run, text) => emit(run, 'message.delta', { delta: text }),
    approve: (run, command) => { run.pending = { approval_id: `approval_${run.id}`, command, choices: ['once', 'deny'] }; run.status = 'waiting_for_approval'; emit(run, 'approval.request', run.pending); },
    finish: (run, text, history = text) => { run.output = text; run.status = 'completed'; run.usage = { input_tokens: 1200, output_tokens: 300, total_tokens: 1500 }; histories.get('session').push({ id: `reply_${run.id}`, role: 'assistant', content: history }); emit(run, 'run.completed', { output: text, usage: run.usage }); run.response?.end(); },
    restartApi: async () => { apiChild.child.kill('SIGKILL'); await apiChild.closed; apiChild = await start('server'); },
    restartWorker: async () => { workerChild.child.kill('SIGKILL'); await workerChild.closed; workerChild = await start('worker'); },
  };
}

test('phone disconnect + API restart retain accepted input, partial text, media cache and idempotent completion', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const response = await f.api('/v1/chats/chat/messages', 'POST', { text: 'Long question', requestId: 'request_long' });
  await response.body.cancel();
  await until(async () => (await f.latest())?.accepted);
  const run = [...f.runs.values()][0]; f.emit(run, 'Still working');
  await until(async () => (await f.latest()).assistantText === 'Still working');
  await f.restartApi();
  f.offlineHistory(true);
  const offline = await (await f.api('/v1/chats/chat/messages')).json();
  assert.equal(offline.upstreamUnavailable, true);
  assert.equal(offline.messages[0].text, 'Long question');
  assert.equal(offline.messages.at(-1).text, 'Still working');
  assert.equal(offline.messages.at(-1).pending, true);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
  f.offlineHistory(false); f.finish(run, `Complete later\n\n![Image](data:image/png;base64,${png})`, 'Complete later\n\nMEDIA: /private/generated/picture.png');
  await until(async () => (await f.latest()).status === 'completed');
  // The durable run's token usage lands on the leaderboard once, across the API restart.
  const board = await until(async () => { const b = await (await f.api('/v1/leaderboard?period=all')).json(); return b.totals?.turns ? b : null; });
  assert.deepEqual([board.totals.total, board.totals.turns, board.people[0].user.name, board.people[0].chat], [1500, 1, 'Owner', 1500]);
  f.offlineHistory(true);
  const replay = await f.api('/v1/chats/chat/messages', 'POST', { text: 'Long question', requestId: 'request_long' });
  assert.match(await replay.text(), /Complete later/);
  assert.equal(f.startCount(), 1);
  f.offlineHistory(false);
  const messages = (await (await f.api('/v1/chats/chat/messages')).json()).messages;
  assert.deepEqual(messages.map(m => m.text), ['Long question', 'Complete later']);
  const attachment = messages.at(-1).attachments[0];
  assert.equal(attachment.mime, 'image/png');
  assert.equal((await (await f.api(`/v1/attachments/${attachment.id}`)).json()).data, png);
  const list = await (await f.api('/v1/chats')).json();
  assert.equal(list.chats[0].latestTurn.status, 'completed');
});

test('agent replies the author has not seen are unread until the chat is opened', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const unread = async (user = 'owner') => (await (await f.api('/v1/chats', 'GET', undefined, user)).json()).chats.find(c => c.id === 'chat')?.unread;
  assert.equal(await unread(), 0);
  for (const [i, question] of ['First', 'Second'].entries()) {
    const response = await f.api('/v1/chats/chat/messages', 'POST', { text: question, requestId: `request_unread_${i}` });
    await until(async () => (await f.latest())?.accepted && f.runs.size === i + 1);
    f.finish([...f.runs.values()][i], `Answer ${i + 1}`);
    await response.text();
    await until(async () => (await f.latest()).status === 'completed');
  }
  // Two finished replies, nobody has opened the chat since.
  assert.equal(await unread(), 2);
  // A running turn isn't unread yet.
  const third = await f.api('/v1/chats/chat/messages', 'POST', { text: 'Third', requestId: 'request_unread_2' });
  await until(async () => f.runs.size === 3 && (await f.latest())?.accepted);
  await third.body.cancel();
  assert.equal(await unread(), 2);
  // Someone else can't clear the author's unread count.
  assert.equal((await f.api('/v1/chats/chat/read', 'POST', {}, 'stranger')).status, 403);
  assert.equal(await unread(), 2);
  // Opening the chat reads everything; the count survives an API restart.
  assert.deepEqual(await (await f.api('/v1/chats/chat/read', 'POST', {})).json(), { unread: 0 });
  await f.restartApi();
  assert.equal(await unread(), 0);
  f.finish([...f.runs.values()][2], 'Answer 3');
  await until(async () => (await f.latest()).status === 'completed');
  assert.equal(await unread(), 1);
});

test('approval recovered from status after SSE loss is owner-bound, ID-bound and never grants blanket permission', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const response = await f.api('/v1/chats/chat/messages', 'POST', { text: 'Action', requestId: 'request_action' }); await response.body.cancel();
  await until(async () => (await f.latest())?.accepted);
  const run = [...f.runs.values()][0]; f.disconnectEvents(run); f.offlinePolls(2); f.approve(run, 'fixture action');
  const turn = await until(async () => { const turn = await f.latest(); return turn.status === 'waiting_for_approval' && turn; });
  const route = `/v1/chats/chat/turns/${turn.id}/approval`;
  assert.equal((await f.api(route, 'POST', { approvalId: turn.approval.id, choice: 'once' }, 'stranger')).status, 403); // another admin can read the chat, never control it
  assert.equal((await f.api(route, 'POST', { approvalId: turn.approval.id, choice: 'always' })).status, 400);
  assert.equal((await f.api(route, 'POST', { approvalId: 'stale', choice: 'once' })).status, 409);
  f.offlineControls(2);
  assert.equal((await f.api(route, 'POST', { approvalId: turn.approval.id, choice: 'once' })).status, 200);
  assert.equal((await f.api(route, 'POST', { approvalId: turn.approval.id, choice: 'once' })).status, 409);
  await until(() => f.approvals.length);
  assert.deepEqual(f.approvals, [{ approval_id: turn.approval.id, choice: 'once' }]);
  f.finish(run, 'Approved once');
  await until(async () => (await f.latest()).status === 'completed');
  assert.equal(f.startCount(), 1);
});

test('worker restart resumes one existing run, and authorized Stop really reaches that run', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const response = await f.api('/v1/chats/chat/messages', 'POST', { text: 'Long action', requestId: 'request_restart' }); await response.body.cancel();
  await until(async () => (await f.latest())?.accepted);
  const run = [...f.runs.values()][0]; f.emit(run, 'Saved partial');
  await until(async () => (await f.latest()).assistantText === 'Saved partial');
  await f.restartWorker();
  const turn = await until(async () => { const turn = await f.latest(); return turn.status === 'running' && turn; });
  assert.equal(turn.assistantText, 'Saved partial');
  assert.equal(f.startCount(), 1);
  const route = `/v1/chats/chat/turns/${turn.id}/stop`;
  assert.equal((await f.api(route, 'POST', {}, 'stranger')).status, 403); // another admin can read the chat, never control it
  f.offlineControls(2);
  assert.equal((await f.api(route, 'POST', {})).status, 200);
  await until(async () => (await f.latest()).status === 'cancelled');
  assert.equal(run.status, 'cancelled');
  assert.equal(f.startCount(), 1);
  const messages = (await (await f.api('/v1/chats/chat/messages')).json()).messages;
  assert.equal(messages.at(-1).interrupted, true);
  assert.equal(messages.at(-1).text, 'Saved partial');
});

test('a message too long to send inline is saved for the agent to read in sections, and the person sees it whole', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const text = Array.from({ length: 4000 }, (_, i) => `row ${i} ` + 'z'.repeat(40)).join('\n');
  const response = await f.api('/v1/chats/chat/messages', 'POST', { text, requestId: 'request_huge' });
  assert.equal(response.status, 200);
  await response.body.cancel();
  await until(async () => (await f.latest())?.accepted);
  const run = [...f.runs.values()][0];
  const sent = JSON.stringify(run.input.at(-1).content);
  assert.match(sent, /too long to send in one piece/);
  assert.ok(sent.length < 10000);
  const file = sent.match(/saved at ([^ ]+\.txt)/)[1];
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  f.finish(run, 'Read it all');
  await until(async () => (await f.latest()).status === 'completed');
  const history = await (await f.api('/v1/chats/chat/messages')).json();
  assert.equal(history.messages.find(m => m.role === 'user').text, text);
  assert.equal((await f.api('/v1/chats/chat', 'DELETE')).status, 200);
  assert.equal(fs.existsSync(file), false);
});

test('durable restricted delivery preserves long JSON without granting local-file access', { timeout: 15000 }, async t => {
  const f = await fixture(t, { restricted: true });
  const text = JSON.stringify({ payload: 'x'.repeat(70000) });
  const response = await f.api('/v1/chats/chat/messages', 'POST', { text, requestId: 'exact_json' });
  assert.equal(response.status, 200); await response.body.cancel();
  await until(async () => (await f.latest())?.accepted);
  const run = [...f.runs.values()][0];
  assert.equal(run.input.at(-1).content, text);
  assert.deepEqual(JSON.parse(run.input.at(-1).content), JSON.parse(text));
  assert.equal(fs.existsSync(path.join(f.dir, 'long-messages')), false);
  f.finish(run, 'Exact JSON received');
  await until(async () => (await f.latest()).status === 'completed');
});

test('unsupported legacy restricted input fails before acceptance instead of changing text or exposing a file', { timeout: 15000 }, async t => {
  const f = await fixture(t, { durable: false, restricted: true });
  const text = JSON.stringify({ payload: 'x'.repeat(70000) });
  const response = await f.api('/v1/chats/chat/messages', 'POST', { text, requestId: 'legacy_member_json' });
  assert.equal(response.status, 200); await response.body.cancel();
  const turn = await until(async () => { const value = await f.latest(); return value?.status === 'failed' && value; });
  assert.equal(turn.accepted, false);
  assert.equal(f.startCount(), 0);
  assert.equal(fs.existsSync(path.join(f.dir, 'long-messages')), false);
});

test('legacy owner delivery uses an exact private file for text above its inline limit', { timeout: 15000 }, async t => {
  const f = await fixture(t, { durable: false });
  const text = JSON.stringify({ payload: 'x'.repeat(70000) });
  const response = await f.api('/v1/chats/chat/messages', 'POST', { text, requestId: 'legacy_exact_json' });
  assert.equal(response.status, 200); await response.body.cancel();
  await until(async () => (await f.latest())?.status === 'completed');
  const sent = [...f.runs.values()][0].input.at(-1).content;
  assert.equal(typeof sent, 'string'); assert.ok(sent.length < 60000);
  const file = sent.match(/saved at ([^ ]+\.txt)/)[1];
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const history = await (await f.api('/v1/chats/chat/messages')).json();
  assert.equal(history.messages.find(m => m.role === 'user').text, text);
  assert.equal((await f.api('/v1/chats/chat', 'DELETE')).status, 200);
  assert.equal(fs.existsSync(file), false);
});
