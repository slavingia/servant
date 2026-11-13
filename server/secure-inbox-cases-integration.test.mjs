import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStateStore } from './state-store.mjs';
import { testFetch } from './encrypted-test-client.mjs';

for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === 'API_SERVER_KEY') delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-cases-api-'));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_WORKER_MODE = 'external';
process.env.SERVANT_PUSH_CONFIG = path.join(directory, 'push.json');
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, '{}');
const config = {
  host: '127.0.0.1', port: 0, name: 'Example team', publicUrl: '', discoveryUrl: '', adminKey: '', upstreams: {},
  recordsPreservation: { enabled: true }, sessionMaxHours: 12,
  emailVerification: { enabled: true, domains: ['example.gov'], mailer: { command: 'true' } },
};
const tokens = { owner: crypto.randomBytes(32).toString('base64url'), member: crypto.randomBytes(32).toString('base64url') };
let server, base, mod, state;
before(async () => {
  state = createStateStore({ directory });
  state.mutate(s => {
    for (const [id, token] of Object.entries(tokens)) {
      s.users[id] = { id, name: id === 'owner' ? 'Pat Tester' : 'Jo Park', role: id, email: `${id}@example.gov`, emailVerifiedAt: Date.now() };
      s.devices[crypto.createHash('sha256').update(token).digest('hex')] = { id: `${id}-device`, userId: id, createdAt: Date.now(), sessionVerifiedAt: Date.now(), legacyPlaintextUntil: Date.now() + 60_000 };
    }
  });
  mod = await import('./server.mjs');
  server = await mod.startServer(config);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await server?.shutdown(); state?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
const request = extra => ({ requestId: crypto.randomUUID(), ...extra });
const publicInput = () => request({ name: 'Ana Ruiz', email: 'ana@example.gov', subject: 'Private question', text: 'Hello team' });
const attachment = { name: 'private.txt', data: Buffer.from('Internal document').toString('base64') };
async function api(method, route, body, token = tokens.owner, headers = {}) {
  const response = await testFetch(directory, base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function start() {
  const input = publicInput();
  const created = await api('POST', '/v1/inbox/guest/start', input, null);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { input, ...created.body };
}
const guest = token => api('GET', '/v1/inbox/guest/conversation', undefined, token).then(r => r.body);

test('encrypted case work is visible only to staff and leaves the entire guest view and start replay unchanged', async () => {
  // The public address is set first: with it and a mailer the visitor's view also says a reply email is on offer,
  // and that must not change under case work either.
  config.publicUrl = base;
  const a = await start(), id = a.conversation.id;
  const original = await guest(a.token);
  assert.deepEqual(original.notify, { available: true, state: 'pending', email: 'ana@example.gov' });
  const replay = (await api('POST', '/v1/inbox/guest/start', a.input, null)).body;
  const detail = await api('GET', `/v1/inbox/${id}/case`);
  assert.equal(detail.status, 200);
  assert.match(detail.body.reference, /^CASE-\d{6}$/);
  assert.equal(detail.body.conversation.id, id);
  const note = await api('POST', `/v1/inbox/${id}/notes`, request({ text: 'Internal discussion', attachments: [attachment] }));
  assert.equal(note.status, 201, JSON.stringify(note.body));
  const fileId = note.body.note.attachments[0].id;
  assert.equal((await api('GET', `/v1/inbox/${id}/notes/files/${fileId}`, undefined, tokens.member)).body.file.data, attachment.data);
  assert.equal((await api('GET', `/v1/inbox/guest/files/${fileId}`, undefined, a.token)).status, 404);
  assert.equal((await api('GET', `/v1/inbox/${id}/files/${fileId}`)).status, 404);
  const task = await api('POST', `/v1/inbox/${id}/tasks`, request({ text: 'Review evidence', assigneeId: 'member', dueDate: '2000-01-01' }));
  assert.equal(task.status, 201, JSON.stringify(task.body));
  const taskId = task.body.task.id;
  assert.equal((await api('PATCH', `/v1/inbox/${id}/tasks/${taskId}`, request({ status: 'done', dueDate: '2000-01-02' }))).status, 200);
  assert.equal((await api('PATCH', `/v1/inbox/${id}/tasks/${taskId}`, request({ status: 'open' }))).status, 200);
  assert.equal((await api('PATCH', `/v1/inbox/${id}`, { assigneeId: 'member' })).status, 200);
  assert.equal((await api('POST', `/v1/inbox/${id}/visitor-link`, {})).status, 200);
  assert.deepEqual(await guest(a.token), original);
  assert.deepEqual((await api('POST', '/v1/inbox/guest/start', a.input, null)).body, replay);
  assert.equal((await api('GET', `/v1/inbox/${id}/case`)).body.nextAction.id, taskId);
  assert.equal((await api('GET', `/v1/inbox/${id}/notes`)).body.notes[0].text, 'Internal discussion');
  assert.deepEqual((await api('GET', `/v1/inbox/${id}/activity`)).body.activity.map(a => a.kind), ['case.created', 'note.added', 'task.created', 'task.completed', 'task.reopened', 'case.assigned', 'case.link-created']);
  const routes = [
    ['GET', `/v1/inbox/${id}/case`], ['GET', `/v1/inbox/${id}/notes`], ['GET', `/v1/inbox/${id}/activity`], ['GET', `/v1/inbox/${id}/notes/files/${fileId}`],
    ['POST', `/v1/inbox/${id}/notes`, request({ text: 'Forbidden' })], ['POST', `/v1/inbox/${id}/tasks`, request({ text: 'Forbidden' })],
    ['PATCH', `/v1/inbox/${id}/tasks/${taskId}`, request({ status: 'done' })], ['POST', `/v1/inbox/${id}/visitor-link`, {}],
    ['POST', '/v1/inbox', request({ name: 'Visitor', subject: 'No staff access' })],
  ];
  for (const [method, route, body] of routes) {
    assert.equal((await api(method, route, body, a.token)).status, 401, route);
    const plaintext = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens.owner}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(plaintext.status, 426, route);
    await plaintext.text();
  }
  assert.equal((await api('GET', '/v1/inbox/guest/notes', undefined, a.token)).status, 404);
  assert.equal((await api('GET', '/v1/inbox/guest/case', undefined, a.token)).status, 404);
});

test('case scopes, reference search, private file boundaries and task validation work through the actual router', async () => {
  const a = await start(), b = await start(), id = a.conversation.id;
  const reference = (await api('GET', `/v1/inbox/${id}/case`)).body.reference;
  const task = (await api('POST', `/v1/inbox/${id}/tasks`, request({ text: 'Follow up', assigneeId: 'member', dueDate: '2000-01-01' }))).body.task;
  const note = (await api('POST', `/v1/inbox/${id}/notes`, request({ text: 'A private file', attachments: [attachment] }))).body.note;
  assert.equal((await api('GET', `/v1/inbox?scope=mine&q=${reference}`, undefined, tokens.member)).body.conversations[0].id, id);
  assert.equal((await api('GET', `/v1/inbox?scope=due&q=${reference}`)).body.conversations[0].id, id);
  assert.equal((await api('GET', `/v1/inbox?scope=unassigned&q=${reference}`)).body.conversations[0].id, id);
  assert.equal((await api('GET', `/v1/inbox/${b.conversation.id}/notes/files/${note.attachments[0].id}`)).status, 404);
  assert.equal((await api('PATCH', `/v1/inbox/${b.conversation.id}/tasks/${task.id}`, request({ status: 'done' }))).status, 404);
  assert.equal((await api('GET', `/v1/inbox/${id}/notes?after=-1`)).status, 400);
  assert.equal((await api('GET', `/v1/inbox/${id}/activity?after=invalid`)).status, 400);
  assert.equal((await api('GET', '/v1/inbox?scope=invalid')).status, 400);
  assert.equal((await api('POST', `/v1/inbox/${id}/tasks`, request({ text: 'Bad date', dueDate: '2026-02-30' }))).status, 400);
  assert.equal((await api('PATCH', `/v1/inbox/${id}/tasks/${task.id}`, request({ text: 'Overwrite' }))).status, 400);
  assert.equal((await api('DELETE', `/v1/inbox/${id}/notes/${note.id}`)).status, 404);
  assert.equal((await api('DELETE', `/v1/inbox/${id}/tasks/${task.id}`)).status, 404);
});

test('staff can start an empty case, add private work, and explicitly share a stable link scoped to its public conversation', async () => {
  const initial = request({ name: 'Ana Ruiz', email: 'ana@example.gov', subject: 'Existing case' });
  const created = await api('POST', '/v1/inbox', initial);
  assert.equal(created.status, 201);
  const id = created.body.conversation.id;
  assert.equal(created.body.conversation.assigneeId, 'owner');
  assert.equal(created.body.conversation.lastMessage, null);
  assert.equal((await api('POST', '/v1/inbox', initial)).body.conversation.id, id);
  await api('POST', `/v1/inbox/${id}/notes`, request({ text: 'Previous private discussion', attachments: [attachment] }));
  await api('POST', `/v1/inbox/${id}/tasks`, request({ text: 'Private follow-up' }));
  config.publicUrl = 'https://relay.example.gov/hubs/example-app';
  assert.deepEqual((await api('POST', `/v1/inbox/${id}/visitor-link`, {})).body, { url: null });
  const db = new DatabaseSync(path.join(directory, 'inbox.db'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM inbox_guest_links WHERE conversation_id=?').get(id).n, 0);
  db.close();
  config.publicUrl = base;
  const link = (await api('POST', `/v1/inbox/${id}/visitor-link`, {})).body.url;
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get('resume');
  const entered = await guest(token);
  assert.equal(entered.conversation.id, id);
  assert.deepEqual(entered.messages, []);
  assert.equal('reference' in entered.conversation, false);
  assert.equal('tasks' in entered, false);
  assert.equal((await api('POST', `/v1/inbox/${id}/visitor-link`, {}, tokens.member)).body.url, link);
  assert.equal((await api('POST', '/v1/inbox/guest/messages', request({ text: 'I have joined' }), token)).status, 201);
  assert.equal((await api('POST', `/v1/inbox/${id}/messages`, request({ text: 'Welcome' }))).status, 201);
  assert.deepEqual((await guest(token)).messages.map(m => m.text), ['I have joined', 'Welcome']);
  assert.equal((await api('GET', '/v1/me', undefined, token)).status, 401);
});

test('records preservation refuses case mutations atomically when audit append fails', async () => {
  const a = await start(), id = a.conversation.id;
  const task = (await api('POST', `/v1/inbox/${id}/tasks`, request({ text: 'Original task', assigneeId: 'owner', dueDate: '2000-01-01' }))).body.task;
  const before = (await api('GET', `/v1/inbox/${id}/case`)).body;
  const db = new DatabaseSync(path.join(directory, 'inbox.db'));
  db.exec("CREATE TRIGGER refuse_case_api_audit BEFORE INSERT ON inbox_activity BEGIN SELECT RAISE(ABORT,'Audit unavailable'); END");
  const patch = request({ status: 'done', dueDate: null, assigneeId: 'member' });
  try {
    assert.equal((await api('PATCH', `/v1/inbox/${id}/tasks/${task.id}`, patch)).status, 500);
    assert.equal((await api('POST', `/v1/inbox/${id}/notes`, request({ text: 'Must not save', attachments: [attachment] }))).status, 500);
    assert.equal((await api('PATCH', `/v1/inbox/${id}`, { status: 'resolved' })).status, 500);
    assert.equal((await api('POST', '/v1/inbox', request({ name: 'Ana Ruiz', subject: 'Must not create' }))).status, 500);
    assert.deepEqual((await api('GET', `/v1/inbox/${id}/case`)).body, before);
    assert.deepEqual((await api('GET', `/v1/inbox/${id}/notes`)).body.notes, []);
  } finally { db.exec('DROP TRIGGER refuse_case_api_audit'); db.close(); }
  assert.equal((await api('PATCH', `/v1/inbox/${id}/tasks/${task.id}`, patch)).body.task.status, 'done');
});

test('expired and revoked staff and a disabled feature cannot access any case workspace API', async () => {
  const a = await start(), id = a.conversation.id;
  const task = (await api('POST', `/v1/inbox/${id}/tasks`, request({ text: 'Task' }))).body.task;
  const routes = [
    ['GET', `/v1/inbox/${id}/case`], ['GET', `/v1/inbox/${id}/notes`], ['GET', `/v1/inbox/${id}/activity`],
    ['POST', `/v1/inbox/${id}/notes`, request({ text: 'No' })], ['POST', `/v1/inbox/${id}/tasks`, request({ text: 'No' })],
    ['PATCH', `/v1/inbox/${id}/tasks/${task.id}`, request({ status: 'done' })], ['POST', `/v1/inbox/${id}/visitor-link`, {}],
    ['POST', '/v1/inbox', request({ name: 'Ana Ruiz', subject: 'No' })],
  ];
  const key = crypto.createHash('sha256').update(tokens.member).digest('hex');
  state.mutate(s => { s.devices[key].sessionVerifiedAt = Date.now() - 13 * 60 * 60 * 1000; });
  for (const [method, route, body] of routes) {
    const response = await api(method, route, body, tokens.member, { 'X-Servant-Reverify': '1' });
    assert.equal(response.status, 401, route);
    assert.equal(response.body.error.code, 'session_expired');
  }
  state.mutate(s => { s.devices[key].sessionVerifiedAt = Date.now(); s.devices[key].revokedAt = Date.now(); });
  assert.equal((await api('GET', `/v1/inbox/${id}/case`, undefined, tokens.member)).status, 401);
  state.mutate(s => { delete s.devices[key].revokedAt; });
  config.features = { secureInbox: false };
  for (const [method, route, body] of routes) {
    const response = await api(method, route, body);
    assert.equal(response.status, 404, route);
    assert.equal(response.body.error.code, 'feature_off');
  }
  config.features = {};
  assert.equal((await api('GET', `/v1/inbox/${id}/case`)).body.tasks[0].text, 'Task');
});

test('case references, notes, task receipts and visitor links survive an actual server restart', async () => {
  const a = await start(), id = a.conversation.id;
  const noteInput = request({ text: 'Keep this internal note', attachments: [attachment] });
  const taskInput = request({ text: 'A durable task', dueDate: '2000-01-01' });
  const note = (await api('POST', `/v1/inbox/${id}/notes`, noteInput)).body.note;
  const task = (await api('POST', `/v1/inbox/${id}/tasks`, taskInput)).body.task;
  const ref = (await api('GET', `/v1/inbox/${id}/case`)).body.reference;
  config.publicUrl = 'https://chat.example.gov';
  const link = (await api('POST', `/v1/inbox/${id}/visitor-link`, {})).body.url;
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get('resume');
  await server.shutdown();
  server = await mod.startServer(config);
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await api('GET', `/v1/inbox/${id}/case`)).body.reference, ref);
  assert.equal((await api('POST', `/v1/inbox/${id}/notes`, noteInput)).body.note.id, note.id);
  assert.deepEqual((await api('POST', `/v1/inbox/${id}/tasks`, taskInput)).body.task, task);
  assert.equal((await api('GET', `/v1/inbox/${id}/notes/files/${note.attachments[0].id}`)).body.file.data, attachment.data);
  assert.equal((await api('POST', `/v1/inbox/${id}/visitor-link`, {})).body.url, link);
  assert.deepEqual(await guest(token), await guest(a.token));
});
