import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloseMarkerFilter, splitCloseMarker, CLOSE_INSTRUCTIONS, CLOSE_OPEN } from './close-marker.mjs';
import { normalizeMediaContent } from './media.mjs';
import { parseCloserVerdict } from './server.mjs';

test('the done line is cut from a whole reply and its reason kept', () => {
  assert.deepEqual(splitCloseMarker('Shipped it.\n\n<servant-done>Fix shipped, nothing pending</servant-done>'), { text: 'Shipped it.', reason: 'Fix shipped, nothing pending' });
  assert.deepEqual(splitCloseMarker('Which one do you want?'), { text: 'Which one do you want?', reason: null });
  assert.equal(splitCloseMarker('Done <servant-done></servant-done>').reason, 'Done');
  assert.equal(normalizeMediaContent('All set.\n<servant-done>Renamed the files</servant-done>').text, 'All set.');
  // Fixed text, so the prompt cache holds across every run.
  assert.match(CLOSE_INSTRUCTIONS, new RegExp(CLOSE_OPEN));
});

test('streaming never shows any part of the done line, however it is split', () => {
  const reply = 'Fixed the <b> tag bug.\n\n<servant-done>Fixed the bug</servant-done>';
  for (let size = 1; size <= reply.length; size++) {
    const filter = createCloseMarkerFilter();
    let shown = '';
    for (let i = 0; i < reply.length; i += size) shown += filter(reply.slice(i, i + size));
    shown += filter('', true);
    assert.equal(shown, 'Fixed the <b> tag bug.', `chunk size ${size}`);
    assert.equal(filter.reason(), 'Fixed the bug');
  }
  const open = createCloseMarkerFilter();
  assert.equal(open('Is <serv') + open('ice> ok?') + open('', true), 'Is <service> ok?');
  assert.equal(open.reason(), null);
});

test('the closer only closes on a clear yes', () => {
  assert.equal(parseCloserVerdict('{"done": true, "reason": "Fix shipped, nothing pending"}'), 'Fix shipped, nothing pending');
  assert.equal(parseCloserVerdict('Sure: {"done": true}'), 'Nothing pending');
  assert.equal(parseCloserVerdict('{"done": false, "reason": "Asked a question"}'), null);
  assert.equal(parseCloserVerdict('{"done": "yes"}'), null);
  assert.equal(parseCloserVerdict('not json'), null);
});
