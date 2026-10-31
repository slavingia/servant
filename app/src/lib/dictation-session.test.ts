import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDictationCoordinator, type DictationEvent, type DictationState } from './dictation-session.ts';
import { insertDictation } from './dictation-text.ts';

function fixture(permission = async () => ({ granted: true }), start: () => void | Promise<void> = () => {}) {
  const listeners = new Set<(event: DictationEvent) => void>();
  const calls = { start: 0, stop: 0, abort: 0 };
  const coordinator = createDictationCoordinator({ permission,
    start: () => { calls.start++; return start(); }, stop: () => { calls.stop++; }, abort: () => { calls.abort++; },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
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
