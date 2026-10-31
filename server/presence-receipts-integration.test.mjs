import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStateStore } from './state-store.mjs';
import { testFetch } from './encrypted-test-client.mjs';

async function until(check, label) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const value = check();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-read-receipts-http-'));
  const state = createStateStore({ directory: dir });
  const tokens = { ada: 'read-receipts-test-ada', ben: 'read-receipts-test-ben' };
  state.mutate(s => {
    for (const [id, token] of Object.entries(tokens)) {
      s.users[id] = { id, name: id === 'ada' ? 'Ada Reader' : 'Ben Sender', role: id === 'ben' ? 'owner' : 'member' };
      s.devices[crypto.createHash('sha256').update(token).digest('hex')] = { id: `${id}-device`, userId: id };
    }
  });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 0, upstreams: {} }));
  const children = [], streams = [];
  t.after(async () => {
    for (const stream of streams) await stream.stop();
    for (const entry of children) if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGTERM');
    const force = setTimeout(() => {
      for (const entry of children) if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL');
    }, 6000);
    try { await Promise.all(children.map(entry => entry.done)); }
    finally { clearTimeout(force); state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const start = async () => {
    const child = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], {
      env: { ...process.env, SERVANT_DATA_DIR: dir, SERVANT_HOST: '127.0.0.1', SERVANT_PORT: '0', SERVANT_WORKER_MODE: 'external', SERVANT_SHUTDOWN_TIMEOUT_MS: '5000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const entry = { child, done: once(child, 'close'), output: () => output };
    children.push(entry);
    entry.base = await until(() => {
      if (child.exitCode !== null) throw new Error(output);
      return output.match(/listening on (http:\/\/127.0.0.1:\d+)/)?.[1];
    }, 'API startup');
    entry.stop = async () => {
      child.kill('SIGTERM');
      assert.deepEqual(await entry.done, [0, null], output);
    };
    return entry;
  };
  const request = (server, who, route, { method = 'GET', body, signal } = {}) => testFetch(dir, server.base + route, {
    method, signal, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const api = async (server, who, route, body) => {
    const response = await request(server, who, route, body === undefined ? {} : { method: 'POST', body });
    const result = await response.json();
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(result)}`);
    return result;
  };
  const events = async server => {
    const controller = new AbortController();
    const response = await request(server, 'ben', '/v1/events', { method: 'POST', body: {}, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const received = [];
    let failure;
    const done = (async () => {
      let buffer = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const event = block.match(/(?:^|\n)event: (.+)/)?.[1];
            const data = block.match(/(?:^|\n)data: (.+)/)?.[1];
            if (event && data) received.push({ event, data: JSON.parse(data) });
          }
        }
      } catch (error) { if (!controller.signal.aborted) failure = error; }
    })();
    const stream = {
      received,
      wait: predicate => until(() => { if (failure) throw failure; return received.find(predicate); }, 'encrypted live event'),
      stop: async () => { controller.abort(); await reader.cancel().catch(() => {}); await done; },
    };
    streams.push(stream);
    await stream.wait(e => e.event === 'ready');
    return stream;
  };
  return { start, api, events };
}

test('encrypted HTTP presence and exact message receipts reach the sender and survive an API restart', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const first = await f.start();
  const dm = (await f.api(first, 'ben', '/v1/conversations', { kind: 'dm', userIds: ['ada'] })).conversation;
  const post = async (text, threadRoot) => (await f.api(first, 'ben', `/v1/conversations/${dm.id}/messages`, { text, threadRoot })).message;
  const unseen = await post('An older message Ada has not seen');
  const seen = await post('A visible message from Ben');
  const reply = await post('A visible thread reply', seen.id);
  const live = await f.events(first);
  const active = await f.api(first, 'ada', '/v1/presence', { sessionId: 'ada-test-session', active: true });
  assert.equal(active.online, true);
  const online = await live.wait(e => e.event === 'presence.updated' && e.data.userId === 'ada' && e.data.online);
  assert.equal(online.data.lastSeenAt, active.lastSeenAt);
  const people = await f.api(first, 'ben', '/v1/people');
  assert.equal(people.people.find(p => p.id === 'ada').online, true);

  await f.api(first, 'ada', `/v1/conversations/${dm.id}/read`, { messageIds: [seen.id, reply.id] });
  const receipt = await live.wait(e => e.event === 'messages.read' && e.data.userId === 'ada');
  assert.deepEqual(receipt.data.messageIds, [seen.id, reply.id]);
  assert.equal(receipt.data.conversationId, dm.id);
  const posts = (await f.api(first, 'ben', `/v1/conversations/${dm.id}/messages`)).messages;
  assert.deepEqual(posts.find(p => p.id === unseen.id).readBy, []);
  assert.deepEqual(posts.find(p => p.id === seen.id).readBy, [{ userId: 'ada', readAt: receipt.data.readAt }]);
  const thread = await f.api(first, 'ben', `/v1/conversations/${dm.id}/threads/${seen.id}`);
  assert.deepEqual(thread.replies[0].readBy, [{ userId: 'ada', readAt: receipt.data.readAt }]);

  const inactive = await f.api(first, 'ada', '/v1/presence', { sessionId: 'ada-test-session', active: false });
  assert.equal(inactive.online, false);
  await live.wait(e => e.event === 'presence.updated' && e.data.userId === 'ada' && !e.data.online);
  await live.stop();
  await first.stop();
  const restarted = await f.start();
  const restored = (await f.api(restarted, 'ben', `/v1/conversations/${dm.id}/messages`)).messages;
  assert.deepEqual(restored.find(p => p.id === seen.id).readBy, [{ userId: 'ada', readAt: receipt.data.readAt }]);
  const ada = (await f.api(restarted, 'ben', '/v1/people')).people.find(p => p.id === 'ada');
  assert.equal(ada.online, false);
  assert.equal(ada.lastSeenAt, inactive.lastSeenAt);
});
