import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usualWork, LONG_REPLY_MS, SAMPLE } from './turn-estimate.mjs';

const min = n => n * 60_000;
const minutes = (...list) => list.map(min);

test('the usual time is the one three in four past replies finished within', () => {
  // Five replies: the fourth of five, in order, is the three-in-four mark.
  assert.equal(usualWork({ here: minutes(12, 4, 8, 6, 10) }), min(10));
  // Between two neighbours it reads between them: the mark of eight sits a quarter of the way from the sixth to the seventh.
  assert.equal(usualWork({ here: minutes(3, 4, 4, 6, 7, 9, 12, 15) }), min(9.75));
  // One reply that took two hours moves it by half a minute, where an average would go from under 9 to over 22.
  assert.equal(usualWork({ here: minutes(4, 6, 8, 10, 10, 10, 12) }), min(10));
  assert.equal(usualWork({ here: minutes(4, 6, 8, 10, 10, 10, 12, 120) }), min(10.5));
});

test('with too little to go on there is no estimate, not a guess', () => {
  assert.equal(usualWork(), null);
  assert.equal(usualWork({ here: [], mine: [] }), null);
  assert.equal(usualWork({ here: minutes(4, 6, 8, 10) }), null, 'four is not a habit');
  assert.equal(usualWork({ here: minutes(4, 6), mine: minutes(4, 6, 8, 10) }), null);
  // Times that are not times are not counted towards enough.
  assert.equal(usualWork({ here: [min(4), min(6), min(8), min(10), NaN, -5, 0, null, undefined, '9'] }), null);
});

test("a chat with enough replies of its own is judged by them; a newer chat borrows the person's others", () => {
  const prototyping = minutes(12, 4, 8, 6, 10), research = minutes(2, 3, 3, 4, 5);
  assert.equal(usualWork({ here: prototyping, mine: research }), min(10));
  assert.equal(usualWork({ here: minutes(12, 4), mine: research }), min(4), 'two here is not enough; the five elsewhere are');
  assert.equal(usualWork({ mine: research }), min(4), 'a first reply in a new chat');
});

test('replies that are usually done within two minutes get no estimate', () => {
  assert.equal(usualWork({ here: [70_000, 80_000, 90_000, 100_000, 110_000] }), null);
  assert.equal(usualWork({ here: [80_000, 100_000, 110_000, 120_000, 125_000] }), min(2), 'two minutes is worth saying');
});

test('a history too uneven to say anything honest gets no estimate', () => {
  // Quick fixes and long builds in one chat: the slow quarter is twelve times the quick one.
  assert.equal(usualWork({ here: minutes(1.2, 1.5, 2, 2, 3, 20, 30, 45) }), null);
  // Its own uneven history is not swapped for a tidier one from elsewhere: this chat is what it is.
  assert.equal(usualWork({ here: minutes(1.2, 1.5, 2, 2, 3, 20, 30, 45), mine: minutes(4, 6, 8, 10, 12) }), null);
  // Up to four times apart still says something.
  assert.equal(usualWork({ here: minutes(2, 2, 5, 8, 8) }), min(8));
  assert.equal(usualWork({ here: minutes(2, 2, 5, 8.5, 8.5) }), null);
});

test('the estimate is whole milliseconds and never changes what it was given', () => {
  const here = [100_001, 200_002, 300_003, 400_004, 500_006, 600_007];
  const before = [...here];
  assert.equal(usualWork({ here }), 475_006, 'three quarters of the way from the fourth to the fifth, rounded');
  assert.deepEqual(here, before, 'sorting does not reorder the list it was handed');
  assert.equal(LONG_REPLY_MS, 60_000);
  assert.equal(SAMPLE, 20);
});
