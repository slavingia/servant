// Exercise the deployed pre-provenance worker unchanged, including its already
// prepared SQLite statements, while replacing only the API with the new source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { testFetch } from './encrypted-test-client.mjs';
import { createStateStore } from './state-store.mjs';

const LEGACY_COMMIT = '1da98ef60253032e0fccdd3e0c7d01bf9cbc0f92';
const serverDirectory = fileURLToPath(new URL('.', import.meta.url));
const repository = path.dirname(serverDirectory);

async function until(check, message) {
  for (let i = 0; i < 400; i++) {
    const result = await check();
    if (result) return result;
    await sleep(20);
  }
  throw new Error(message || 'Timed out waiting for mixed-version fixture');
}

function legacySource(directory) {
  // CI fetches history for this test. Missing pinned code must fail rather than
  // silently substituting the new worker and claiming rolling compatibility.
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', LEGACY_COMMIT, '--', 'server/'], { cwd: repository, encoding: 'utf8' }).trim().split('\n');
  for (const name of files) {
    if (!/^server\/[^/]+\.(mjs|json)$/.test(name) || name.endsWith('.test.mjs') || name.endsWith('/encrypted-test-client.mjs')) continue;
    fs.writeFileSync(path.join(directory, path.basename(name)), execFileSync('git', ['show', `${LEGACY_COMMIT}:${name}`], { cwd: repository }));
  }
  assert.ok(fs.existsSync(path.join(directory, 'worker.mjs')));
}

function events(text) {
  return text.split(/\r?\n\r?\n/).flatMap(block => {
    const event = block.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    return event && data ? [{ event, data: JSON.parse(data) }] : [];
  });
}

test('new API preserves owner-only device source while the pinned legacy worker stays running', { timeout: 30000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'servant-source-compat-')));
  const directory = path.join(root, 'data');
  const legacy = path.join(root, 'legacy-source');
  fs.mkdirSync(directory); fs.mkdirSync(legacy);
  const processes = [];
  const histories = new Map();
  let sequence = 0, offline = false, stateStore;
  const upstream = http.createServer(async (req, res) => {
    const json = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (req.headers.authorization !== 'Bearer isolated-fixture-key') return json(401, {});
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (req.url === '/v1/capabilities') return json(404, {});
    if (req.url === '/api/sessions' && req.method === 'POST') {
      histories.set(body.id, []);
      return json(201, { id: body.id });
    }
    const match = req.url.match(/^\/api\/sessions\/([^/]+)\/(messages|chat\/stream)$/);
    if (!match) return json(404, {});
    const session = decodeURIComponent(match[1]);
    const history = histories.get(session) || [];
    histories.set(session, history);
    if (match[2] === 'messages') return json(offline ? 503 : 200, { messages: history });
    const current = ++sequence;
    history.push({ id: `upstream-user-${current}`, role: 'user', content: body.message,
      sourceDevice: { kind: 'web', label: 'FORGED upstream browser' } });
    history.push({ id: `upstream-answer-${current}`, role: 'assistant', content: `Fixture answer ${current}`,
      sourceDevice: { kind: 'computer', label: 'FORGED upstream computer' } });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`event: assistant.completed\ndata: ${JSON.stringify({ content: `Fixture answer ${current}` })}\n\n`);
  });
  t.after(async () => {
    for (const item of processes) if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL');
    await Promise.all(processes.map(item => item.closed));
    stateStore?.close();
    upstream.closeAllConnections();
    if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  legacySource(legacy);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const fake = { url: `http://127.0.0.1:${upstream.address().port}`, key: 'isolated-fixture-key' };
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ name: 'Isolated compatibility fixture', host: '127.0.0.1', port: 0, agentAccess: 'full', upstreams: { owner: fake, member: fake } }));
  fs.writeFileSync(path.join(root, 'push-disabled.json'), '{}');
  const devices = [['owner-phone', 'owner', 'iPhone'], ['owner-computer', 'owner', 'Mac'], ['member-phone', 'member', 'Android phone']];
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    users: { owner: { id: 'owner', role: 'owner', name: 'Owner' }, member: { id: 'member', role: 'member', name: 'Member' } },
    devices: Object.fromEntries(devices.map(([token, userId, label]) => [crypto.createHash('sha256').update(token).digest('hex'), { id: `device-${token}`, userId, label }])),
    invites: {},
    chats: Object.fromEntries(['owner', 'member'].map(userId => [`chat-${userId}`, { id: `chat-${userId}`, userId, role: userId === 'owner' ? 'owner' : 'member', hermesSessionId: `session-${userId}`, title: 'Fixture chat', createdAt: 1, updatedAt: 1 }])),
  }));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SERVANT_|HERMES_|API_SERVER_KEY$)/.test(key)));
  Object.assign(environment, { SERVANT_DATA_DIR: directory, SERVANT_HOST: '127.0.0.1', SERVANT_PORT: '0', SERVANT_WORKER_MODE: 'external', SERVANT_PUSH_CONFIG: path.join(root, 'push-disabled.json') });
  const start = async (source, name) => {
    const child = spawn(process.execPath, [path.join(source, `${name}.mjs`)], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const item = { child, closed: once(child, 'close'), output: '', base: null }; processes.push(item);
    child.stdout.on('data', bytes => { item.output += bytes; });
    child.stderr.on('data', bytes => { item.output += bytes; });
    await until(() => {
      if (child.exitCode !== null) throw new Error(`${name} failed to start: ${item.output}`);
      return name === 'worker' ? item.output.includes('durable worker ready') : (item.base = item.output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]);
    });
    return item;
  };
  let api = await start(legacy, 'server');
  const worker = await start(legacy, 'worker');
  const request = (route, token = 'owner-phone', method = 'GET', body) => testFetch(directory, api.base + route, { method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const submit = async (text, requestId, token = 'owner-phone', chat = 'chat-owner') => {
    const response = await request(`/v1/chats/${chat}/messages`, token, 'POST', { text, requestId, sourceDevice: { kind: 'web', label: 'FORGED request' } });
    assert.equal(response.status, 200);
    const result = events(await response.text());
    assert.ok(result.some(item => item.event === 'done' && item.data.status === 'completed'));
    return result;
  };

  const before = await submit('Before source rollout', 'source-before-rollout');
  assert.equal(before.find(item => item.event === 'sent').data.message.sourceDevice, undefined);
  const legacyDb = new DatabaseSync(path.join(directory, 'agent-turns.db'));
  assert.equal(legacyDb.prepare('PRAGMA table_info(private_turns)').all().some(column => column.name === 'source_device_kind'), false);
  legacyDb.close();
  const channelResponse = await request('/v1/conversations', 'owner-phone', 'POST', { name: 'compatibility' });
  assert.equal(channelResponse.status, 201);
  const channelId = (await channelResponse.json()).conversation.id;

  api.child.kill('SIGTERM'); await api.closed;
  api = await start(serverDirectory, 'server');
  assert.equal(worker.child.exitCode, null, 'Legacy worker must survive the API replacement');
  stateStore = createStateStore({ directory });

  const mobile = await submit('Phone after source rollout', 'source-after-mobile');
  const computer = await submit('Mac after source rollout', 'source-after-computer', 'owner-computer');
  assert.deepEqual(mobile.find(item => item.event === 'sent').data.message.sourceDevice, { kind: 'mobile', label: 'Mobile' });
  assert.deepEqual(computer.find(item => item.event === 'sent').data.message.sourceDevice, { kind: 'computer', label: 'Computer' });
  assert.ok([...mobile, ...computer].filter(item => item.event === 'message').every(item => !Object.hasOwn(item.data, 'sourceDevice')));

  const db = new DatabaseSync(path.join(directory, 'agent-turns.db'));
  const snapshots = db.prepare('SELECT request_id,source_device_kind FROM private_turns ORDER BY seq').all();
  assert.deepEqual(snapshots.map(row => row.source_device_kind), [null, 'mobile', 'computer']);
  // Old worker writes plain stored event payloads. Decoration happens in the
  // new API, so it cannot leak to members or survive a role change in replay.
  const storedSent = db.prepare("SELECT payload FROM private_turn_events WHERE event='sent'").all();
  assert.ok(storedSent.every(row => !Object.hasOwn(JSON.parse(row.payload).message, 'sourceDevice')));
  db.close();

  const sharedHistory = await (await request('/v1/chats/chat-owner/messages', 'owner-computer')).json();
  const userRows = sharedHistory.messages.filter(message => message.role === 'user');
  assert.equal(userRows.find(message => message.text === 'Before source rollout').sourceDevice, undefined);
  assert.equal(userRows.find(message => message.text === 'Phone after source rollout').sourceDevice.kind, 'mobile');
  assert.equal(userRows.find(message => message.text === 'Mac after source rollout').sourceDevice.kind, 'computer');
  assert.ok(sharedHistory.messages.filter(message => message.role === 'assistant').every(message => !Object.hasOwn(message, 'sourceDevice')));
  stateStore.mutate(state => { state.devices[crypto.createHash('sha256').update('owner-phone').digest('hex')].label = 'Mac'; });
  offline = true;
  const offlineHistory = await (await request('/v1/chats/chat-owner/messages', 'owner-computer')).json();
  assert.equal(offlineHistory.upstreamUnavailable, true);
  assert.equal(offlineHistory.messages.find(message => message.text === 'Phone after source rollout').sourceDevice.kind, 'mobile', 'Historical source is a snapshot, not a current device-label lookup');
  offline = false;

  const member = await submit('Member phone input', 'source-member-mobile', 'member-phone', 'chat-member');
  assert.ok(member.filter(item => ['sent', 'message'].includes(item.event)).every(item => !Object.hasOwn(item.event === 'sent' ? item.data.message : item.data, 'sourceDevice')));
  const memberHistory = await (await request('/v1/chats/chat-member/messages', 'member-phone')).json();
  assert.ok(memberHistory.messages.every(message => !Object.hasOwn(message, 'sourceDevice')));

  // The old worker's prepared six-column INSERT still writes agent replies after
  // the new API adds nullable source columns and writes its eight-column INSERT.
  const channelMessage = await request(`/v1/conversations/${channelId}/messages`, 'owner-computer', 'POST', { text: '@agent Check mixed versions' });
  assert.equal(channelMessage.status, 201);
  const trigger = (await channelMessage.json()).message;
  assert.equal(trigger.sourceDevice.kind, 'computer');
  const channelHistory = await until(async () => {
    const data = await (await request(`/v1/conversations/${channelId}/threads/${trigger.id}`)).json();
    return data.replies?.some(message => message.user.agent && !message.pending) ? data.replies : null;
  }, 'Legacy worker did not finish channel reply after migration');
  assert.ok(channelHistory.filter(message => message.user.agent).every(message => !Object.hasOwn(message, 'sourceDevice')));
  assert.equal(worker.child.exitCode, null);

  stateStore.mutate(state => { state.users.owner.role = 'member'; });
  const replay = await submit('Phone after source rollout', 'source-after-mobile', 'owner-computer');
  assert.equal(replay.find(item => item.event === 'sent').data.message.sourceDevice, undefined, 'Replay rechecks the viewer role');
  const demotedHistory = await (await request('/v1/chats/chat-owner/messages', 'owner-computer')).json();
  assert.ok(demotedHistory.messages.every(message => !Object.hasOwn(message, 'sourceDevice')));
});
