import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMessaging } from './messaging.mjs';
import { createMeetings } from './meetings.mjs';
import { createRecordings } from './recordings.mjs';
import { mergeMeetingList } from './meeting-list.mjs';

const users = { ann: { id: 'ann', name: 'Ann', role: 'owner' }, bo: { id: 'bo', name: 'Bo', role: 'member' }, cy: { id: 'cy', name: 'Cy', role: 'member' } };
const notes = JSON.stringify({ title: 'Launch sync', summary: 'Ann and Bo planned the launch', notes: ['Ship Friday', 'Bo writes the post'],
  steps: [{ text: 'Draft the launch post', owner: 'Bo', room: 'general' }, { text: 'Book the design review', owner: 'Ann' }] });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-meeting-list-'));
  let meetings;
  const messaging = createMessaging({ file: ':memory:', users: () => users, agentName: () => 'Agent', messageExtras: m => meetings?.messageExtras(m), askAgent: async () => 'On it' });
  let clock = 1_700_000_000_000;
  const now = () => clock;
  meetings = createMeetings({ dir: path.join(dir, 'meetings'), messaging, users: () => users, log: { error() {} }, now,
    summarize: async () => notes, transcribe: async () => [{ fromMs: 0, text: 'Let us ship Friday' }],
    loadWebrtc: async () => { throw new Error('no media in this test'); } });
  const recordings = createRecordings({ dir: path.join(dir, 'recordings'), users: () => users, log: { error() {} }, now,
    summarize: async () => notes, transcribe: async () => [{ fromMs: 0, text: 'Remember to book the review' }], startWork: async () => ({ id: 'cht_1' }) });
  // The route as server.mjs wires it: calls from meetings.mjs, plus the person's own recordings.
  const get = async (user) => {
    let result;
    await meetings.handle({}, {}, { user, method: 'GET', parts: ['v1', 'meetings'], send: (_r, status, body) => { result = { status, body }; }, fail: (_r, status, code) => { result = { status, code }; },
      readBody: async () => ({}), otherMeetings: u => recordings.list(u) });
    return result;
  };
  const recorded = (meetingId, who = ['ann', 'bo']) => {
    for (const uid of who) {
      const file = path.join(dir, 'meetings', meetingId, `part_${uid}.webm`);
      fs.writeFileSync(file, Buffer.alloc(4096));
      meetings.db.prepare('INSERT INTO recordings VALUES (?, ?, ?, ?, ?)').run(meetingId, `part_${uid}`, uid, file, 0);
    }
  };
  const settled = async (check) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 10)); };
  return { dir, messaging, meetings, recordings, get, recorded, settled, tick: ms => { clock += ms; },
    close: async ({ meetingsClosed = false } = {}) => { if (!meetingsClosed) await meetings.close(); await recordings.close(); messaging.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('merge: live calls first, then newest first, from both sources', () => {
  const merged = mergeMeetingList(
    [{ kind: 'call', id: 'a', status: 'done', startedAt: 300 }, { kind: 'call', id: 'b', status: 'live', startedAt: 100 }],
    [{ kind: 'recording', id: 'c', status: 'processing', startedAt: 200 }], null);
  assert.deepEqual(merged.map(m => m.id), ['b', 'a', 'c']);
  assert.deepEqual(mergeMeetingList([], []), []);
});

test('the list shows calls in rooms you are in and only your own recordings', async () => {
  const t = setup();
  try {
    const general = t.messaging.ensureGeneral();
    for (const u of Object.values(users)) t.messaging.joinDefaults(u.id);
    const design = t.messaging.createChannel(users.ann, { name: 'design', private: true, memberIds: ['bo'] });
    const open = await t.meetings.start(users.ann, general.id);
    t.tick(1000);
    const secret = await t.meetings.start(users.ann, design.id);
    // Ann records a meeting in the room; it is hers alone.
    const { id: recId } = t.recordings.create(users.ann, { size: 2048, durationMs: 90_000, ext: 'm4a' });
    t.recordings.chunk(users.ann, recId, { offset: 0, data: Buffer.alloc(2048, 1).toString('base64') });
    t.recordings.finish(users.ann, recId);
    await t.settled(() => t.recordings.detail(recId, users.ann).status === 'done');
    // A recording still uploading is not a meeting yet.
    t.recordings.create(users.ann, { size: 10, ext: 'm4a' });

    const ann = (await t.get(users.ann)).body.meetings;
    assert.deepEqual(ann.map(m => [m.kind, m.id, m.status]), [['call', secret.id, 'live'], ['call', open.id, 'live'], ['recording', recId, 'done']]);
    const rec = ann.find(m => m.kind === 'recording');
    assert.equal(rec.title, 'Launch sync');
    assert.equal(rec.summary, 'Ann and Bo planned the launch');
    assert.equal(rec.durationMs, 90_000);
    assert.equal(rec.openSteps, 2);
    assert.deepEqual(rec.people, [{ id: 'ann', name: 'Ann' }]);
    assert.equal(rec.conversationId, null);

    // Bo is in #design: sees both calls, never Ann's recording.
    const bo = (await t.get(users.bo)).body.meetings;
    assert.deepEqual(bo.map(m => m.id), [secret.id, open.id]);
    // Cy is not in #design: the private call never appears, and neither does the recording.
    const cy = (await t.get(users.cy)).body.meetings;
    assert.deepEqual(cy.map(m => m.id), [open.id]);
    assert.ok(cy.every(m => m.kind === 'call'));
    assert.equal(cy[0].conversationId, general.id);
    assert.deepEqual(cy[0].people, [{ id: 'ann', name: 'Ann' }], 'nobody is connected yet, so the person who started it stands in');
  } finally { await t.close(); }
});

test('a finished call carries its length, summary, notes and open steps into the list and the detail', async () => {
  const t = setup();
  try {
    const general = t.messaging.ensureGeneral();
    for (const u of Object.values(users)) t.messaging.joinDefaults(u.id);
    const m = await t.meetings.start(users.ann, general.id);
    t.recorded(m.id);
    t.tick(25 * 60_000);
    await t.meetings.finish(m.id, 'ended');
    await t.settled(() => ['done', 'failed'].includes(t.meetings.view(m.id, 'ann').status));

    const [item] = (await t.get(users.bo)).body.meetings;
    assert.equal(item.status, 'done');
    assert.equal(item.title, 'Launch sync');
    assert.equal(item.durationMs, 25 * 60_000);
    assert.equal(item.summary, 'Ann and Bo planned the launch');
    assert.equal(item.openSteps, 2);
    assert.deepEqual(item.people.map(p => p.name), ['Ann', 'Bo']);
    assert.equal(item.peopleCount, 2);

    // The detail the app opens (GET /v1/meetings/:id) now has the notes too; the old fields are unchanged.
    const view = t.meetings.view(m.id, 'bo');
    assert.equal(view.summary, 'Ann and Bo planned the launch');
    assert.deepEqual(view.notes, ['Ship Friday', 'Bo writes the post']);
    assert.equal(view.durationMs, 25 * 60_000);
    assert.deepEqual(view.people.map(p => p.id), ['ann', 'bo']);
    assert.match(view.transcript, /ship Friday/);
    assert.equal(view.steps.length, 2);
    assert.equal(view.host, false);

    // Acting on a step drops the open count.
    await t.meetings.act(users.bo, m.id, 0, 'skip');
    assert.equal((await t.get(users.bo)).body.meetings[0].openSteps, 1);
  } finally { await t.close(); }
});

test('an older database gets the new columns without losing its meetings', async () => {
  const t = setup();
  let closed = false;
  try {
    const general = t.messaging.ensureGeneral();
    t.messaging.joinDefaults('ann');
    const m = await t.meetings.start(users.ann, general.id);
    await t.meetings.finish(m.id, 'ended');
    // Pretend the columns never existed, then open the database again.
    t.meetings.db.exec('ALTER TABLE meetings DROP COLUMN summary; ALTER TABLE meetings DROP COLUMN notes');
    await t.meetings.close(); closed = true;
    const again = createMeetings({ dir: path.join(t.dir, 'meetings'), messaging: t.messaging, users: () => users, log: { error() {} }, summarize: async () => notes,
      transcribe: async () => [], loadWebrtc: async () => { throw new Error('no media'); } });
    try {
      assert.equal(again.list(users.ann).length, 1);
      assert.equal(again.view(m.id, 'ann').summary, null);
    } finally { await again.close(); }
  } finally { await t.close({ meetingsClosed: closed }); }
});
