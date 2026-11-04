import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRing, RING_MS } from './incoming-call.ts';
const base = { status: 'live', startedAt: 1_000_000_000_000, startedById: 'a', me: 'b', now: 1_000_000_005_000, dismissed: new Set<string>(), id: 'm', joined: false };
test('rings for a fresh live call from someone else', () => assert.equal(shouldRing(base), true));
test('does not ring for your own call, a finished call, a stale call, or after Decline or joining', () => {
  assert.equal(shouldRing({ ...base, startedById: 'b' }), false);
  assert.equal(shouldRing({ ...base, status: 'done' }), false);
  assert.equal(shouldRing({ ...base, now: base.startedAt + RING_MS + 1 }), false);
  assert.equal(shouldRing({ ...base, dismissed: new Set(['m']) }), false);
  assert.equal(shouldRing({ ...base, joined: true }), false);
});
test('accepts start times in seconds', () => assert.equal(shouldRing({ ...base, startedAt: 1_000_000_000, now: 1_000_000_005_000 }), true));
