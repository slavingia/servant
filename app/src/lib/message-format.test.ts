import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineMessage, messageBlocks } from './message-format.ts';

test('agent lists, emphasis and fenced code retain useful structure', () => {
  assert.deepEqual(messageBlocks('# Plan\n\n- **First** step\n2. Next\n\n```ts\nconst x = 1;\n```'), [
    { kind: 'heading', text: 'Plan' }, { kind: 'list', marker: '•', text: '**First** step' },
    { kind: 'list', marker: '2.', text: 'Next' }, { kind: 'code', language: 'ts', text: 'const x = 1;' },
  ]);
  assert.deepEqual(inlineMessage('**Bold** and `code` and _em_'), [{ kind: 'strong', text: 'Bold' }, { kind: 'text', text: ' and ' }, { kind: 'code', text: 'code' }, { kind: 'text', text: ' and ' }, { kind: 'em', text: 'em' }]);
});

test('untrusted markup stays literal and incomplete streamed code stays visible', () => {
  const unsafe = '<img src="https://private.test"> [open](javascript:alert(1)) ![x](https://tracker.test)';
  assert.deepEqual(messageBlocks(unsafe), [{ kind: 'paragraph', text: unsafe }]);
  assert.deepEqual(inlineMessage(unsafe), [{ kind: 'text', text: unsafe }]);
  assert.deepEqual(messageBlocks('```\n**literal**\nunfinished'), [{ kind: 'code', language: '', text: '**literal**\nunfinished' }]);
  assert.deepEqual(inlineMessage('some_field_name and **unfinished'), [{ kind: 'text', text: 'some_field_name and **unfinished' }]);
});
