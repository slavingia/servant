import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readHermesEvents, runDurableHermes, supportsDurableRuns } from './hermes-runs.mjs';

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

test('a steer the agent took is recorded with its text; a record that fails is tried again, and the agent is never sent it twice', async t => {
  const steers = [];
  let polls = 0;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    const json = (status, value) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (req.url.endsWith('/events')) return json(404, {});
    if (req.url.endsWith('/approval')) { steers.push(JSON.parse(Buffer.concat(chunks))); return json(200, { ok: true }); }
    // Runs long enough for a second pass, then finishes having read the steer.
    return json(200, ++polls < 4 ? { status: 'running' } : { status: 'completed', output: 'Done' });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const recorded = [];
  let failures = 1;
  const result = await runDurableHermes({
    up: { url: `http://127.0.0.1:${upstream.address().port}`, key: 'fixture-key' }, runId: 'existing', canSteer: true, pollMs: 1,
    // The message stays "waiting" in the journal until it is recorded, so it is offered on every pass.
    controls: () => ({ stop: false, steers: recorded.length ? [] : [{ id: 'turn_wait', text: '  Use the blue one ' }] }),
    steered: (id, text) => { if (failures-- > 0) throw new Error('database is locked'); recorded.push([id, text]); },
    onAccepted: () => assert.fail('must never resubmit an existing run'), onEvent: () => {}, checkpoint: () => assert.fail('must retain existing run'),
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(steers, [{ steer: 'Use the blue one', steer_id: 'turn_wait' }], 'sent to the agent once');
  assert.deepEqual(recorded, [['turn_wait', 'Use the blue one']], 'written down on the second pass, with the text the agent got');
  assert.deepEqual(result.unreadSteers, []);
});
