import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ftsQuery, parseSearch } from './search.mjs';

test('what is typed is split into words and filters', () => {
  const asked = parseSearch('budget review in:#general from:@Jo-Park has:link is:thread');
  assert.deepEqual(asked.filters, { in: 'general', from: 'Jo-Park', link: true, file: false, thread: true });
  assert.deepEqual([asked.words, asked.filtered], ['budget review', true]);
  assert.deepEqual(parseSearch('has:files HAS:Attachment Is:Threads').filters, { in: null, from: null, link: false, file: true, thread: true });
  // Not a filter: an unknown one, a time, a link. They stay words.
  const plain = parseSearch('has:cheese 10:30 https://example.gov/a note:this');
  assert.deepEqual([plain.filtered, plain.words], [false, 'has:cheese 10:30 https://example.gov/a note:this']);
  assert.deepEqual(parseSearch('"came in already" permit').terms, [{ text: 'came in already', phrase: true }, { text: 'permit', phrase: false }]);
  assert.deepEqual(parseSearch('').terms, []);
});

test('words become a query in which nothing typed is an operator', () => {
  const q = text => ftsQuery(parseSearch(text).terms);
  assert.equal(q('permit renew'), '"permit" "renew"*');
  assert.equal(q('"came in already" form'), '"came in already" "form"*');
  assert.equal(q('permit OR "x" NOT y*'), '"permit" "or" "x" "not" "y"*');
  assert.equal(q('it\'s (urgent)!'), '"it" "s" "urgent"*');
  assert.equal(q('--- ***'), null, 'nothing the index treats as a word');
  assert.equal(q('Élodie café'), '"élodie" "café"*');
});
