// The README's Features list is the index of docs/features.md: it says the guide "covers each of these".
// Seven sections were added to the guide in one week without a line in the list, so this keeps the two in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
// The address GitHub gives a heading: lower case, punctuation dropped, spaces as hyphens.
const anchor = heading => heading.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

const headings = [...read('docs/features.md').matchAll(/^## (.+)$/gm)].map(match => match[1].trim());
const listed = [...read('README.md').matchAll(/^- \[([^\]]+)\]\(docs\/features\.md#([^)]+)\)$/gm)].map(match => ({ title: match[1], anchor: match[2] }));

test('every section of the feature guide is in the README list, in the same order', () => {
  assert.ok(headings.length > 20, 'the guide was read');
  assert.deepEqual(listed.map(item => item.title), headings);
});

test('every link in the list lands on its section', () => {
  for (const item of listed) assert.equal(item.anchor, anchor(item.title), item.title);
  assert.equal(anchor("Features an instance doesn't use"), 'features-an-instance-doesnt-use');
  assert.equal(anchor('A reply also sent to the channel'), 'a-reply-also-sent-to-the-channel');
});
