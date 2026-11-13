import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeAgentTurn, inOrder, joinsReply, liveAgentLine, patientLine, queuedBelow, parseAgentTurn, readableSteps, splitTurns, spokenDuration, withRead, workByMessage, workedFor, workingFor, type AgentTurn } from './agent-turns.ts';
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

test("a message sent while a reply runs joins it: text only, a reply that can take one, and never one that is stopping", () => {
  const running = queuedTurn("a", "running", 1, { canSteer: true });
  assert.equal(joinsReply(running, "Use the blue one"), true);
  assert.equal(joinsReply({ ...running, status: "waiting_for_approval" }, "Use the blue one"), true);
  assert.equal(joinsReply(running, "   "), false, "nothing to say");
  assert.equal(joinsReply(running, "See this", 1), false, "files wait and are sent after");
  assert.equal(joinsReply({ ...running, status: "stopping" }, "Use the blue one"), false);
  assert.equal(joinsReply(queuedTurn("a", "queued", 1, { canSteer: true }), "Use the blue one"), false, "not started yet");
  assert.equal(joinsReply(queuedTurn("a", "completed", 1), "Use the blue one"), false);
  assert.equal(joinsReply(null, "Use the blue one"), false);
  // The server says when a reply can't take one: a member's agent, an older bridge, a reply that has only just started.
  assert.equal(joinsReply({ ...running, canSteer: false }, "Use the blue one"), false);
  // An older server doesn't say either way. Asking costs nothing: a refusal leaves the message waiting.
  assert.equal(joinsReply(queuedTurn("a", "running", 1), "Use the blue one"), true);
  assert.equal(parseAgentTurn({ ...running, canSteer: "yes" })?.canSteer, undefined);
  assert.equal(parseAgentTurn({ ...running, canSteer: false })?.canSteer, false);
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

test('a queued turn shown as up next is not listed again as waiting', () => {
  const next = queuedTurn("a", "queued", 1), later = queuedTurn("b", "queued", 2);
  assert.deepEqual(queuedBelow([next, later], [next, null]).map(t => t.id), ["b"]);
  assert.deepEqual(queuedBelow([next, later], [undefined, queuedTurn("r", "running", 0)]).map(t => t.id), ["a", "b"]);
});

test('steps ride on the turn while it runs; a finished one keeps the count, its times and its reply', () => {
  const turn = parseAgentTurn({ id: 't', chatId: 'c', status: 'running', createdAt: 1, updatedAt: 2, startedAt: 10_000,
    steps: [{ label: 'Thinking', detail: 'Check the repo', at: 10_500 }, { label: 'Running a command', detail: 'git status', at: 12_000 }, { label: '', at: 1 }, 'junk'] });
  assert.deepEqual(turn?.steps, [{ label: 'Thinking', detail: 'Check the repo', at: 10_500 }, { label: 'Running a command', detail: 'git status', at: 12_000 }]);
  assert.equal(turn?.stepCount, 2);
  assert.equal(turn?.finishedAt, null);
  const done = parseAgentTurn({ id: 't', chatId: 'c', status: 'completed', createdAt: 1, updatedAt: 2, startedAt: 10_000, finishedAt: 22_000, steps: [], stepCount: 3, messageId: 'msg_reply' });
  assert.deepEqual([done?.steps, done?.stepCount, done?.finishedAt, done?.messageId], [[], 3, 22_000, 'msg_reply']);
  assert.equal(parseAgentTurn({ id: 't', chatId: 'c', status: 'completed', createdAt: 1, updatedAt: 2, messageId: 7, finishedAt: 'later', stepCount: 'many' })?.messageId, null);
});

test('time is said the way a person would: one to nine spelled out, seconds dropped past a minute', () => {
  assert.equal(spokenDuration(300), 'one second', 'never "zero seconds"');
  assert.equal(spokenDuration(2_400), 'two seconds');
  assert.equal(spokenDuration(9_000), 'nine seconds');
  assert.equal(spokenDuration(12_000), '12 seconds');
  assert.equal(spokenDuration(59_600), 'one minute');
  assert.equal(spokenDuration(75_000), 'one minute');
  assert.equal(spokenDuration(150_000), 'three minutes');
  assert.equal(spokenDuration(14 * 60_000), '14 minutes');
  assert.equal(spokenDuration(3_599_000), 'one hour');
  assert.equal(spokenDuration(3_900_000), 'one hour and five minutes');
  assert.equal(spokenDuration(2 * 3_600_000 + 12 * 60_000), 'two hours and 12 minutes');
});

test('plain Thinking gets more reassuring the longer a task runs; real activity is left alone', () => {
  assert.equal(patientLine('Thinking', 5_000), 'Thinking');
  assert.equal(patientLine('Thinking', 25_000), 'Thinking it through');
  assert.equal(patientLine('Thinking', 90_000), 'Still working on it');
  assert.equal(patientLine('Searching the web', 90_000), 'Searching the web');
});

test('the live line stays quiet for the first minute, then says how long in whole minutes', () => {
  const running = queuedTurn('a', 'running', 1, { startedAt: 10_000 });
  assert.equal(workingFor(running, 10_000 + 59_000), '');
  assert.equal(workingFor(running, 10_000 + 60_000), 'one minute');
  assert.equal(workingFor(running, 10_000 + 179_000), 'two minutes', 'whole minutes so far, never rounded up');
  assert.equal(workingFor(queuedTurn('a', 'running', 1, { steps: [{ label: 'Thinking', at: 5_000 }] }), 5_000 + 61_000), 'one minute', 'from the first step when the start is unknown');
  assert.equal(workingFor(queuedTurn('a', 'running', 1), 9e9), '');
  assert.equal(workingFor(null, 9e9), '');
});

test('a finished reply says how long the agent worked, and only a finished, timed one does', () => {
  const done = queuedTurn('a', 'completed', 1, { startedAt: 10_000, finishedAt: 22_000, messageId: 'msg_a' });
  assert.equal(workedFor(done), 'Worked for 12 seconds');
  assert.equal(workedFor({ ...done, finishedAt: 10_000 + 95_000 }), 'Worked for two minutes');
  assert.equal(workedFor({ ...done, status: 'running', finishedAt: null }), null);
  assert.equal(workedFor({ ...done, status: 'cancelled' }), null, 'a stopped reply already says it was stopped');
  assert.equal(workedFor({ ...done, startedAt: null }), null, 'from before replies were timed');
  assert.equal(workedFor({ ...done, finishedAt: 9_000 }), null);
  // Each reply is found by the message it wrote; a message folded into another reply wrote none.
  const steered = queuedTurn('b', 'steered', 2, { startedAt: null, finishedAt: null });
  const untimed = queuedTurn('c', 'completed', 3, { messageId: 'msg_c' });
  assert.deepEqual([...workByMessage([untimed, steered, done]).keys()], ['msg_a']);
});

type Shown = { id: string; role: string; text?: string; pending?: boolean; localId?: string };
test('a message the agent read mid-reply joins the list above the reply still in progress, once', () => {
  const shown: Shown[] = [{ id: 'm1', role: 'user', text: 'Draft the memo', localId: 'u1' }, { id: 'a1', role: 'assistant', text: '', pending: true, localId: 'a1' }];
  const history: Shown[] = [{ id: 'm1', role: 'user', text: 'Draft the memo' }, { id: 'm2', role: 'user', text: 'Keep it to one page' }, { id: 'draft_t', role: 'assistant', text: 'One', pending: true }];
  assert.deepEqual(withRead(shown, history).map(m => m.id), ['m1', 'm2', 'a1'], "the server's own draft row never doubles this phone's reply");
  assert.equal(withRead(withRead(shown, history), history).length, 3);
  assert.equal(withRead(shown, history.slice(0, 1)), shown, 'nothing new: the same list, so nothing re-renders');
  // This phone's first message hasn't had its real id back yet: the server's copy of it is not a second message.
  const unconfirmed: Shown[] = [{ id: 'u1', role: 'user', text: 'Draft the memo', localId: 'u1', pending: true }, shown[1]!];
  assert.deepEqual(withRead(unconfirmed, history).map(m => m.id), ['u1', 'm2', 'a1']);
  // Reopened on another device: no reply row of this phone's own, so it goes at the end.
  assert.deepEqual(withRead([{ id: 'm1', role: 'user' }], history).map(m => m.id), ['m1', 'm2']);
});

test('the list reads top to bottom: said, joining the reply, the reply, then waiting for it', () => {
  const live = (row: string) => row === 'reply (this phone)';
  assert.deepEqual(inOrder(['hello', 'reply (this phone)'], ['joining'], null, ['waiting'], live), ['hello', 'joining', 'reply (this phone)', 'waiting']);
  assert.deepEqual(inOrder(['hello'], ['joining'], 'reply (another device)', ['waiting'], live), ['hello', 'joining', 'reply (another device)', 'waiting']);
  assert.deepEqual(inOrder(['hello'], [], null, [], live), ['hello']);
});

test('the steps read like a retelling: what it worked on every time, a bare line only once', () => {
  // A member's agent never says what it ran, so its steps are bare lines that repeat.
  const member = ['Thinking', 'Working on it', 'Thinking', 'Working on it', 'Thinking', 'Writing'].map((label, at) => ({ label, at }));
  assert.deepEqual(readableSteps(member).map(s => s.label), ['Thinking', 'Working on it', 'Writing']);
  // The owner's steps say what each one worked on: every command and file stays, in order.
  const owner = [{ label: 'Thinking', detail: 'Check the repo first', at: 1 }, { label: 'Running a command', detail: 'git status', at: 2 },
    { label: 'Thinking', at: 3 }, { label: 'Running a command', detail: 'git diff', at: 4 }, { label: 'Writing', at: 5 }];
  assert.deepEqual(readableSteps(owner).map(s => s.detail ?? s.label), ['Check the repo first', 'git status', 'git diff', 'Writing']);
  assert.deepEqual(readableSteps([]), []);
});
