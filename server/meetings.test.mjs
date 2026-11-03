import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMessaging } from './messaging.mjs';
import { createMeetings, mergeTranscript, parseNotes, sentTrackCount, transcriptText } from './meetings.mjs';

const users = { ann: { id: 'ann', name: 'Ann', role: 'owner' }, bo: { id: 'bo', name: 'Bo', role: 'member' }, cy: { id: 'cy', name: 'Cy', role: 'member' } };

function setup({ summarize, transcribe } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-meetings-'));
  let meetings;
  const agentTurns = [];
  const messaging = createMessaging({ file: ':memory:', users: () => users, agentName: () => 'Agent', messageExtras: m => meetings?.messageExtras(m),
    askAgent: async ({ text }) => { agentTurns.push(text); return 'On it'; } });
  meetings = createMeetings({ dir, messaging, users: () => users, log: { error() {} },
    summarize: summarize || (async () => JSON.stringify({ title: 'Launch sync', summary: 'Ann and Bo planned the launch', notes: ['Ship Friday'],
      steps: [{ text: 'Draft the launch post', owner: 'Bo', room: 'general' }, { text: 'Book the design review', owner: 'Ann', room: '#design' }, { text: 'Invented room step', room: 'nowhere' }] })),
    transcribe: transcribe || (async file => file.includes('ann') ? [{ fromMs: 0, text: 'Let us ship Friday' }] : [{ fromMs: 2000, text: 'I will draft the post' }]),
    loadWebrtc: async () => { throw new Error('no media in this test'); } });
  const call = async (method, p, body, user = users.ann) => {
    let result;
    const parts = p.split('/').filter(Boolean);
    await meetings.handle({}, {}, { user, method, parts, send: (_r, status, b) => { result = { status, body: b }; }, fail: (_r, status, code) => { result = { status, code }; }, readBody: async () => body })
      .catch(e => { result = { status: e.status || 500, code: e.code, message: e.message }; });
    return result;
  };
  // Stand in for two people who were recorded during the call.
  const recorded = (meetingId) => {
    for (const [pid, uid, offset] of [['part_ann', 'ann', 0], ['part_bo', 'bo', 1000]]) {
      const file = path.join(dir, meetingId, `${pid}.webm`);
      fs.writeFileSync(file, Buffer.alloc(4096));
      meetings.db.prepare('INSERT INTO recordings VALUES (?, ?, ?, ?, ?)').run(meetingId, pid, uid, file, offset);
    }
  };
  const done = async (id) => { for (let i = 0; i < 100 && !['done', 'failed'].includes(meetings.view(id, 'ann').status); i++) await new Promise(r => setTimeout(r, 10)); };
  return { dir, messaging, meetings, call, recorded, done, agentTurns, close: async () => { await meetings.close(); messaging.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('pure helpers: track counting, transcript merge, and notes that never trust invented rooms', () => {
  const sdp = 'v=0\r\nm=audio 9 UDP 111\r\na=sendrecv\r\nm=video 9 UDP 96\r\na=recvonly\r\nm=video 0 UDP 96\r\n';
  assert.equal(sentTrackCount(sdp), 1);
  const lines = mergeTranscript([{ name: 'Ann', offsetMs: 0, segments: [{ fromMs: 0, text: ' Hi' }, { fromMs: 900, text: 'there' }, { fromMs: 5000, text: '[BLANK_AUDIO]' }] },
    { name: 'Bo', offsetMs: 1000, segments: [{ fromMs: 500, text: 'Hello' }] }]);
  assert.equal(transcriptText(lines), '[0:00] Ann: Hi there\n[0:01] Bo: Hello');
  const notes = parseNotes('Sure! {"title":"T","summary":"S","steps":["Do a thing",{"text":"Other","room":"#Design"},{"text":"x","room":"made-up"}]}', [{ id: 'c1', name: 'design' }], 'home');
  assert.deepEqual(notes.steps.map(s => s.roomId), ['home', 'c1', 'home']);
  assert.equal(parseNotes('no json here', [], 'home'), null);
});

test('a hosted meeting posts a live card, then notes with one-tap next steps routed to the right rooms', async () => {
  const t = setup();
  try {
    const general = t.messaging.ensureGeneral();
    for (const u of Object.values(users)) t.messaging.joinDefaults(u.id);
    const design = t.messaging.createChannel(users.ann, { name: 'design', memberIds: ['bo'] });
    const started = await t.call('POST', '/v1/meetings', { conversationId: general.id });
    assert.equal(started.status, 200);
    const id = started.body.meeting.id;
    assert.equal(started.body.meeting.status, 'live');
    // Starting again joins the same call instead of opening a second one.
    assert.equal((await t.call('POST', '/v1/meetings', { conversationId: general.id }, users.bo)).body.meeting.id, id);
    // People outside the room can't see or start it.
    assert.equal((await t.call('POST', '/v1/meetings', { conversationId: design.id }, users.cy)).status, 404);
    assert.equal((await t.call('GET', `/v1/meetings/${id}`, undefined, users.cy)).status, 200 /* general is public and cy joined it */);

    t.recorded(id);
    assert.equal((await t.call('POST', `/v1/meetings/${id}/end`, {})).status, 200);
    await t.done(id);
    const m = t.meetings.view(id, 'ann');
    assert.equal(m.status, 'done', m.error);
    assert.match(m.transcript, /\[0:00\] Ann: Let us ship Friday\n\[0:03\] Bo: I will draft the post/);
    assert.deepEqual(m.steps.map(s => [s.text, s.conversationId]), [
      ['Draft the launch post', general.id], ['Book the design review', design.id], ['Invented room step', general.id]]);

    // The notes post in #general carries its steps; #design gets its own tappable post.
    const rows = t.meetings.db.prepare('SELECT DISTINCT message_seq FROM steps WHERE meeting_id = ?').all(id).map(r => r.message_seq);
    assert.equal(rows.length, 2);

    // Tap "Do it": posted as Ann in a thread under the notes, mentioning the agent, once.
    const accepted = await t.call('POST', `/v1/meetings/${id}/steps/0`, { action: 'accept' });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.meeting.steps[0].status, 'accepted');
    assert.equal(accepted.body.meeting.steps[0].actedBy.name, 'Ann');
    const again = await t.call('POST', `/v1/meetings/${id}/steps/0`, { action: 'accept' }, users.bo);
    assert.equal(again.body.meeting.steps[0].actedBy.name, 'Ann');
    const posted = t.meetings.db.prepare('SELECT acted_seq FROM steps WHERE meeting_id = ? AND n = 0').get(id);
    assert.ok(posted.acted_seq);
    await t.messaging.whenIdle();
    assert.equal(t.agentTurns.filter(x => x.includes('Draft the launch post')).length, 1);
    // Skip; and Cy (not in #design) can't act on the #design step.
    assert.equal((await t.call('POST', `/v1/meetings/${id}/steps/2`, { action: 'skip' })).body.meeting.steps[2].status, 'skipped');
    assert.equal((await t.call('POST', `/v1/meetings/${id}/steps/1`, { action: 'accept' }, users.cy)).status, 404);
  } finally { await t.close(); }
});

test('the agent message carries the meeting so the app can show Join and the step buttons', async () => {
  const t = setup();
  try {
    const general = t.messaging.ensureGeneral();
    t.messaging.joinDefaults('ann');
    const started = await t.call('POST', '/v1/meetings', { conversationId: general.id });
    const id = started.body.meeting.id;
    let result;
    await t.messaging.handle({}, {}, { user: users.ann, method: 'GET', parts: ['v1', 'conversations', general.id, 'messages'], url: new URL(`/v1/conversations/${general.id}/messages`, 'http://t'),
      send: (_r, status, body) => { result = body; }, fail: () => {} });
    const cardMsg = result.messages.find(x => x.meeting);
    assert.equal(cardMsg.meeting.id, id);
    assert.equal(cardMsg.meeting.kind, 'call');
  } finally { await t.close(); }
});

test('failed notes leave the meeting marked failed with a readable reason, never a crash', async () => {
  const t = setup({ summarize: async () => 'not json' });
  try {
    const general = t.messaging.ensureGeneral();
    t.messaging.joinDefaults('ann');
    const id = (await t.call('POST', '/v1/meetings', { conversationId: general.id })).body.meeting.id;
    t.recorded(id);
    await t.call('POST', `/v1/meetings/${id}/end`, {});
    await t.done(id);
    const m = t.meetings.view(id, 'ann');
    assert.equal(m.status, 'failed');
    assert.match(m.error, /unreadable/);
  } finally { await t.close(); }
});

test('a restart finishes meetings an earlier process left behind', async () => {
  const t = setup();
  try {
    const general = t.messaging.ensureGeneral();
    t.messaging.joinDefaults('ann');
    const id = (await t.call('POST', '/v1/meetings', { conversationId: general.id })).body.meeting.id;
    t.recorded(id);
    // Simulate a crash: the call vanishes from memory and the row looks orphaned.
    clearInterval(t.meetings.calls.get(id).timer);
    t.meetings.calls.delete(id);
    t.meetings.db.prepare('UPDATE meetings SET owner_pid = 999999 WHERE id = ?').run(id);
    t.meetings.recover();
    await t.done(id);
    assert.equal(t.meetings.view(id, 'ann').status, 'done');
  } finally { await t.close(); }
});
