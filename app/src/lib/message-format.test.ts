import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineMessage, messageBlocks, safeUrl } from './message-format.ts';

test('agent lists, emphasis and fenced code retain useful structure', () => {
  assert.deepEqual(messageBlocks('# Plan\n\n- **First** step\n2. Next\n\n```ts\nconst x = 1;\n```'), [
    { kind: 'heading', level: 1, text: 'Plan' }, { kind: 'list', depth: 0, marker: '•', text: '**First** step' },
    { kind: 'list', depth: 0, marker: '2.', text: 'Next' }, { kind: 'code', language: 'ts', text: 'const x = 1;' },
  ]);
  assert.deepEqual(inlineMessage('**Bold** and `code` and _em_'), [{ strong: true, text: 'Bold' }, { text: ' and ' }, { code: true, text: 'code' }, { text: ' and ' }, { em: true, text: 'em' }]);
});

test('untrusted markup stays literal and incomplete streamed code stays visible', () => {
  const unsafe = '<img src="x"> [open](javascript:alert(1))';
  assert.deepEqual(messageBlocks(unsafe), [{ kind: 'paragraph', text: unsafe }]);
  assert.deepEqual(inlineMessage(unsafe), [{ text: unsafe }]);
  assert.deepEqual(messageBlocks('```\n**literal**\nunfinished'), [{ kind: 'code', language: '', text: '**literal**\nunfinished' }]);
  assert.deepEqual(inlineMessage('some_field_name and **unfinished'), [{ text: 'some_field_name and **unfinished' }]);
});

test('links become tappable text, images become links, only web and mail open', () => {
  assert.deepEqual(inlineMessage('pushed as [6ea01c3](https://github.com/o/r/commit/6ea01c3) now'), [
    { text: 'pushed as ' }, { url: 'https://github.com/o/r/commit/6ea01c3', text: '6ea01c3' }, { text: ' now' },
  ]);
  assert.deepEqual(inlineMessage('![shot](https://x.test/a.png)'), [{ url: 'https://x.test/a.png', text: 'shot' }]);
  assert.deepEqual(inlineMessage('see https://github.com/o/r/commit/e6d0d48.'), [
    { text: 'see ' }, { url: 'https://github.com/o/r/commit/e6d0d48', text: 'https://github.com/o/r/commit/e6d0d48' }, { text: '.' },
  ]);
  assert.deepEqual(inlineMessage('(https://a.test/x)'), [{ text: '(' }, { url: 'https://a.test/x', text: 'https://a.test/x' }, { text: ')' }]);
  assert.equal(safeUrl('javascript:alert(1)'), undefined);
  assert.equal(safeUrl('file:///etc/passwd'), undefined);
  assert.equal(safeUrl('mailto:a@b.gov'), 'mailto:a@b.gov');
});

test('styles nest: code inside bold, links inside bold, strikethrough', () => {
  assert.deepEqual(inlineMessage('**Reverified `1da98ef`**'), [{ strong: true, text: 'Reverified ' }, { strong: true, code: true, text: '1da98ef' }]);
  assert.deepEqual(inlineMessage('**see [docs](https://a.test)**'), [{ strong: true, text: 'see ' }, { strong: true, url: 'https://a.test', text: 'docs' }]);
  assert.deepEqual(inlineMessage('~~old~~ new'), [{ strike: true, text: 'old' }, { text: ' new' }]);
  assert.deepEqual(inlineMessage('2 * 3 * 4 and a*b'), [{ text: '2 * 3 * 4 and a*b' }]);
  assert.deepEqual(inlineMessage('\\*not em\\*'), [{ text: '*not em*' }]);
});

test('nested lists, task boxes and wrapped list lines', () => {
  assert.deepEqual(messageBlocks('1. Sort options:\n   - Recent\n   - [x] Alphabetical\n     still alphabetical\n2. Done'), [
    { kind: 'list', depth: 0, marker: '1.', text: 'Sort options:' },
    { kind: 'list', depth: 1, marker: '◦', text: 'Recent' },
    { kind: 'list', depth: 1, marker: '◦', text: 'Alphabetical\nstill alphabetical', checked: true },
    { kind: 'list', depth: 0, marker: '2.', text: 'Done' },
  ]);
  assert.deepEqual(messageBlocks('- [ ] 6. E2E pending'), [{ kind: 'list', depth: 0, marker: '•', text: '6. E2E pending', checked: false }]);
});

test('tables, rules, quotes and heading levels', () => {
  assert.deepEqual(messageBlocks('| | Before | Now |\n|---|:---:|--:|\n| **Unread** | Same | Bold, `blue` |\n| Read | x |\n\n---\n## Next\n> one\n> two'), [
    { kind: 'table', header: ['', 'Before', 'Now'], align: ['left', 'center', 'right'], rows: [['**Unread**', 'Same', 'Bold, `blue`'], ['Read', 'x', '']] },
    { kind: 'rule' }, { kind: 'heading', level: 2, text: 'Next' }, { kind: 'quote', text: 'one\ntwo' },
  ]);
  assert.deepEqual(messageBlocks('a | b with no table'), [{ kind: 'paragraph', text: 'a | b with no table' }]);
});

test('indented fences inside lists still become code', () => {
  assert.deepEqual(messageBlocks('- config:\n    ```json\n    {"a":1}\n    ```'), [
    { kind: 'list', depth: 0, marker: '•', text: 'config:' }, { kind: 'code', language: 'json', text: '{"a":1}' },
  ]);
});

test('agent chat links the server writes are allowed, nothing else relative', () => {
  assert.equal(safeUrl('/chat/cht_abc-12'), '/chat/cht_abc-12');
  for (const u of ['/chat/cht_a/../x', '/other', '/chat/', '//evil.example']) assert.equal(safeUrl(u), undefined);
});

test('in-app chat link tolerates a stray space before the parenthesis', () => {
  const parts = inlineMessage('in [Fix it] (/chat/cht_abc123). Go');
  assert.equal(parts.find(p => p.url)?.url, '/chat/cht_abc123');
  assert.equal(inlineMessage('[a] (https://x.com)').some(p => p.url), false);
  assert.equal(inlineMessage('[a](/chat/cht_FWKLlgGGBFxV)').some(p => p.url), true);
});
