import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { createStateStore } from './state-store.mjs';
import { testFetch } from './encrypted-test-client.mjs';

for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === 'API_SERVER_KEY') delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-device-source-'));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_WORKER_MODE = 'external';
process.env.SERVANT_PUSH_CONFIG = path.join(directory, 'push.json');
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, '{}');
const state = createStateStore({ directory });
const tokens = { owner: 'test-source-owner', phone: 'test-source-phone', mac: 'test-source-mac', browser: 'test-source-browser', unknown: 'test-source-unknown', outsider: 'test-source-outsider' };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
state.mutate(current => {
  for (const [id, role] of [['owner', 'owner'], ['member', 'member'], ['outsider', 'member']]) current.users[id] = { id, name: id, role };
  for (const [name, token] of Object.entries(tokens)) current.devices[digest(token)] = {
    id: 'device-' + name, userId: ['owner', 'outsider'].includes(name) ? name : 'member',
    label: { owner: 'Mac', phone: 'iPhone', mac: 'Mac', browser: 'Browser', unknown: 'private workstation asset secret', outsider: 'Phone' }[name],
  };
});
const config = { host: '127.0.0.1', port: 0, name: 'Isolated device source', upstreams: {} };
let server, base, mod;
const streams = [];
before(async () => { mod = await import('./server.mjs'); server = await mod.startServer(config); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { for (const stream of streams) await stream.stop(); await server?.shutdown(); state.close(); fs.rmSync(directory, { recursive: true, force: true }); });
async function request(who, method, route, body, signal) {
  return testFetch(directory, base + route, { method, signal, headers: { Authorization: 'Bearer ' + tokens[who], 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function api(who, method, route, body) {
  const response = await request(who, method, route, body); const value = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(value)}`); return value;
}
const post = async (who, conversation, body) => (await api(who, 'POST', `/v1/conversations/${conversation}/messages`, body)).message;
const mobile = { kind: 'mobile', label: 'Mobile' }, computer = { kind: 'computer', label: 'Computer' }, browser = { kind: 'web', label: 'Browser' };
function hidden(value) { assert.ok(!JSON.stringify(value).includes('sourceDevice'), 'member response contains device metadata'); assert.ok(!JSON.stringify(value).includes('private workstation asset secret')); }

async function events(who, after = '0') {
  const controller = new AbortController(), received = [];
  const response = await request(who, 'POST', '/v1/events?after=' + after, {}, controller.signal);
  assert.equal(response.status, 200);
  const reader = response.body.getReader(); let failure;
  const done = (async () => {
    const decoder = new TextDecoder(); let buffer = '';
    try {
      for (;;) {
        const item = await reader.read(); if (item.done) break; buffer += decoder.decode(item.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const event = block.match(/(?:^|\n)event: (.+)/)?.[1], data = block.match(/(?:^|\n)data: (.+)/)?.[1], id = block.match(/(?:^|\n)id: (.+)/)?.[1];
          if (event && data) received.push({ event, data: JSON.parse(data), id });
        }
      }
    } catch (error) { if (!controller.signal.aborted) failure = error; }
  })();
  const wait = async predicate => {
    for (let i = 0; i < 200; i++) { if (failure) throw failure; const value = received.find(predicate); if (value) return value; await sleep(20); }
    throw new Error('Timed out waiting for source-device event');
  };
  const stream = { received, wait, stop: async () => { controller.abort(); await reader.cancel().catch(() => {}); await done; } };
  streams.push(stream); await wait(item => item.event === 'ready'); return stream;
}

test('channel, DM and thread source comes from authenticated device and is owner-only everywhere', async () => {
  const channel = (await api('owner', 'POST', '/v1/conversations', { name: 'source-check', memberIds: ['member'] })).conversation.id;
  const dm = (await api('owner', 'POST', '/v1/conversations', { kind: 'dm', userIds: ['member'] })).conversation.id;
  for (const conversation of [channel, dm]) {
    const first = await post('phone', conversation, { text: 'sourcecheck mobile', sourceDevice: computer, device: 'Mac', deviceId: 'device-owner' });
    hidden(first);
    const second = await post('mac', conversation, { text: 'sourcecheck computer' }); hidden(second);
    const reply = await post('browser', conversation, { text: 'sourcecheck browser reply', threadRoot: first.id }); hidden(reply);
    const ownerPost = await post('owner', conversation, { text: 'sourcecheck owner' }); assert.deepEqual(ownerPost.sourceDevice, computer);
    const ownHistory = (await api('owner', 'GET', `/v1/conversations/${conversation}/messages`)).messages;
    assert.deepEqual(ownHistory.find(message => message.id === first.id).sourceDevice, mobile);
    assert.deepEqual(ownHistory.find(message => message.id === second.id).sourceDevice, computer);
    hidden(await api('phone', 'GET', `/v1/conversations/${conversation}/messages`));
    const thread = await api('owner', 'GET', `/v1/conversations/${conversation}/threads/${first.id}`);
    assert.deepEqual(thread.root.sourceDevice, mobile); assert.deepEqual(thread.replies[0].sourceDevice, browser);
    hidden(await api('phone', 'GET', `/v1/conversations/${conversation}/threads/${first.id}`));
    // Editing from another device does not rewrite original sender provenance.
    hidden(await api('mac', 'PATCH', `/v1/messages/${first.id}`, { text: 'sourcecheck edited', sourceDevice: computer }));
    assert.deepEqual((await api('owner', 'POST', `/v1/messages/${first.id}/reactions`, { emoji: '👍', active: true })).message.sourceDevice, mobile);
    hidden(await api('phone', 'POST', `/v1/messages/${first.id}/reactions`, { emoji: '👍', active: true }));
    const detail = (await api('owner', 'GET', `/v1/conversations/${conversation}`)).conversation;
    assert.deepEqual(detail.lastMessage.sourceDevice, computer);
    hidden(await api('phone', 'GET', `/v1/conversations/${conversation}`));
    const raw = new DatabaseSync(path.join(directory, 'messages.db'));
    const saved = raw.prepare('SELECT source_device_id,source_device_kind FROM messages WHERE seq=?').get(Number(first.id));
    raw.close(); assert.equal(saved.source_device_id, 'device-phone'); assert.equal(saved.source_device_kind, 'mobile');
  }
  const ownerSearch = (await api('owner', 'GET', '/v1/search?q=sourcecheck')).messages;
  assert.ok(ownerSearch.some(message => message.sourceDevice?.kind === 'mobile'));
  assert.ok(ownerSearch.some(message => message.sourceDevice?.kind === 'web'));
  hidden(await api('phone', 'GET', '/v1/search?q=sourcecheck'));
  const ownerConversations = (await api('owner', 'GET', '/v1/conversations')).conversations;
  assert.deepEqual(ownerConversations.find(conversation => conversation.id === dm).lastMessage.sourceDevice, computer);
  hidden(await api('phone', 'GET', '/v1/conversations'));
  assert.equal((await request('outsider', 'GET', `/v1/conversations/${dm}/messages`)).status, 404);
});

test('live delivery, replay and changing owner role each recheck metadata visibility', async () => {
  const channel = (await api('owner', 'POST', '/v1/conversations', { name: 'live-source', memberIds: ['member'] })).conversation.id;
  const ownerLive = await events('owner'), memberLive = await events('phone');
  const sent = await post('phone', channel, { text: 'live mobile' });
  const ownerEvent = await ownerLive.wait(item => item.event === 'message.created' && item.data.id === sent.id);
  assert.deepEqual(ownerEvent.data.sourceDevice, mobile);
  hidden((await memberLive.wait(item => item.event === 'message.created' && item.data.id === sent.id)).data);
  const replayOwner = await events('owner'), replayMember = await events('phone');
  assert.deepEqual((await replayOwner.wait(item => item.event === 'message.created' && item.data.id === sent.id)).data.sourceDevice, mobile);
  hidden(replayMember.received);
  state.mutate(current => { current.users.owner.role = 'member'; });
  try {
    const changed = await post('mac', channel, { text: 'role changed' });
    hidden((await ownerLive.wait(item => item.event === 'message.created' && item.data.id === changed.id)).data);
    hidden(await api('owner', 'GET', `/v1/conversations/${channel}/messages`));
    const downgradedReplay = await events('owner'); hidden(downgradedReplay.received); await downgradedReplay.stop();
  } finally { state.mutate(current => { current.users.owner.role = 'owner'; }); }
  for (const stream of [ownerLive, memberLive, replayOwner, replayMember]) await stream.stop();
});

test('provenance survives restart and label changes; unknown and historical activity stay unmarked', async () => {
  const channel = (await api('owner', 'POST', '/v1/conversations', { name: 'persistent-source', memberIds: ['member'] })).conversation.id;
  const sent = await post('phone', channel, { text: 'persisted source' });
  const unknown = await post('unknown', channel, { text: 'unknown device' });
  state.mutate(current => { current.devices[digest(tokens.phone)].label = 'Mac'; });
  await server.shutdown(); server = await mod.startServer(config); base = `http://127.0.0.1:${server.address().port}`;
  const history = (await api('owner', 'GET', `/v1/conversations/${channel}/messages`)).messages;
  assert.deepEqual(history.find(message => message.id === sent.id).sourceDevice, mobile);
  assert.ok(!('sourceDevice' in history.find(message => message.id === unknown.id)));
  for (const message of history.filter(message => message.activity)) assert.ok(!('sourceDevice' in message));
  assert.ok(!JSON.stringify(history).includes('source_device_id'));
  hidden(await api('phone', 'GET', `/v1/conversations/${channel}/messages`));
});
