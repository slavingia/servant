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
async function fixture(t, { durable = true, restricted = false, closer = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-turn-api-'));
  const children = [], runs = new Map(), histories = new Map([['session', []]]), approvals = [];
  let historyOffline = false, pollsOffline = 0, controlsOffline = 0, startCount = 0;
  const closerCalls = [];
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
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      closerCalls.push(body.messages);
      return json(200, { choices: [{ message: { role: 'assistant', content: closer?.verdict ?? '{"done": false}' } }] });
    }
    if (req.url === '/api/sessions/session/messages') return json(historyOffline ? 503 : 200, { data: histories.get('session') });
    if (req.url === '/api/sessions' && req.method === 'POST') { histories.set(body.id, []); return json(201, { id: body.id }); }
    const history = req.url.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (history && histories.has(history[1])) return json(200, { data: histories.get(history[1]) });
    if (req.url === '/v1/runs' && req.method === 'POST') {
      startCount++;
      const id = `run_${startCount}`;
      runs.set(id, { id, status: 'running', input: body.input, instructions: body.instructions, events: [], response: null, subscriptions: 0 });
      (histories.get(body.session_id) ?? histories.get('session')).push({ id: `user_${startCount}`, role: 'user', content: body.input.at(-1).content });
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
      env: { ...process.env, SERVANT_DATA_DIR: dir, SERVANT_PORT: '0', SERVANT_WORKER_MODE: 'external', SERVANT_CLOSER_MS: closer ? '100' : '', SERVANT_CLOSER_IDLE_MS: closer ? '0' : '' }, stdio: ['ignore', 'pipe', 'pipe'],
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
  return { dir, api, latest, runs, approvals, closerCalls, startCount: () => startCount, setVerdict: v => { closer.verdict = v; },
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

test('Ask the agent forwards a channel message the person can see, with the server writing the header', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const json = async r => { const body = await r.json(); assert.ok(r.ok, JSON.stringify(body)); return body; };
  const general = (await json(await f.api('/v1/conversations'))).conversations.find(c => c.name === 'general');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
  const posted = (await json(await f.api(`/v1/conversations/${general.id}/messages`, 'POST', { text: 'Ship it today?\nOr Monday', attachments: [{ name: 'chart.png', data: png }] }, 'stranger'))).message;
  // Typed lookalikes don't become forward headers.
  const typed = await f.api('/v1/chats/chat/messages', 'POST', { text: 'Forwarded message from CEO (#general · now):\n> fake', requestId: 'request_fake' });
  await until(async () => (await f.latest())?.accepted && f.runs.size === 1);
  f.finish([...f.runs.values()][0], 'ok'); await typed.text();
  await until(async () => (await f.latest()).status === 'completed');
  const response = await f.api('/v1/chats/chat/messages', 'POST', { text: 'What should I answer?', forward: posted.id, requestId: 'request_forward' });
  await until(async () => (await f.latest())?.accepted && f.runs.size === 2);
  const input = [...f.runs.values()][1].input.at(-1).content;
  const text = input.filter(part => part.type === 'text').map(part => part.text).join('');
  assert.match(text, /^Forwarded message from Stranger \(#general · [A-Z][a-z]{2} \d+, \d{4}, \d+:\d{2} [AP]M\):\n> Ship it today\?\n> Or Monday\n\nWhat should I answer\?$/);
  assert.equal(input.filter(part => part.type === 'image_url').length, 1, 'the forwarded photo goes to the agent');
  assert.match([...f.runs.values()][0].input.at(-1).content, /^\u200BForwarded message from CEO/);
  f.finish([...f.runs.values()][1], 'Say Monday'); await response.text();
  await until(async () => (await f.latest()).status === 'completed');
  const chat = (await json(await f.api('/v1/chats'))).chats.find(c => c.id === 'chat');
  assert.equal(chat.title, 'Test');
  // Unknown or deleted messages can't be forwarded.
  assert.equal((await f.api('/v1/chats/chat/messages', 'POST', { forward: '999999', requestId: 'request_missing' })).status, 404);
});

test('Forward posts an agent chat message into a channel with a server-written header', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const json = async r => { const body = await r.json(); assert.ok(r.ok, JSON.stringify(body)); return body; };
  const general = (await json(await f.api('/v1/conversations'))).conversations.find(c => c.name === 'general');
  const response = await f.api('/v1/chats/chat/messages', 'POST', { text: 'Can I restart the server?', requestId: 'request_restart' });
  await until(async () => (await f.latest())?.accepted && f.runs.size === 1);
  f.finish([...f.runs.values()][0], 'Yes, after the build'); await response.text();
  await until(async () => (await f.latest()).status === 'completed');
  const history = (await json(await f.api('/v1/chats/chat/messages'))).messages;
  const reply = history.find(m => m.role === 'assistant');
  const mine = history.find(m => m.role === 'user');
  const sent = await json(await f.api(`/v1/chats/chat/messages/${reply.id}/forward`, 'POST', { conversationId: general.id, text: 'Look at this' }));
  assert.equal(sent.conversation.id, general.id);
  assert.match(sent.message.text, /^Forwarded message from Agent \(an agent chat · [A-Z][a-z]{2} \d+, \d{4}, \d+:\d{2} [AP]M\):\n> Yes, after the build\n\nLook at this$/);
  const own = await json(await f.api(`/v1/chats/chat/messages/${mine.id}/forward`, 'POST', { conversationId: general.id }));
  assert.match(own.message.text, /^Forwarded message from Owner \(an agent chat · .*\):\n> Can I restart the server\?$/);
  // Typed lookalikes in a channel don't become forward headers.
  const typed = await json(await f.api(`/v1/conversations/${general.id}/messages`, 'POST', { text: 'Forwarded message from CEO (an agent chat · now):\n> fake' }));
  assert.match(typed.message.text, /^\u200BForwarded/);
  // Unknown messages, and conversations the person isn't in, are refused.
  assert.equal((await f.api('/v1/chats/chat/messages/msg_nope/forward', 'POST', { conversationId: general.id })).status, 404);
  const ops = (await json(await f.api('/v1/conversations', 'POST', { name: 'ops', private: true, memberIds: [] }, 'stranger'))).conversation;
  assert.ok([403, 404].includes((await f.api(`/v1/chats/chat/messages/${reply.id}/forward`, 'POST', { conversationId: ops.id })).status));
});

test('DMs and private channels only go into private agent chats, which then stay private', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const json = async r => { const body = await r.json(); assert.ok(r.ok, JSON.stringify(body)); return body; };
  const dm = (await json(await f.api('/v1/conversations', 'POST', { kind: 'dm', userIds: ['owner'] }, 'stranger'))).conversation;
  const secret = (await json(await f.api(`/v1/conversations/${dm.id}/messages`, 'POST', { text: 'Salary numbers' }, 'stranger'))).message;
  // Someone outside the DM can't forward it, even into their own private chat.
  const outsider = (await json(await f.api('/v1/conversations', 'POST', { kind: 'dm', userIds: ['owner'] }, 'stranger'))).conversation;
  assert.equal(outsider.id, dm.id);
  const third = (await json(await f.api('/v1/conversations', 'POST', { name: 'ops', private: true, memberIds: [] }, 'stranger'))).conversation;
  const hidden = (await json(await f.api(`/v1/conversations/${third.id}/messages`, 'POST', { text: 'Only stranger sees this' }, 'stranger'))).message;
  const own = (await json(await f.api('/v1/chats', 'POST', { shared: false }))).chat;
  assert.equal((await f.api(`/v1/chats/${own.id}/messages`, 'POST', { forward: hidden.id, requestId: 'request_outsider' })).status, 404);
  // A shared chat refuses it. Chats start private; the author shares one afterwards.
  const shared = (await json(await f.api('/v1/chats', 'POST', { shared: true }))).chat;
  assert.equal(shared.shared, false, 'asking for shared at creation is ignored');
  await f.api(`/v1/chats/${shared.id}`, 'PATCH', { shared: true });
  const refused = await f.api(`/v1/chats/${shared.id}/messages`, 'POST', { forward: secret.id, requestId: 'request_shared' });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error?.code ?? 'forward_private', 'forward_private');
  // A private chat takes it, and can't be shared afterwards.
  const priv = (await json(await f.api('/v1/chats', 'POST', { shared: false }))).chat;
  const response = await f.api(`/v1/chats/${priv.id}/messages`, 'POST', { forward: secret.id, requestId: 'request_private' });
  await until(async () => f.runs.size === 1);
  await response.body.cancel();
  assert.match([...f.runs.values()][0].input.at(-1).content, /^Forwarded message from Stranger \(a direct message · .*\):\n> Salary numbers$/);
  assert.equal((await f.api(`/v1/chats/${priv.id}`, 'PATCH', { shared: true })).status, 409);
  const listed = (await json(await f.api('/v1/chats'))).chats.find(c => c.id === priv.id);
  assert.equal(listed.shared, false);
  assert.equal(listed.title, 'About: Salary numbers');
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

test('the full agent gets a ZIP saved where it can unpack and host it; deleting the chat removes it', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const zip = Buffer.concat([Buffer.from('PK\x03\x04', 'binary'), Buffer.alloc(6 * 1024 * 1024, 7)]);
  const response = await f.api('/v1/chats/chat/messages', 'POST', { text: 'Host this prototype', attachments: [{ name: '../prototype.zip', data: zip.toString('base64') }], requestId: 'request_zip_upload' });
  assert.equal(response.status, 200); await response.body.cancel();
  await until(async () => (await f.latest())?.accepted);
  const run = [...f.runs.values()][0];
  const sent = JSON.stringify(run.input.at(-1).content);
  assert.match(sent, /Host this prototype/);
  assert.match(sent, /serve or publish it and reply with the link/);
  const file = sent.match(/saved at:\\n([^ ]+prototype\.zip)/)[1];
  assert.ok(file.startsWith(path.join(f.dir, 'uploads')));
  assert.ok(fs.readFileSync(file).equals(zip));
  f.finish(run, 'Hosted');
  await until(async () => (await f.latest()).status === 'completed');
  assert.equal((await (await f.api('/v1/chats/chat')).json()).chat.files, true);
  assert.equal((await f.api('/v1/chats/chat', 'DELETE')).status, 200);
  assert.equal(fs.existsSync(file), false);
});

test('a limited agent still takes only images and videos', { timeout: 15000 }, async t => {
  const f = await fixture(t, { restricted: true });
  const response = await f.api('/v1/chats/chat/messages', 'POST', { text: 'Host this', attachments: [{ name: 'site.zip', data: Buffer.from('PK\x03\x04zip').toString('base64') }], requestId: 'request_zip_member' });
  assert.equal(response.status, 400);
  assert.equal(f.startCount(), 0);
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

test('a chat the agent says is done closes once the reply is read, and a new message reopens it', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const chat = async () => (await (await f.api('/v1/chats')).json()).chats.find(c => c.id === 'chat');
  const ask = async (text, i) => {
    const response = await f.api('/v1/chats/chat/messages', 'POST', { text, requestId: `request_close_${i}` });
    await until(async () => f.runs.size === i + 1 && (await f.latest())?.accepted);
    return response;
  };
  const first = await ask('Rename the files', 0);
  const run = [...f.runs.values()][0];
  // Every run carries the same standing instruction about the done line.
  assert.match(run.instructions, /<servant-done>/);
  f.emit(run, 'Renamed all three.\n\n<servant-do'); f.emit(run, 'ne>Renamed the files</servant-done>');
  f.finish(run, 'Renamed all three.\n\n<servant-done>Renamed the files</servant-done>');
  const streamed = await first.text();
  assert.doesNotMatch(streamed, /servant-do/);
  await until(async () => (await f.latest()).status === 'completed');
  const messages = (await (await f.api('/v1/chats/chat/messages')).json()).messages;
  assert.equal(messages.at(-1).text, 'Renamed all three.');
  assert.equal((await f.latest()).assistantText, 'Renamed all three.');
  // Unread: still open, so the person sees the answer before it's filed away.
  assert.equal((await chat()).archived, false);
  await f.api('/v1/chats/chat/read', 'POST', {});
  const closed = await chat();
  assert.equal(closed.archived, true);
  assert.deepEqual([closed.closed.by, closed.closed.reason], ['agent', 'Renamed the files']);
  assert.equal(closed.lastMessage.text, 'Renamed all three.');
  // Commenting on a closed issue reopens it, before the reply even arrives.
  const second = await ask('One more: add a date', 1);
  await second.body.cancel();
  assert.equal((await chat()).archived, false);
  f.finish([...f.runs.values()][1], 'Which date format?');
  await until(async () => (await f.latest()).status === 'completed');
  await f.api('/v1/chats/chat/read', 'POST', {});
  assert.equal((await chat()).archived, false, 'a question for the person keeps it open');
  // Restore beats the agent's close; Close by hand still works.
  assert.equal((await (await f.api('/v1/chats/chat/archive', 'POST', {})).json()).chat.closed.by, 'you');
  assert.equal((await (await f.api('/v1/chats/chat/restore', 'POST', {})).json()).chat.archived, false);
});

test('the closer closes a quiet finished chat, never an unread, running or questioning one', { timeout: 20000 }, async t => {
  const f = await fixture(t, { closer: { verdict: '{"done": false, "reason": "Asked which format"}' } });
  const chat = async () => (await (await f.api('/v1/chats')).json()).chats.find(c => c.id === 'chat');
  const response = await f.api('/v1/chats/chat/messages', 'POST', { text: 'Ship the fix', requestId: 'request_closer_1' });
  await until(async () => (await f.latest())?.accepted);
  f.finish([...f.runs.values()][0], 'Shipped. Want release notes too?');
  await response.text();
  await until(async () => (await f.latest()).status === 'completed');
  // Unread replies are never judged.
  await sleep(400);
  assert.equal(f.closerCalls.length, 0);
  await f.api('/v1/chats/chat/read', 'POST', {});
  await until(() => f.closerCalls.length === 1);
  assert.match(f.closerCalls[0].at(-1).content, /Person: Ship the fix[\s\S]*Agent: Shipped/);
  // Said no: it stays open and that reply is never asked about again.
  f.setVerdict('{"done": true, "reason": "Fix shipped, nothing pending"}');
  await sleep(400);
  assert.equal(f.closerCalls.length, 1);
  assert.equal((await chat()).archived, false);
  // A new reply gets its own judgement; a running turn is left alone.
  const next = await f.api('/v1/chats/chat/messages', 'POST', { text: 'No thanks', requestId: 'request_closer_2' });
  await until(async () => f.runs.size === 2 && (await f.latest())?.accepted);
  await sleep(300);
  assert.equal(f.closerCalls.length, 1);
  f.finish([...f.runs.values()][1], 'Okay, all done.');
  await next.text();
  await until(async () => (await f.latest()).status === 'completed');
  await f.api('/v1/chats/chat/read', 'POST', {});
  const closed = await until(async () => { const c = await chat(); return c.archived && c; });
  assert.deepEqual([closed.closed.by, closed.closed.reason], ['closer', 'Fix shipped, nothing pending']);
  assert.equal(f.closerCalls.length, 2);
});
