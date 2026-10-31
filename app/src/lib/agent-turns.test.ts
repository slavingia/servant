import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeAgentTurn, parseAgentTurn } from './agent-turns.ts';
import { createAgentEventDecoder, type StreamEvent } from './agent-events.ts';

const turn = { id: 'turn_1', chatId: 'chat_1', status: 'waiting_for_approval', accepted: true, text: 'Prepare notes', assistantText: 'Ready', canStop: true, createdAt: 10, updatedAt: 20 };
const approval = { id: 'approval_exact', command: 'publish draft', description: 'Publish the reviewed draft', choices: ['once', 'deny'] };

test('approval and durable turn survive fragmented encrypted-stream payloads', () => {
  const events: StreamEvent[] = [];
  const decoder = createAgentEventDecoder(event => events.push(event));
  const wire = new TextEncoder().encode(`event: turn\ndata: ${JSON.stringify({ turn })}\n\nevent: approval\ndata: ${JSON.stringify({ approval })}\n\nevent: done\ndata: {}\n\n`);
  for (let i = 0; i < wire.length; i += 3) decoder.push(wire.slice(i, i + 3));
  decoder.finish();
  assert.equal(events[0].type, 'turn');
  assert.deepEqual(events[1], { type: 'approval', approval });
});

test('unknown turn states cannot enable controls; stopped turns are terminal', () => {
  assert.equal(parseAgentTurn({ ...turn, status: 'untrusted_state' }), null);
  assert.equal(activeAgentTurn(parseAgentTurn(turn)), true);
  assert.equal(activeAgentTurn(parseAgentTurn({ ...turn, status: 'cancelled' })), false);
  assert.equal(parseAgentTurn({ ...turn, canStop: 'yes' })?.canStop, false);
});
