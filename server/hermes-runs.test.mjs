import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readHermesEvents, runDurableHermes, stopRunByKey, stopRunVerified, supportsDurableRuns } from './hermes-runs.mjs';

test('a failed capability probe cannot silently downgrade action controls', async t => {
  let status = 503, features = {};
  const server = http.createServer((_req, res) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ features })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const up = { url: `http://127.0.0.1:${server.address().port}`, key: 'fixture' };
  await assert.rejects(supportsDurableRuns(up), { code: 'agent_error' });
  status = 404; assert.equal(await supportsDurableRuns(up), false);
  status = 200; features = { servant_durable_media_runs: true };
  assert.equal(await supportsDurableRuns(up), false);
  features.servant_exact_approvals = true;
  assert.equal(await supportsDurableRuns(up), true);
});

test('Stop takes priority over an already queued Allow once for the same run', async t => {
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume body */ }
    calls.push(req.url);
    const status = req.url.endsWith('/events') ? 404 : 200;
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'cancelled' }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const result = await runDurableHermes({
    up: { url: `http://127.0.0.1:${upstream.address().port}`, key: 'fixture-key' }, runId: 'existing',
    controls: () => ({ stop: true, choice: 'once', approval: { id: 'approval_1' } }),
    onAccepted: () => assert.fail('must never resubmit an existing run'), onEvent: () => {}, checkpoint: () => assert.fail('must retain existing run'), pollMs: 1,
  });
  assert.equal(result.status, 'cancelled');
  assert.ok(calls.includes('/v1/runs/existing/stop'));
  assert.ok(!calls.includes('/v1/runs/existing/approval'));
  assert.ok(!calls.includes('/v1/runs'));
});

test('event parser handles split CRLF, UTF-8 and data-only structured run events', async () => {
  const bytes = new TextEncoder().encode('data: {"event":"message.delta","delta":"café"}\r\n\r\n');
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const events = [];
  await readHermesEvents(stream, (name, payload) => events.push([name, payload.delta]));
  assert.deepEqual(events, [['message.delta', 'café']]);
});

test('a resumed run without live events shows progress from status and finishes', async t => {
  let polls = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume body */ }
    // Older bridges drop the event stream once its first subscriber leaves.
    if (req.url.endsWith('/events')) return res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
    polls++;
    const body = polls < 3 ? { status: 'running', last_event: polls === 1 ? 'tool.started' : 'tool.completed' }
      : { status: 'completed', output: 'All done' };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const events = [];
  const result = await runDurableHermes({
    up: { url: `http://127.0.0.1:${upstream.address().port}`, key: 'fixture-key' }, runId: 'resumed',
    controls: () => ({}), onAccepted: () => assert.fail('must never resubmit'), onEvent: (name, payload) => events.push([name, payload]),
    checkpoint: () => assert.fail('must retain existing run'), pollMs: 1,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.answer, 'All done');
  assert.deepEqual(events.map(([name]) => name), ['tool.started', 'tool.completed', 'assistant.completed']);
});

test('Stop on a run the bridge no longer holds ends the turn instead of hanging', async t => {
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume body */ }
    if (req.url.endsWith('/stop') || req.url.endsWith('/events')) return res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'running' }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const result = await runDurableHermes({
    up: { url: `http://127.0.0.1:${upstream.address().port}`, key: 'fixture-key' }, runId: 'orphan',
    controls: () => ({ stop: true }), onAccepted: () => {}, onEvent: () => {}, checkpoint: () => {}, pollMs: 1,
  });
  assert.equal(result.status, 'cancelled');
});

test('revocation stops a silent durable run within 500 ms and confirms the stop with the bridge', { timeout: 8000 }, async t => {
  const calls = [];
  let stoppedAt = null, status = 'running';
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume body */ }
    calls.push(`${req.method} ${req.url}`);
    const json = value => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (req.url === '/v1/runs' && req.method === 'POST') return res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ run_id: 'silent' }));
    // The agent is silent: an open event stream with nothing on it.
    if (req.url.endsWith('/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.write(': connected\n\n'); }
    if (req.url.endsWith('/stop')) { stoppedAt ??= Date.now(); setTimeout(() => { status = 'cancelled'; }, 300); return json({ status: 'stopping' }); }
    return json({ status });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const revocation = new AbortController();
  const events = [];
  let revokedAt;
  const running = runDurableHermes({
    up: { url: `http://127.0.0.1:${upstream.address().port}`, key: 'fixture-key' }, sessionId: 'session', input: [{ role: 'user', content: 'hello' }],
    controls: () => ({}), onAccepted: () => {}, onEvent: (name, payload) => events.push([name, payload]), checkpoint: () => {}, signal: revocation.signal,
  });
  for (let i = 0; i < 100 && !calls.some(call => call.endsWith('/events')); i++) await new Promise(resolve => setTimeout(resolve, 10));
  setTimeout(() => { revokedAt = Date.now(); revocation.abort(); }, 100);
  const result = await running;
  assert.ok(stoppedAt - revokedAt < 500, `the bridge was told to stop ${stoppedAt - revokedAt} ms after revocation`);
  assert.deepEqual([result.status, result.answer, result.stopConfirmed], ['revoked', '', true], 'the stop is confirmed from the run status');
  assert.ok(calls.lastIndexOf('GET /v1/runs/silent') > calls.indexOf('POST /v1/runs/silent/stop'), 'status was checked after the stop');
  assert.deepEqual(events, [], 'nothing after revocation reaches the chat');
});

test('a stop the bridge never confirms is reported as unconfirmed', { timeout: 8000 }, async t => {
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume body */ }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'running' }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  assert.equal(await stopRunVerified({ url: `http://127.0.0.1:${upstream.address().port}`, key: 'k' }, 'stuck', { timeoutMs: 600, pollMs: 50 }), false);
});

test('a run is never started once access is already revoked', async t => {
  let calls = 0;
  const upstream = http.createServer((_req, res) => { calls++; res.writeHead(500).end(); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const revocation = new AbortController(); revocation.abort();
  await assert.rejects(runDurableHermes({
    up: { url: `http://127.0.0.1:${upstream.address().port}`, key: 'fixture-key' }, sessionId: 'session', input: [{ role: 'user', content: 'hello' }],
    controls: () => ({}), onAccepted: () => assert.fail('must not start'), onEvent: () => {}, checkpoint: () => {}, signal: revocation.signal,
  }));
  assert.equal(calls, 0);
});

// A bridge with run keys, as server/servant_run_keys.py behaves. `start` decides what a start does.
async function keyedBridge(t, start) {
  const keys = new Map(), calls = [];
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume body */ }
    calls.push(`${req.method} ${req.url}`);
    const json = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const keyed = req.url.match(/^\/v1\/runs\/servant-key\.([^/]+)(\/stop)?$/);
    if (keyed) {
      const key = decodeURIComponent(keyed[1]);
      if (keyed[2]) {
        const entry = keys.get(key);
        if (entry?.state === 'running') entry.state = 'ended';
        else if (entry?.state === 'starting') entry.cancel = true; // a start in progress is stopped when it returns
        else keys.set(key, { state: 'refused', run_id: null });
      }
      const entry = keys.get(key);
      return entry ? json(200, { ...entry, stopped: !['running', 'starting'].includes(entry.state) }) : json(404, {});
    }
    if (req.method === 'POST' && req.url === '/v1/runs') return start(req, res, keys, json);
    if (req.url.startsWith('/v1/runs/run_1')) return json(200, { status: 'completed', output: 'Recovered' });
    json(404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { up: { url: `http://127.0.0.1:${server.address().port}`, key: 'fixture' }, keys, calls };
}
const keyedRun = (up, extra = {}) => runDurableHermes({ up, sessionId: 's', input: 'hi', sessionKey: 'k', runKey: 'servant_turn_1', controls: () => ({}),
  onAccepted: () => {}, onEvent: () => {}, checkpoint: () => {}, pollMs: 1, ...extra });

test('a lost start reply with no run behind it: the key is stopped so nothing can start later (audit 3)', { timeout: 30000 }, async t => {
  const bridge = await keyedBridge(t, (req) => req.socket.destroy());
  await assert.rejects(keyedRun(bridge.up), /didn't confirm it started, so nothing was left running/);
  assert.equal(bridge.keys.get('servant_turn_1').state, 'refused');
  assert.ok(bridge.calls.includes('POST /v1/runs/servant-key.servant_turn_1/stop'));
});

test('a lost start reply with a run behind it: Servant adopts that run instead of starting another (audit 3)', { timeout: 30000 }, async t => {
  const checkpoints = [];
  const bridge = await keyedBridge(t, (req, _res, keys) => { keys.set(req.headers['x-servant-run-key'], { state: 'running', run_id: 'run_1' }); req.socket.destroy(); });
  const result = await keyedRun(bridge.up, { checkpoint: id => checkpoints.push(id) });
  assert.deepEqual([result.status, result.answer, checkpoints], ['completed', 'Recovered', ['run_1']]);
  assert.equal(bridge.calls.filter(call => call === 'POST /v1/runs').length, 1);
});

test('revocation during a slow start stops the run by key at once, without waiting for the reply (audit 3)', { timeout: 30000 }, async t => {
  let hold;
  const bridge = await keyedBridge(t, (req, res, keys, json) => {
    keys.set(req.headers['x-servant-run-key'], { state: 'running', run_id: 'run_2' });
    hold = () => json(202, { run_id: 'run_2' });
  });
  const revocation = new AbortController();
  const running = keyedRun(bridge.up, { signal: revocation.signal, onAccepted: () => assert.fail('never accepted') });
  while (!hold) await new Promise(resolve => setTimeout(resolve, 5));
  const started = Date.now();
  revocation.abort();
  const result = await running;
  assert.ok(Date.now() - started < 500, `${Date.now() - started} ms`);
  assert.deepEqual([result.status, result.stopConfirmed], ['revoked', true]);
  assert.equal(bridge.keys.get('servant_turn_1').state, 'ended');
  hold();
});

test('stopRunByKey reports an unconfirmed stop when the bridge never confirms', { timeout: 8000 }, async t => {
  const bridge = await keyedBridge(t, () => {});
  bridge.keys.set('servant_stuck', { state: 'starting', run_id: null });
  assert.equal(await stopRunByKey(bridge.up, 'servant_stuck', { timeoutMs: 300, pollMs: 20 }), false);
});

test('a stop that arrives while the bridge is still starting the run is confirmed once the bridge stops it (review)', { timeout: 30000 }, async t => {
  let finishStart;
  const bridge = await keyedBridge(t, (req, _res, keys, json) => {
    const key = req.headers['x-servant-run-key'];
    keys.set(key, { state: 'starting', run_id: null, cancel: false });
    // Hermes returns the run ID; the bridge sees the stop that came meanwhile and stops it.
    finishStart = () => {
      const entry = keys.get(key);
      keys.set(key, entry.cancel ? { state: 'ended', run_id: 'run_3' } : { state: 'running', run_id: 'run_3' });
      json(entry.cancel ? 409 : 202, entry.cancel ? { error: { code: 'run_key_cancelled' }, run_id: 'run_3' } : { run_id: 'run_3' });
    };
  });
  const revocation = new AbortController();
  const running = keyedRun(bridge.up, { signal: revocation.signal, onAccepted: () => assert.fail('never accepted') });
  while (!finishStart) await new Promise(resolve => setTimeout(resolve, 5));
  revocation.abort();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(bridge.keys.get('servant_turn_1').cancel, true, 'the stop reached the bridge mid-start');
  finishStart();
  const result = await running;
  assert.deepEqual([result.status, result.stopConfirmed], ['revoked', true]);
  assert.equal(bridge.keys.get('servant_turn_1').state, 'ended');
});

test('a cut-off start reply is looked up by key instead of stopping a run that started; a busy agent keeps its reason (review)', { timeout: 30000 }, async t => {
  const checkpoints = [];
  const cut = await keyedBridge(t, (req, res, keys) => {
    keys.set(req.headers['x-servant-run-key'], { state: 'running', run_id: 'run_1' });
    res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"run_id": "ru');
  });
  const result = await keyedRun(cut.up, { checkpoint: id => checkpoints.push(id) });
  assert.deepEqual([result.status, checkpoints], ['completed', ['run_1']]);
  assert.ok(!cut.calls.includes('POST /v1/runs/servant-key.servant_turn_1/stop'), 'the started run was used, not stopped');
  const busy = await keyedBridge(t, (_req, _res, _keys, json) => json(429, { error: { code: 'too_many_runs' } }));
  await assert.rejects(keyedRun(busy.up), /Could not start agent \(429\)/);
});

test("a run the bridge reports as interrupted ends the turn as interrupted instead of polling forever (review)", { timeout: 10000 }, async t => {
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume body */ }
    if (req.url.endsWith('/events')) return res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'interrupted' }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const up = { url: `http://127.0.0.1:${upstream.address().port}`, key: 'k' };
  await assert.rejects(runDurableHermes({ up, runId: 'existing', controls: () => ({}), onAccepted: () => {}, onEvent: () => {}, checkpoint: () => {}, pollMs: 1 }), { code: 'run_lost' });
  assert.equal(await stopRunVerified(up, 'existing', { timeoutMs: 1000, pollMs: 10 }), true, "'interrupted' counts as ended");
});
