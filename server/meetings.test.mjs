import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMessaging } from './messaging.mjs';
import { createMeetings, mergeTranscript, parseNotes, sentTrackCount, transcriptText } from './meetings.mjs';

const users = { ann: { id: 'ann', name: 'Ann', role: 'owner' }, bo: { id: 'bo', name: 'Bo', role: 'member' }, cy: { id: 'cy', name: 'Cy', role: 'member' } };

const workPeople = {
  pat: { id: 'pat', name: 'Pat Tester', role: 'owner' },
  jo: { id: 'jo', name: 'Jo Park', role: 'member' },
  ana: { id: 'ana', name: 'Ana Ruiz', role: 'member' },
};
function attendanceFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-attendance-'));
  const messaging = createMessaging({ file: ':memory:', users: () => workPeople, agentName: () => 'Agent', askAgent: async () => 'ok' });
  const room = messaging.createChannel(workPeople.pat, { name: 'planning', private: true, memberIds: ['jo', 'ana'] });
  let current = 1_800_000_000_000;
  const signal = () => ({ subscribe() {} });
  class Peer {
    onTransceiverAdded = signal(); connectionStateChange = signal(); iceGatheringState = 'complete';
    async setRemoteDescription({ sdp }) { if (sdp.includes('reject')) throw new Error('bad offer'); }
    async createAnswer() { return { sdp: 'v=0\r\n' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async close() {}
  }
  const build = () => createMeetings({ dir, messaging, users: () => workPeople, now: () => current,
    log: { error() {} }, transcribe: async () => [], summarize: async () => '{}',
    loadWebrtc: async () => ({ RTCPeerConnection: Peer, RTCRtpCodecParameters: class {}, MediaRecorder: class { async stop() {} } }) });
  let meetings = build();
  const request = async (id, sub, user, body) => {
    let response;
    await meetings.handle({}, {}, { user, method: 'POST', parts: ['v1', 'meetings', id, sub], readBody: async () => body,
      send: (_res, status, result) => { response = { status, ...result }; }, fail: (_res, status) => { response = { status }; } });
    return response;
  };
  return { dir, messaging, room, get meetings() { return meetings; }, request, time: value => { current = value; },
    restart: async () => { await meetings.close(); meetings = build(); },
    close: async () => { await meetings.close(); messaging.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const publishingOffer = 'v=0\r\nm=audio 9 UDP 111\r\na=sendonly\r\n';
const receivingOffer = 'v=0\r\nm=audio 9 UDP 111\r\na=recvonly\r\n';

test('automatic call work log counts successful non-screen attendance, including receive-only joins, once', async () => {
  const t = attendanceFixture();
  try {
    const m = await t.meetings.start(workPeople.pat, t.room.id);
    await assert.rejects(t.request(m.id, 'join', workPeople.pat, { sdp: `${publishingOffer}reject` }), e => e.code === 'bad_sdp');
    assert.equal(t.meetings.db.prepare('SELECT COUNT(*) AS n FROM recordings').get().n, 0, 'failed negotiation leaves no recording evidence');
    const joined = await t.request(m.id, 'join', workPeople.jo, { sdp: publishingOffer });
    await t.request(m.id, 'join', workPeople.jo, { sdp: receivingOffer });
    await t.request(m.id, 'join', workPeople.ana, { sdp: receivingOffer });
    await t.request(m.id, 'join', workPeople.jo, { sdp: publishingOffer, screenOf: joined.participantId });
    assert.equal(t.meetings.db.prepare('SELECT COUNT(*) AS n FROM meeting_attendance').get().n, 2, 'rejoins and screens add no extra attendance');
    assert.deepEqual(t.meetings.workLog(workPeople.jo), [], 'live calls are not completed work');
    t.time(m.started_at + 60_000);
    await t.meetings.finish(m.id);
    const [event] = t.meetings.workLog(workPeople.jo);
    assert.equal(event.id, `meeting:call:${m.id}`);
    assert.equal(event.timeBasis, 'meeting');
    assert.equal(event.at, m.started_at + 60_000);
    assert.deepEqual([event.startedAt, event.endedAt, event.durationMs], [m.started_at, event.at, 60_000]);
    assert.deepEqual(Object.keys(event.source).sort(), ['conversationId', 'summary', 'title'], 'no transcript in the work log');
    assert.equal(t.meetings.workLog(workPeople.ana).length, 1, 'a listener attended');
    assert.deepEqual(t.meetings.workLog(workPeople.pat), [], 'starting the call or failing to join does not count');
    t.messaging.db.prepare('DELETE FROM members WHERE conversation_id = ? AND user_id = ?').run(t.room.id, 'jo');
    assert.deepEqual(t.meetings.workLog(workPeople.jo), [{ ...event, source: null }], 'lost access keeps only private attendance metadata');
    t.meetings.db.prepare('UPDATE meetings SET started_at = 1, ended_at = 2 WHERE id = ?').run(m.id);
    assert.deepEqual(t.meetings.workLog(workPeople.ana).map(({ startedAt, endedAt, durationMs }) => ({ startedAt, endedAt, durationMs })),
      [{ startedAt: m.started_at, endedAt: event.at, durationMs: 60_000 }], 'event times do not change with source metadata');
    for (const table of ['meeting_attendance', 'meeting_work_log']) {
      assert.throws(() => t.meetings.db.exec(`UPDATE ${table} SET user_id = 'pat'`), /immutable/);
      assert.throws(() => t.meetings.db.exec(`DELETE FROM ${table}`), /immutable/);
    }
  } finally { await t.close(); }
});

test('call attendance and end times survive a restart without recording audio', async () => {
  const t = attendanceFixture();
  try {
    const m = await t.meetings.start(workPeople.pat, t.room.id);
    await t.request(m.id, 'join', workPeople.ana, { sdp: receivingOffer });
    t.time(m.started_at + 42_000);
    await t.restart();
    const events = t.meetings.workLog(workPeople.ana);
    assert.equal(events.length, 1);
    assert.equal(events[0].endedAt, m.started_at + 42_000);
    t.time(m.started_at + 99_000);
    await t.restart();
    assert.deepEqual(t.meetings.workLog(workPeople.ana), events);
  } finally { await t.close(); }
});

test('legacy call work log backfills only actual recording evidence and has no recent-list cap', async () => {
  const t = attendanceFixture();
  try {
    const file = path.join(t.dir, 'legacy.webm');
    fs.writeFileSync(file, Buffer.alloc(2048));
    const insert = t.meetings.db.prepare("INSERT INTO meetings (id, conversation_id, started_by, started_at, ended_at, status) VALUES (?, ?, 'pat', ?, ?, 'done')");
    const record = t.meetings.db.prepare('INSERT INTO recordings VALUES (?, ?, ?, ?, 0)');
    for (let n = 0; n < 505; n++) {
      const id = `legacy_${n}`;
      insert.run(id, t.room.id, 1000 + n, 2000 + n);
      record.run(id, `part_${n}`, 'jo', file);
      record.run(id, `part_failed_${n}`, 'ana', path.join(t.dir, 'missing.webm'));
    }
    await t.restart();
    assert.equal(t.meetings.workLog(workPeople.jo).length, 505);
    assert.deepEqual(t.meetings.workLog(workPeople.pat), [], 'a host who never joined is not inferred');
    assert.deepEqual(t.meetings.workLog(workPeople.ana), [], 'a recording row without audio is not confirmed attendance');
    fs.unlinkSync(file);
    const events = t.meetings.workLog(workPeople.jo);
    await t.restart();
    assert.deepEqual(t.meetings.workLog(workPeople.jo), events, 'migrated metadata survives later audio cleanup');
  } finally { await t.close(); }
});

function setup({ summarize, transcribe, research, config } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-meetings-'));
  let meetings;
  const agentTurns = [];
  const messaging = createMessaging({ file: ':memory:', users: () => users, agentName: () => 'Agent', messageExtras: m => meetings?.messageExtras(m),
    askAgent: async ({ text }) => { agentTurns.push(text); return 'On it'; } });
  meetings = createMeetings({ dir, messaging, users: () => users, log: { error() {} }, research, config: () => config || {},
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
    const design = t.messaging.createChannel(users.ann, { name: 'design', private: true, memberIds: ['bo'] }); // public channels include everyone
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

// `keepRecordings` was documented in the config contract but its branch was empty, so an operator who set it to
// false still kept every participant's audio for every meeting forever.
for (const [label, config, kept] of [['default (not set)', {}, true], ['true', { keepRecordings: true }, true], ['false', { keepRecordings: false }, false]]) {
  test(`keepRecordings ${label}: the recordings ${kept ? 'stay' : 'are deleted once the notes are saved, and the notes stay'}`, async () => {
    const t = setup({ config });
    try {
      const general = t.messaging.ensureGeneral();
      for (const u of Object.values(users)) t.messaging.joinDefaults(u.id);
      const id = (await t.call('POST', '/v1/meetings', { conversationId: general.id })).body.meeting.id;
      t.recorded(id);
      const live = path.join(t.dir, id, 'part_ann.live.webm');
      fs.writeFileSync(live, Buffer.alloc(2048));
      const files = t.meetings.db.prepare('SELECT file FROM recordings WHERE meeting_id = ?').all(id).map(r => r.file);
      assert.equal(files.length, 2);
      await t.call('POST', `/v1/meetings/${id}/end`, {});
      await t.done(id);
      const view = t.meetings.view(id, 'ann');
      assert.equal(view.status, 'done');
      assert.ok(view.summary, 'the notes are kept either way');
      for (const f of [...files, live]) assert.equal(fs.existsSync(f), kept, `${path.basename(f)} ${kept ? 'stays' : 'is gone'}`);
    } finally { await t.close(); }
  });
}

test('with records preservation on, keepRecordings false does not delete the audio', async () => {
  const t = setup({ config: { keepRecordings: false, recordsPreservation: true } });
  try {
    const general = t.messaging.ensureGeneral();
    for (const u of Object.values(users)) t.messaging.joinDefaults(u.id);
    const id = (await t.call('POST', '/v1/meetings', { conversationId: general.id })).body.meeting.id;
    t.recorded(id);
    const files = t.meetings.db.prepare('SELECT file FROM recordings WHERE meeting_id = ?').all(id).map(r => r.file);
    await t.call('POST', `/v1/meetings/${id}/end`, {});
    await t.done(id);
    assert.equal(t.meetings.view(id, 'ann').status, 'done');
    for (const f of files) assert.equal(fs.existsSync(f), true, 'the preservation switch wins over the storage-saving one');
  } finally { await t.close(); }
});

test('keepRecordings false keeps the audio when the notes failed, so they can be retried', async () => {
  const t = setup({ config: { keepRecordings: false }, summarize: async () => { throw new Error('model down'); } });
  try {
    const general = t.messaging.ensureGeneral();
    for (const u of Object.values(users)) t.messaging.joinDefaults(u.id);
    const id = (await t.call('POST', '/v1/meetings', { conversationId: general.id })).body.meeting.id;
    t.recorded(id);
    const files = t.meetings.db.prepare('SELECT file FROM recordings WHERE meeting_id = ?').all(id).map(r => r.file);
    await t.call('POST', `/v1/meetings/${id}/end`, {});
    await t.done(id);
    assert.equal(t.meetings.view(id, 'ann').status, 'failed');
    for (const f of files) assert.equal(fs.existsSync(f), true, 'nothing is deleted until the notes are saved');
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

// ---- screen sharing, over real WebRTC connections (the vendored werift stack as the client) ----
async function realMeetings() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-screen-'));
  const messaging = createMessaging({ file: ':memory:', users: () => users, agentName: () => 'Agent', askAgent: async () => 'ok' });
  const meetings = createMeetings({ dir, messaging, users: () => users, log: { error() {} }, summarize: async () => '{}', transcribe: async () => [] });
  const w = await import('./werift.mjs');
  const call = async (method, p, body, user = users.ann) => {
    let result;
    await meetings.handle({}, {}, { user, method, parts: p.split('/').filter(Boolean), send: (_r, status, b) => { result = { status, body: b }; }, fail: (_r, status, code) => { result = { status, code }; }, readBody: async () => body })
      .catch(e => { result = { status: e.status || 500, code: e.code, message: e.message }; });
    return result;
  };
  const clients = [];
  const peer = () => { const pc = new w.RTCPeerConnection({ iceServers: [] }); clients.push(pc); return pc; };
  const offer = async (pc) => { await pc.setLocalDescription(await pc.createOffer()); await new Promise(r => { if (pc.iceGatheringState === 'complete') return r(); const t = setTimeout(r, 2000); pc.iceGatheringStateChange.subscribe(s => { if (s === 'complete') { clearTimeout(t); r(); } }); }); return pc.localDescription.sdp; };
  return { w, messaging, meetings, call, peer, offer, close: async () => { for (const c of clients) await c.close().catch(() => {}); await meetings.close(); messaging.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('screen sharing: a second video-only connection from someone in the call, watched like a camera, gone when they leave', async () => {
  const t = await realMeetings();
  try {
    const general = t.messaging.ensureGeneral();
    for (const u of Object.values(users)) t.messaging.joinDefaults(u.id);
    const id = (await t.call('POST', '/v1/meetings', { conversationId: general.id })).body.meeting.id;

    // Ann joins with a microphone and camera.
    const annPc = t.peer();
    annPc.addTransceiver('audio', { direction: 'sendonly' });
    annPc.addTransceiver('video', { direction: 'sendonly' });
    const joined = await t.call('POST', `/v1/meetings/${id}/join`, { sdp: await t.offer(annPc) });
    assert.equal(joined.status, 200, JSON.stringify(joined));
    await annPc.setRemoteDescription({ type: 'answer', sdp: joined.body.sdp });
    const annId = joined.body.participantId;

    // She shares her screen: video only, tied to her own place in the call.
    const screenPc = t.peer();
    screenPc.addTransceiver('video', { direction: 'sendonly' });
    const screenSdp = await t.offer(screenPc);
    assert.equal((await t.call('POST', `/v1/meetings/${id}/join`, { sdp: screenSdp, screenOf: 'part_nobody' })).status, 409, 'needs a real place in the call');
    assert.equal((await t.call('POST', `/v1/meetings/${id}/join`, { sdp: screenSdp, screenOf: annId }, users.bo)).status, 409, "can't share on someone else's behalf");
    const shared = await t.call('POST', `/v1/meetings/${id}/join`, { sdp: screenSdp, screenOf: annId });
    assert.equal(shared.status, 200, JSON.stringify(shared));
    await screenPc.setRemoteDescription({ type: 'answer', sdp: shared.body.sdp });
    const second = await t.call('POST', `/v1/meetings/${id}/join`, { sdp: await t.offer((() => { const p = t.peer(); p.addTransceiver('video', { direction: 'sendonly' }); return p; })()), screenOf: annId });
    assert.equal(second.status, 409);
    assert.equal(second.code, 'already_sharing', 'one screen at a time per person');

    // The call lists it as a screen, separate from her camera, and it doesn't take a place.
    const view = t.meetings.view(id, 'bo');
    const screens = view.participants.filter(p => p.screen);
    assert.equal(screens.length, 1);
    assert.equal(screens[0].user.name, 'Ann');
    assert.equal(view.participants.filter(p => !p.screen).length, 1);
    assert.equal(screens[0].hasAudio, false);
    // Never recorded: the transcript only ever hears people.
    assert.equal(t.meetings.db.prepare('SELECT COUNT(*) AS n FROM recordings WHERE meeting_id = ?').get(id).n, 1);

    // Bo watches it like any camera: a video slot, and no audio slot even if he asks for one.
    const boJoin = t.peer(); boJoin.addTransceiver('audio', { direction: 'recvonly' });
    const bo = await t.call('POST', `/v1/meetings/${id}/join`, { sdp: await t.offer(boJoin) }, users.bo);
    const watchPc = t.peer();
    watchPc.addTransceiver('audio', { direction: 'recvonly' });
    watchPc.addTransceiver('video', { direction: 'recvonly' });
    const watch = await t.call('POST', `/v1/meetings/${id}/watch`, { participantId: bo.body.participantId, publisherId: screens[0].id, sdp: await t.offer(watchPc) }, users.bo);
    assert.equal(watch.status, 200, JSON.stringify(watch));
    const sections = watch.body.sdp.split(/\r?\nm=/).slice(1);
    assert.match(sections.find(s => s.startsWith('video')), /a=sendonly/, 'the screen comes to him');
    assert.match(sections.find(s => s.startsWith('audio')), /a=inactive|^audio 0 /m, 'no audio comes with a screen');

    // Stopping the share leaves Ann in the call; leaving the call takes any share with her.
    const stop = await t.call('POST', `/v1/meetings/${id}/leave`, { participantId: screens[0].id });
    assert.equal(stop.status, 200);
    assert.equal(t.meetings.view(id, 'bo').participants.filter(p => p.screen).length, 0);
    assert.equal(t.meetings.view(id, 'bo').participants.filter(p => p.user.name === 'Ann' && !p.screen).length, 1, 'still in the call');
    const again = t.peer(); again.addTransceiver('video', { direction: 'sendonly' });
    const reshared = await t.call('POST', `/v1/meetings/${id}/join`, { sdp: await t.offer(again), screenOf: annId });
    assert.equal(reshared.status, 200, 'can share again');
    await t.call('POST', `/v1/meetings/${id}/leave`, { participantId: annId });
    assert.equal(t.meetings.view(id, 'bo').participants.filter(p => p.screen).length, 0, 'leaving the call stops the share');
    await t.meetings.finish(id);
    assert.equal(t.meetings.workLog(users.ann).length, 1, 'camera and screen joins produce one attendance event');
    assert.equal(t.meetings.workLog(users.bo).length, 1, 'a real receive-only WebRTC join counts');
    assert.equal(t.meetings.workLog(users.cy).length, 0, 'room membership alone does not count');
  } finally { await t.close(); }
});

test('mute and camera-off show for everyone; only you can set yours', async () => {
  const t = await realMeetings();
  try {
    const general = t.messaging.ensureGeneral();
    for (const u of Object.values(users)) t.messaging.joinDefaults(u.id);
    const id = (await t.call('POST', '/v1/meetings', { conversationId: general.id })).body.meeting.id;
    // One call per conversation: starting again from another person joins the same one.
    assert.equal((await t.call('POST', '/v1/meetings', { conversationId: general.id }, users.bo)).body.meeting.id, id);
    const pc = t.peer();
    pc.addTransceiver('audio', { direction: 'sendonly' });
    pc.addTransceiver('video', { direction: 'sendonly' });
    const joined = await t.call('POST', `/v1/meetings/${id}/join`, { sdp: await t.offer(pc) });
    await pc.setRemoteDescription({ type: 'answer', sdp: joined.body.sdp });
    const pid = joined.body.participantId;
    const me = () => t.meetings.view(id, 'bo').participants.find(p => p.id === pid);
    assert.equal(me().muted, false);
    assert.equal((await t.call('POST', `/v1/meetings/${id}/state`, { participantId: pid, muted: true, cameraOff: true }, users.bo)).status, 404, "Bo can't mute Ann");
    assert.equal((await t.call('POST', `/v1/meetings/${id}/state`, { participantId: pid, muted: true, cameraOff: true })).status, 200);
    assert.equal(me().muted, true);
    assert.equal(me().hasVideo, false, 'camera off shows the initial');
    await t.call('POST', `/v1/meetings/${id}/state`, { participantId: pid, muted: false, cameraOff: false });
    assert.equal(me().muted, false);
    // Only the host (Ann started the call) can mute someone else; the asked person's app mutes itself.
    assert.equal((await t.call('POST', `/v1/meetings/${id}/mute`, { participantId: pid }, users.bo)).status, 403, 'Bo is not the host');
    assert.equal(me().muteSeq, 0);
    assert.equal((await t.call('POST', `/v1/meetings/${id}/mute`, { participantId: pid })).status, 200);
    assert.equal(me().muted, true);
    assert.equal(me().muteSeq, 1, 'the person is told to mute');
    assert.equal(t.meetings.view(id, 'ann').host, true);
    assert.equal(t.meetings.view(id, 'bo').host, false);
  } finally { await t.close(); }
});

test('research: the host turns it on, everyone is told, and it is off unless the server allows it', async () => {
  const off = setup();
  const g0 = off.messaging.ensureGeneral();
  for (const u of Object.values(users)) off.messaging.joinDefaults(u.id);
  const m0 = (await off.call('POST', '/v1/meetings', { conversationId: g0.id })).body;
  assert.equal(off.meetings.view(m0.meeting.id, 'ann').research.available, false);
  assert.equal((await off.call('POST', `/v1/meetings/${m0.meeting.id}/research`, {})).status, 404);
  await off.close();

  const t = setup({ research: async () => 'x', config: { research: true } });
  const g1 = t.messaging.ensureGeneral();
  for (const u of Object.values(users)) t.messaging.joinDefaults(u.id);
  const id = (await t.call('POST', '/v1/meetings', { conversationId: g1.id })).body.meeting.id;
  const v = () => t.meetings.view(id, 'ann').research;
  assert.deepEqual([v().available, v().on, v().cards.length], [true, false, 0]);
  assert.equal((await t.call('POST', `/v1/meetings/${id}/research`, {}, users.bo)).status, 403, 'only the host');
  assert.equal(v().on, false);
  const res = await t.call('POST', `/v1/meetings/${id}/research`, {});
  assert.equal(res.status, 200);
  assert.equal(v().on, true);
  assert.equal(res.body.meeting.research.on, true);
  await t.meetings.finish(id);
  await t.close();
});
