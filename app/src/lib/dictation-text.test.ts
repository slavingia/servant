import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertDictation } from './dictation-text.ts';

test('places dictated words at the cursor with sensible spacing', () => {
  assert.deepEqual(insertDictation('', 0, 'hello there'), { text: 'hello there', cursor: 11 });
  assert.deepEqual(insertDictation('Hi', 2, 'Ash'), { text: 'Hi Ash', cursor: 6 });
  assert.deepEqual(insertDictation('Hi ', 3, ' Ash '), { text: 'Hi Ash', cursor: 6 });
  assert.deepEqual(insertDictation('@agent thanks', 7, 'many'), { text: '@agent many thanks', cursor: 11 });
  assert.deepEqual(insertDictation('Done.', 4, 'now'), { text: 'Done now.', cursor: 8 });
  assert.deepEqual(insertDictation('same', 4, '   '), { text: 'same', cursor: 4 });
});
