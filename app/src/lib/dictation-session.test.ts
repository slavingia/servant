import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDictationCoordinator, type DictationEvent, type DictationState } from './dictation-session.ts';
import { insertDictation } from './dictation-text.ts';

function fixture(permission = async () => ({ granted: true }), start: () => void | Promise<void> = () => {}, permissionMayBackgroundApp = false) {
  const listeners = new Set<(event: DictationEvent) => void>();
  const calls = { start: 0, stop: 0, abort: 0 };
  const coordinator = createDictationCoordinator({ permission,
    start: () => { calls.start++; return start(); }, stop: () => { calls.stop++; }, abort: () => { calls.abort++; },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  }, { permissionMayBackgroundApp });
  const emit = (event: DictationEvent) => [...listeners].forEach(listener => listener(event));
  const session = (onText?: (text: string) => void) => {
    const words: string[] = [], states: DictationState[] = [];
    const control = coordinator.createSession(text => { words.push(text); onText?.(text); }, state => states.push(state));
    control.setActive(true);
    return { ...control, words, states };
  };
  return { calls, emit, session, listeners };
}

test('only the owning composer receives dictation; another mounted composer cannot abort it', async () => {
  const f = fixture(), channel = f.session(), thread = f.session();
  await thread.start('en-US');
  channel.setActive(false);
  assert.equal(f.calls.abort, 0);
  f.emit({ type: 'result', isFinal: false, text: 'Thread draft' });
  f.emit({ type: 'result', isFinal: true, text: 'Thread message' });
  f.emit({ type: 'end' });
  assert.deepEqual(channel.words, []);
  assert.deepEqual(thread.words, ['Thread message']);
  assert.equal(f.listeners.size, 0);
});

test('finish waits for the final transcript before sending, including an initially empty draft', async () => {
  const f = fixture();
  let draft = '', cursor = 0;
  const session = f.session(spoken => {
    const next = insertDictation(draft, cursor, spoken);
    draft = next.text; cursor = next.cursor;
  });
  await session.start('en-US');
  const sent: string[] = [];
  const send = (async () => { if (await session.finish()) sent.push(draft.trim()); })();
  const secondStop = session.finish();
  assert.equal(f.calls.stop, 1, 'repeated finish does not restart stopping');
  await Promise.resolve();
  assert.deepEqual(sent, []);
  f.emit({ type: 'result', isFinal: false, text: 'Unfinished' });
  assert.equal(draft, '');
  f.emit({ type: 'result', isFinal: true, text: 'All dictated words' });
  assert.deepEqual(sent, [], 'a final segment can arrive before the recognizer ends');
  f.emit({ type: 'end' });
  await send;
  assert.equal(await secondStop, true);
  assert.deepEqual(sent, ['All dictated words']);
});

test('permission completion after route blur or unmount cannot start the microphone', async () => {
  let grant!: (value: { granted: boolean }) => void;
  const f = fixture(() => new Promise(resolve => { grant = resolve; }));
  const session = f.session();
  const starting = session.start('en-US');
  session.setActive(false);
  grant({ granted: true });
  await starting;
  assert.equal(f.calls.start, 0);
  assert.equal(f.calls.abort, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(await session.finish(), false);
});

test('blur cancels an in-flight send and drains old native events before another composer starts', async () => {
  const f = fixture(), old = f.session(), next = f.session();
  await old.start('en-US');
  const sending = old.finish();
  old.setActive(false);
  assert.equal(await sending, false);
  assert.equal(f.calls.abort, 1);
  await next.start('en-US');
  assert.equal(f.calls.start, 1, 'a new session cannot adopt the old session tail');
  f.emit({ type: 'result', isFinal: true, text: 'Late old words' });
  f.emit({ type: 'end' });
  await next.start('en-US');
  f.emit({ type: 'result', isFinal: true, text: 'New words' });
  f.emit({ type: 'end' });
  assert.deepEqual(old.words, []);
  assert.deepEqual(next.words, ['New words']);
});

test('recognizer start rejection is reported and releases ownership for retry', async () => {
  let rejected = true;
  const f = fixture(undefined, async () => { if (rejected) throw new Error('start failed'); });
  const session = f.session();
  await session.start('en-US');
  assert.match(session.states.at(-1)!.error, /Couldn't start dictation/);
  assert.equal(session.states.at(-1)!.listening, false);
  assert.equal(f.listeners.size, 0);
  rejected = false;
  await session.start('en-US');
  assert.equal(f.calls.start, 2);
  f.emit({ type: 'end' });
});

test('recognizer errors prevent a pending send from silently dropping unfinished speech', async () => {
  const f = fixture(), session = f.session();
  await session.start('en-US');
  const sending = session.finish();
  f.emit({ type: 'error', error: 'network' });
  f.emit({ type: 'end' });
  assert.equal(await sending, false);
  assert.match(session.states.at(-1)!.error, /connection/);
  assert.deepEqual(session.words, []);
});

test('Android first grant waits for the permission Activity to return to foreground', async () => {
  let grant!: (value: { granted: boolean }) => void;
  const f = fixture(() => new Promise(resolve => { grant = resolve; }), undefined, true);
  const session = f.session();
  const starting = session.start('en-US');
  session.setForeground(false);
  grant({ granted: true });
  await Promise.resolve();
  assert.equal(f.calls.start, 0, 'a granted permission cannot start recording in the background');
  session.setForeground(true);
  await starting;
  assert.equal(f.calls.start, 1);
  f.emit({ type: 'result', isFinal: true, text: 'First granted words' });
  f.emit({ type: 'end' });
  assert.deepEqual(session.words, ['First granted words']);
});

test('Android foreground can arrive before the first permission result', async () => {
  let grant!: (value: { granted: boolean }) => void;
  const f = fixture(() => new Promise(resolve => { grant = resolve; }), undefined, true);
  const session = f.session();
  const starting = session.start('en-US');
  session.setForeground(false);
  session.setForeground(true);
  assert.equal(f.calls.start, 0);
  grant({ granted: true });
  await starting;
  assert.equal(f.calls.start, 1);
  f.emit({ type: 'end' });
});

test('Android first denial retains guidance after the permission Activity returns', async () => {
  let grant!: (value: { granted: boolean }) => void;
  const f = fixture(() => new Promise(resolve => { grant = resolve; }), undefined, true);
  const session = f.session();
  const starting = session.start('en-US');
  session.setForeground(false);
  grant({ granted: false });
  await starting;
  session.setForeground(true);
  assert.equal(f.calls.start, 0);
  assert.equal(session.states.at(-1)!.listening, false);
  assert.match(session.states.at(-1)!.error, /Allow the microphone in Settings/);
  assert.equal(await session.finish(), true, 'typed messages remain sendable after denial');
});

test('a grant left in the background expires instead of recording on a later return', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let grant!: (value: { granted: boolean }) => void;
  const f = fixture(() => new Promise(resolve => { grant = resolve; }), undefined, true);
  const session = f.session();
  const starting = session.start('en-US');
  session.setForeground(false);
  grant({ granted: true });
  await Promise.resolve();
  t.mock.timers.tick(1001);
  await starting;
  session.setForeground(true);
  assert.equal(f.calls.start, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(session.states.at(-1)!.listening, false);
  assert.match(session.states.at(-1)!.error, /Tap the microphone to try again/);
});

test('a long background stay during the permission request requires another tap', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let grant!: (value: { granted: boolean }) => void;
  const f = fixture(() => new Promise(resolve => { grant = resolve; }), undefined, true);
  const session = f.session();
  const starting = session.start('en-US');
  session.setForeground(false);
  t.mock.timers.setTime(60_001);
  session.setForeground(true);
  grant({ granted: true });
  await starting;
  assert.equal(f.calls.start, 0);
  assert.match(session.states.at(-1)!.error, /Tap the microphone to try again/);
});

test('navigation cancels the Android foreground handoff without affecting the next composer', async () => {
  let grant!: (value: { granted: boolean }) => void;
  let requests = 0;
  const f = fixture(() => ++requests === 1 ? new Promise(resolve => { grant = resolve; }) : Promise.resolve({ granted: true }), undefined, true);
  const old = f.session(), next = f.session();
  const starting = old.start('en-US');
  old.setForeground(false);
  grant({ granted: true });
  await Promise.resolve();
  old.setActive(false);
  await starting;
  await next.start('en-US');
  old.setForeground(true);
  f.emit({ type: 'result', isFinal: true, text: 'Next composer only' });
  f.emit({ type: 'end' });
  assert.equal(f.calls.start, 1);
  assert.deepEqual(old.words, []);
  assert.deepEqual(next.words, ['Next composer only']);
});

test('background during Android recording aborts and rejects late transcript events', async () => {
  const f = fixture(undefined, undefined, true), session = f.session();
  await session.start('en-US');
  session.setForeground(false);
  assert.equal(f.calls.abort, 1);
  f.emit({ type: 'result', isFinal: true, text: 'Must not reach draft' });
  f.emit({ type: 'end' });
  session.setForeground(true);
  assert.deepEqual(session.words, []);
  assert.equal(f.calls.start, 1, 'foreground does not resume cancelled recording');
  assert.equal(session.states.at(-1)!.listening, false);
});

test('finish during the permission foreground handoff releases it without starting recording', async () => {
  let grant!: (value: { granted: boolean }) => void;
  const f = fixture(() => new Promise(resolve => { grant = resolve; }), undefined, true);
  const session = f.session();
  const starting = session.start('en-US');
  session.setForeground(false);
  grant({ granted: true });
  await Promise.resolve();
  assert.equal(await session.finish(), false, 'a backgrounded composer cannot send');
  session.setForeground(true);
  await starting;
  assert.equal(f.calls.start, 0);
  assert.equal(session.states.at(-1)!.listening, false);
});

test('other platforms still cancel a pending permission request on real app background', async () => {
  let grant!: (value: { granted: boolean }) => void;
  const f = fixture(() => new Promise(resolve => { grant = resolve; }));
  const session = f.session();
  const starting = session.start('en-US');
  session.setForeground(false);
  session.setForeground(true);
  grant({ granted: true });
  await starting;
  assert.equal(f.calls.start, 0);
  assert.equal(session.states.at(-1)!.listening, false);
});

test('sending while listening never waits on a recognizer that is slow to end', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let draft = '';
  const session = f.session(spoken => { draft = insertDictation(draft, draft.length, spoken).text; });
  await session.start('en-US');
  f.emit({ type: 'result', isFinal: true, text: 'Book the room' });
  f.emit({ type: 'result', isFinal: false, text: 'for Friday' });
  const sending = session.finish(1200);
  t.mock.timers.tick(1200);
  assert.equal(await sending, true);
  assert.equal(draft, 'Book the room for Friday', 'the live partial is kept rather than dropped');
  assert.equal(session.states.at(-1)!.listening, false);
  assert.equal(f.calls.abort, 1);
  f.emit({ type: 'result', isFinal: true, text: 'for Friday' });
  f.emit({ type: 'end' });
  assert.equal(draft, 'Book the room for Friday', 'late final words cannot refill the cleared box');
  t.mock.timers.tick(10_000);
  assert.equal(session.states.at(-1)!.error, '');
  await session.start('en-US');
  assert.equal(f.calls.start, 2, 'the next dictation can start right away');
});

test('a recognizer that ends promptly sends its final words without the grace path', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const session = f.session();
  await session.start('en-US');
  const sending = session.finish(1200);
  f.emit({ type: 'result', isFinal: true, text: 'Done' });
  f.emit({ type: 'end' });
  assert.equal(await sending, true);
  t.mock.timers.tick(5000);
  assert.equal(f.calls.abort, 0);
  assert.deepEqual(session.words, ['Done']);
});
