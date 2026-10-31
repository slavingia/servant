import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createStateStore } from './state-store.mjs';
import { createMessaging } from './messaging.mjs';
import { testFetch } from './encrypted-test-client.mjs';

const tokens = { owner: 'event-test-owner', member: 'event-test-member', outsider: 'event-test-outsider' };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
async function until(check, description) {
  for (let i = 0; i < 250; i++) {
    const result = check();
    if (result) return result;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-events-'));
  const children = [], streams = [];
  const state = createStateStore({ directory: dir });
  state.mutate(s => {
    for (const [id, token] of Object.entries(tokens)) {
      s.users[id] = { id, name: id, role: id === 'owner' ? 'owner' : 'member' };
      s.devices[hash(token)] = { id: `${id}-device`, userId: id };
    }
  });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 0 }));
  t.after(async () => {
    for (const stream of streams) await stream.stop();
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const force = setTimeout(() => {
      for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 6000);
    try { await Promise.all(children.map(c => c.exited)); }
    finally { clearTimeout(force); }
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 2; i++) {
    const child = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], {
      env: { ...process.env, SERVANT_DATA_DIR: dir, SERVANT_PORT: '0', SERVANT_SHUTDOWN_TIMEOUT_MS: '5000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const entry = { child, exited: once(child, 'close'), output: () => output };
    children.push(entry);
    entry.base = await until(() => {
      if (child.exitCode !== null) throw new Error(output);
      return output.match(/listening on (http:\/\/127.0.0.1:\d+)/)?.[1];
    }, 'isolated API startup');
  }
  const request = (index, route, { method = 'GET', body, who = 'owner', signal } = {}) => testFetch(dir, children[index].base + route, {
    method, signal, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const api = async (index, route, options) => {
    const response = await request(index, route, options);
    const body = await response.json();
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(body)}`);
    return body;
  };
  const events = async (index, { who = 'member', after } = {}) => {
    const controller = new AbortController();
    const response = await request(index, `/v1/events${after === undefined ? '' : `?after=${after}`}`, {
      method: 'POST', body: {}, who, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const stream = { received: [], ended: false, error: null };
    const done = (async () => {
      let buffer = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            let event, data, id;
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              if (line.startsWith('data:')) data = line.slice(5).trim();
              if (line.startsWith('id:')) id = line.slice(3).trim();
            }
            if (event && data) stream.received.push({ event, data: JSON.parse(data), id });
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) stream.error = error;
      } finally { stream.ended = true; }
    })();
    stream.stop = async () => { controller.abort(); await reader.cancel().catch(() => {}); await done; };
    stream.wait = predicate => until(() => {
      if (stream.error) throw stream.error;
      return stream.received.find(predicate);
    }, 'live event');
    stream.ready = () => stream.wait(e => e.event === 'ready');
    streams.push(stream);
    return stream;
  };
  const channel = async (memberIds = ['member']) => (await api(0, '/v1/conversations', {
    method: 'POST', body: { name: `private-${crypto.randomBytes(4).toString('hex')}`, private: true, memberIds },
  })).conversation;
  const post = async (id, text, index = 0) => (await api(index, `/v1/conversations/${id}/messages`, {
    method: 'POST', body: { text },
  })).message;
  const stopApi = async index => {
    children[index].child.kill('SIGTERM');
    assert.deepEqual(await children[index].exited, [0, null], children[index].output());
  };
  return { dir, state, api, events, channel, post, stopApi };
}

test('events cross API processes and resume on the surviving API without duplicate messages', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const channel = await f.channel();
  const live = await f.events(1);
  assert.equal((await live.ready()).data.reset, true);
  const first = await f.post(channel.id, 'Before deploy');
  const received = await live.wait(e => e.event === 'message.created' && e.data.id === first.id);
  assert.match(received.id, /^\d+$/);
  await f.stopApi(1);
  await until(() => live.ended, 'old API stream closure');
  const second = await f.post(channel.id, 'During reconnect');
  const third = await f.post(channel.id, 'Still during reconnect');
  const resumed = await f.events(0, { after: received.id });
  const ready = await resumed.ready();
  assert.equal(ready.data.reset, false);
  const replayed = resumed.received.filter(e => e.event === 'message.created' && e.data.conversationId === channel.id);
  assert.deepEqual(replayed.map(e => e.data.id), [second.id, third.id]);
  assert.ok(Number(replayed[0].id) > Number(received.id));
  assert.ok(Number(replayed[1].id) > Number(replayed[0].id));
  assert.equal(new Set(replayed.map(e => e.id)).size, replayed.length);
  const fourth = await f.post(channel.id, 'After reconnect');
  await resumed.wait(e => e.event === 'message.created' && e.data.id === fourth.id);
});

test('replay resolves current message content and never exposes private events to an outsider', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const channel = await f.channel();
  const initial = await f.events(1);
  const cursor = (await initial.ready()).id;
  await initial.stop();
  const edited = await f.post(channel.id, 'old private wording');
  await f.api(0, `/v1/messages/${edited.id}`, { method: 'PATCH', body: { text: 'new private wording' } });
  const deleted = await f.post(channel.id, 'deleted private wording');
  await f.api(0, `/v1/messages/${deleted.id}`, { method: 'DELETE' });
  const resumed = await f.events(1, { after: cursor });
  await resumed.ready();
  const messages = resumed.received.filter(e => e.event.startsWith('message.') && e.data.conversationId === channel.id);
  assert.ok(messages.some(e => e.data.id === edited.id && e.data.text === 'new private wording'));
  assert.ok(messages.some(e => e.data.id === deleted.id && e.data.deleted && e.data.text === ''));
  assert.ok(!JSON.stringify(messages).includes('old private wording'));
  assert.ok(!JSON.stringify(messages).includes('deleted private wording'));
  const outsider = await f.events(0, { who: 'outsider', after: cursor });
  await outsider.ready();
  assert.equal(outsider.received.some(e => e.data.conversationId === channel.id || e.data.id === channel.id), false);
});

test('leaving or deleting a private channel replays only safe invalidations', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const channel = await f.channel(['member', 'outsider']);
  const initial = await f.events(1);
  const cursor = (await initial.ready()).id;
  await initial.stop();
  await f.post(channel.id, 'secret before leaving');
  await f.api(0, `/v1/conversations/${channel.id}/leave`, { method: 'POST', who: 'member', body: {} });
  await f.post(channel.id, 'secret after leaving');
  const left = await f.events(1, { after: cursor });
  await left.ready();
  assert.equal(left.received.some(e => e.event.startsWith('message.') && e.data.conversationId === channel.id), false);
  assert.ok(left.received.some(e => e.event === 'conversation.updated' && e.data.id === channel.id));
  assert.ok(!JSON.stringify(left.received).includes('secret'));
  await f.api(0, `/v1/conversations/${channel.id}`, { method: 'DELETE' });
  const deleted = await f.events(1, { who: 'outsider', after: cursor });
  await deleted.ready();
  assert.equal(deleted.received.some(e => e.event.startsWith('message.') && e.data.conversationId === channel.id), false);
  const invalidations = deleted.received.filter(e => e.event === 'conversation.updated' && e.data.id === channel.id);
  assert.ok(invalidations.length);
  for (const event of invalidations) assert.deepEqual(event.data, { id: channel.id });
});

test('revoking a device closes its existing event stream before delivering new content', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const channel = await f.channel();
  const live = await f.events(1);
  await live.ready();
  await f.api(0, '/v1/devices/member-device', { method: 'DELETE' });
  const message = await f.post(channel.id, 'Must not reach revoked device');
  await until(() => live.ended, 'revoked stream closure');
  assert.equal(live.received.some(e => e.data.id === message.id), false);
});

test('future and trimmed cursors explicitly request a fresh snapshot', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const channel = await f.channel();
  const initial = await f.events(1);
  const cursor = Number((await initial.ready()).id);
  await initial.stop();
  await f.post(channel.id, 'Event retained after pruning');
  const db = new DatabaseSync(path.join(f.dir, 'messages.db'));
  try { db.prepare('DELETE FROM live_events WHERE id <= ?').run(cursor); }
  finally { db.close(); }
  const stale = await f.events(1, { after: '0' });
  const reset = await stale.ready();
  assert.equal(reset.data.reset, true);
  assert.ok(Number(reset.id) > cursor);
  const future = await f.events(0, { after: String(Number.MAX_SAFE_INTEGER) });
  assert.equal((await future.ready()).data.reset, true);
});

test('message and durable publication roll back together when event insertion fails', () => {
  const user = { id: 'owner', name: 'Owner', role: 'owner' };
  const messaging = createMessaging({ file: ':memory:', users: () => ({ owner: user }), agentName: () => 'Agent' });
  try {
    const channel = messaging.createChannel(user, { name: 'atomic' });
    const before = messaging.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    const seen = [];
    const off = messaging.subscribe(user.id, (event, data) => seen.push({ event, data }));
    messaging.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON live_events BEGIN SELECT RAISE(ABORT, 'test event insert failed'); END");
    assert.throws(() => messaging.post(channel, user.id, 'Should never commit'), /test event insert failed/);
    assert.equal(messaging.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, before);
    assert.deepEqual(seen, []);
    off();
  } finally { messaging.close(); }
});

function messagingPair() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-event-acl-'));
  const people = {
    owner: { id: 'owner', name: 'Owner', role: 'owner' },
    member: { id: 'member', name: 'Member', role: 'member' },
  };
  const options = { file: path.join(dir, 'messages.db'), users: () => people, agentName: () => 'Agent' };
  const first = createMessaging(options);
  const second = createMessaging(options);
  const route = (messaging, user, method, routePath, readBody = async () => ({})) => {
    let response;
    const context = {
      user, method, parts: routePath.split('/').filter(Boolean), url: new URL(routePath, 'http://local'),
      cors: {}, readBody,
      send: (_res, status, body) => { response = { status, body }; },
      fail: (_res, status, code) => { response = { status, code }; },
    };
    return messaging.handle({}, {}, context)
      .then(() => response)
      .catch(error => {
        if (!error.status) throw error;
        return { status: error.status, code: error.code };
      });
  };
  const gated = (user, method, routePath, body) => {
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const pendingBody = new Promise(resolve => { release = () => resolve(body); });
    const result = route(first, user, method, routePath, () => { entered(); return pendingBody; });
    return { started, release, result };
  };
  const eventCount = () => second.db.prepare('SELECT COUNT(*) AS n FROM live_events').get().n;
  const close = () => {
    first.close(); second.close(); fs.rmSync(dir, { recursive: true, force: true });
  };
  return { first, second, people, route, gated, eventCount, close };
}

test('a post whose body arrives after membership removal cannot commit a message or event', async () => {
  const f = messagingPair();
  try {
    const channel = f.first.createChannel(f.people.owner, { name: 'gated-post', memberIds: ['member'] });
    const pending = f.gated(f.people.member, 'POST', `/v1/conversations/${channel.id}/messages`, { text: 'No longer allowed' });
    await pending.started;
    const left = await f.route(f.second, f.people.member, 'POST', `/v1/conversations/${channel.id}/leave`);
    assert.equal(left.status, 200);
    const beforeEvents = f.eventCount();
    const beforeMessages = f.second.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    pending.release();
    assert.ok([403, 404].includes((await pending.result).status));
    assert.equal(f.eventCount(), beforeEvents);
    assert.equal(f.second.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, beforeMessages);
    assert.equal(f.second.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE text = 'No longer allowed'").get().n, 0);
  } finally { f.close(); }
});

test('edits and reactions with delayed bodies cannot modify a concurrently deleted message', async () => {
  for (const kind of ['edit', 'reaction']) {
    const f = messagingPair();
    try {
      const channel = f.first.createChannel(f.people.owner, { name: `gated-${kind}`, memberIds: ['member'] });
      const message = f.first.post(channel, f.people.member.id, 'Will be deleted');
      const pending = kind === 'edit'
        ? f.gated(f.people.member, 'PATCH', `/v1/messages/${message.seq}`, { text: 'Must not revive content' })
        : f.gated(f.people.member, 'POST', `/v1/messages/${message.seq}/reactions`, { emoji: '👍', active: true });
      await pending.started;
      assert.equal((await f.route(f.second, f.people.owner, 'DELETE', `/v1/messages/${message.seq}`)).status, 200);
      const deleted = f.second.db.prepare('SELECT * FROM messages WHERE seq = ?').get(message.seq);
      const beforeEvents = f.eventCount();
      pending.release();
      assert.equal((await pending.result).status, 404, kind);
      assert.deepEqual(f.second.db.prepare('SELECT * FROM messages WHERE seq = ?').get(message.seq), deleted, kind);
      assert.equal(f.second.db.prepare('SELECT COUNT(*) AS n FROM reactions WHERE message_seq = ?').get(message.seq).n, 0, kind);
      assert.equal(f.eventCount(), beforeEvents, kind);
    } finally { f.close(); }
  }
});

test('a delayed channel edit cannot publish an update after another API deletes the channel', async () => {
  const f = messagingPair();
  try {
    const channel = f.first.createChannel(f.people.owner, { name: 'gated-channel', memberIds: ['member'] });
    const pending = f.gated(f.people.member, 'PATCH', `/v1/conversations/${channel.id}`, { topic: 'Must not appear' });
    await pending.started;
    assert.equal((await f.route(f.second, f.people.owner, 'DELETE', `/v1/conversations/${channel.id}`)).status, 200);
    const beforeEvents = f.eventCount();
    pending.release();
    assert.equal((await pending.result).status, 404);
    assert.equal(f.second.db.prepare('SELECT * FROM conversations WHERE id = ?').get(channel.id), undefined);
    assert.equal(f.eventCount(), beforeEvents);
  } finally { f.close(); }
});
