import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloseMarkerFilter, stripCloseMarker } from './close-marker.mjs';
import { normalizeMediaContent } from './media.mjs';

// Conversations no longer close themselves, but an older agent session may still end a reply with
// the hidden done line. It must never reach the screen.
test('the done line is cut from a whole reply', () => {
  assert.equal(stripCloseMarker('Shipped it.\n\n<servant-done>Fix shipped, nothing pending</servant-done>'), 'Shipped it.');
  assert.equal(stripCloseMarker('Which one do you want?'), 'Which one do you want?');
  assert.equal(normalizeMediaContent('All set.\n<servant-done>Renamed the files</servant-done>').text, 'All set.');
});

test('streaming never shows any part of the done line, however it is split', () => {
  const reply = 'Fixed the <b> tag bug.\n\n<servant-done>Fixed the bug</servant-done>';
  for (let size = 1; size <= reply.length; size++) {
    const filter = createCloseMarkerFilter();
    let shown = '';
    for (let i = 0; i < reply.length; i += size) shown += filter(reply.slice(i, i + size));
    shown += filter('', true);
    assert.equal(shown, 'Fixed the <b> tag bug.', `chunk size ${size}`);
  }
  const open = createCloseMarkerFilter();
  assert.equal(open('Is <serv') + open('ice> ok?') + open('', true), 'Is <service> ok?');
});
