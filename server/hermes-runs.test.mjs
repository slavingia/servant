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
