import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopMessageNotifies } from './desktop-notification-rules.ts';
const input = { user: { id: 'u_pat', name: 'Pat Tester' }, message: { text: 'Hello', user: { id: 'u_jo' } }, kind: 'channel' as const, preferences: { mode: 'mentions' as const, pausedUntil: 0 }, archived: false, visible: false };
test('desktop preserves DM, mention and participating-thread notification preferences across servers', () => {
  assert.equal(desktopMessageNotifies(input), false);
  assert.equal(desktopMessageNotifies({ ...input, kind: 'dm' }), true);
  assert.equal(desktopMessageNotifies({ ...input, message: { ...input.message, text: 'Hello @Pat-Tester' } }), true);
  assert.equal(desktopMessageNotifies({ ...input, participant: true }), true);
  assert.equal(desktopMessageNotifies({ ...input, preferences: { mode: 'all', pausedUntil: 0 } }), true);
  assert.equal(desktopMessageNotifies({ ...input, kind: 'dm', visible: true }), false);
  assert.equal(desktopMessageNotifies({ ...input, kind: 'dm', archived: true }), false);
  assert.equal(desktopMessageNotifies({ ...input, kind: 'dm', message: { ...input.message, user: input.user } }), false);
  assert.equal(desktopMessageNotifies({ ...input, kind: 'dm', preferences: { mode: 'none', pausedUntil: 0 } }), false);
});
