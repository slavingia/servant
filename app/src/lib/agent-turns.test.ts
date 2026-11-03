import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeAgentTurn, canSteer, liveAgentLine, parseAgentTurn, splitTurns, type AgentTurn } from './agent-turns.ts';
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

const queuedTurn = (id: string, status: AgentTurn["status"], createdAt: number, extra: Partial<AgentTurn> = {}): AgentTurn =>
  ({ id, chatId: "chat_1", status, accepted: status !== "queued", text: `msg ${id}`, assistantText: "", canStop: true, createdAt, updatedAt: createdAt, ...extra });

test("the running reply is current and queued messages wait oldest first", () => {
  const { current, waiting } = splitTurns([queuedTurn("c", "queued", 3), queuedTurn("b", "queued", 2), queuedTurn("a", "running", 1)]);
  assert.equal(current?.id, "a");
  assert.deepEqual(waiting.map(t => t.id), ["b", "c"]);
});

test("with nothing running, the latest finished turn is current and steered turns are hidden", () => {
  const { current, waiting } = splitTurns([queuedTurn("b", "steered", 2), queuedTurn("a", "completed", 1)]);
  assert.equal(current?.id, "a");
  assert.deepEqual(waiting, []);
});

test("steer needs a running reply, text, and only one tap", () => {
  const running = queuedTurn("a", "running", 1);
  assert.equal(canSteer(queuedTurn("b", "queued", 2), running), true);
  assert.equal(canSteer(queuedTurn("b", "queued", 2), queuedTurn("a", "stopping", 1)), false);
  assert.equal(canSteer(queuedTurn("b", "queued", 2), null), false);
  assert.equal(canSteer(queuedTurn("b", "queued", 2, { steerRequested: true }), running), false);
  assert.equal(canSteer(queuedTurn("b", "queued", 2, { text: "  " }), running), false);
  assert.equal(canSteer(queuedTurn("b", "queued", 2), queuedTurn("a", "waiting_for_approval", 1)), true);
});

test("steered status and steerRequested parse from the server", () => {
  const parsed = parseAgentTurn({ ...queuedTurn("b", "steered", 2), steerRequested: true });
  assert.equal(parsed?.status, "steered");
  assert.equal(parsed?.steerRequested, true);
});

test("the in-progress line follows the agent: stream first, then the saved activity, then Thinking", () => {
  const running = queuedTurn("a", "running", 1, { activity: "Reading a file" });
  assert.equal(liveAgentLine(running, "Searching the web"), "Searching the web");
  assert.equal(liveAgentLine(running, null), "Reading a file");
  assert.equal(liveAgentLine(queuedTurn("a", "running", 1), null), "Thinking");
  assert.equal(liveAgentLine(null, null), "Thinking");
  assert.equal(liveAgentLine({ ...running, status: "waiting_for_approval" }, "Running a command"), "Waiting for your OK");
  assert.equal(parseAgentTurn({ ...running, activity: 5 })?.activity, null);
});
