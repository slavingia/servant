// One thing the agent did. detail is what it worked on (a command, a search,
// a file, its reasoning); the server only sends it to the owner.
export type AgentStep = { label: string; detail?: string; at: number };
export type AgentApproval = { id: string; command: string; description: string; choices: ('once' | 'deny')[] };
export type AgentTurn = {
  id: string; chatId: string; status: 'queued' | 'running' | 'waiting_for_approval' | 'stopping' | 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'steered';
  accepted: boolean; text: string; assistantText: string; canStop: boolean; approval?: AgentApproval | null;
  // Whether a message sent now can join this reply. Missing when the server is too old to say.
  canSteer?: boolean;
  steerRequested?: boolean;
  // Latest plain-language progress line while it runs ("Searching the web").
  activity?: string | null;
  // Every step so far while it runs. Once it's done only the count rides along; the steps are fetched when opened.
  steps?: AgentStep[]; stepCount?: number;
  // When it started running and when it ended, for "Worked for 12 seconds".
  startedAt?: number | null; finishedAt?: number | null;
  // The reply this turn wrote.
  messageId?: string | null;
  createdAt: number; updatedAt: number;
};

const states = new Set(['queued', 'running', 'waiting_for_approval', 'stopping', 'completed', 'cancelled', 'failed', 'interrupted', 'steered']);
export function activeAgentTurn(turn: AgentTurn | null | undefined) {
  return !!turn && ['queued', 'running', 'waiting_for_approval', 'stopping'].includes(turn.status);
}
export function agentTurnLabel(turn: AgentTurn) {
  return turn.status === 'waiting_for_approval' ? 'Needs your OK' : turn.status === 'queued' ? 'Up next'
    : turn.status === 'stopping' ? 'Stopping' : turn.status === 'cancelled' ? 'Stopped'
      : turn.status === 'interrupted' ? 'Cut off before it finished' : turn.status === 'failed' ? "Couldn't finish. Try sending it again" : 'Working on it';
}
// The one line shown in the agent's in-progress message.
export function liveAgentLine(turn: AgentTurn | null | undefined, streamed?: string | null) {
  if (turn?.status === 'waiting_for_approval') return 'Waiting for your OK';
  if (turn?.status === 'stopping') return 'Stopping';
  return streamed || turn?.activity || 'Thinking';
}
export function agentTurnDetail(turn: AgentTurn) {
  return turn.status === 'waiting_for_approval' ? 'Paused until you decide'
    : turn.status === 'stopping' ? 'What it wrote so far stays here'
      : turn.status === 'queued' ? 'Starts when the agent is free'
        : "You can leave. It'll keep going";
}
export function parseApproval(value: unknown): AgentApproval | null {
  if (!value || typeof value !== 'object') return null;
  const a = value as Record<string, unknown>;
  if (typeof a.id !== 'string' || !a.id || typeof a.command !== 'string' || typeof a.description !== 'string') return null;
  return { id: a.id, command: a.command, description: a.description, choices: ['once', 'deny'] };
}
export function parseAgentTurn(value: unknown): AgentTurn | null {
  if (!value || typeof value !== 'object') return null;
  const t = value as Record<string, unknown>;
  if (typeof t.id !== 'string' || !t.id || typeof t.chatId !== 'string' || typeof t.status !== 'string' || !states.has(t.status)
    || typeof t.createdAt !== 'number' || typeof t.updatedAt !== 'number') return null;
  const steps = parseSteps(t.steps);
  return { id: t.id, chatId: t.chatId, status: t.status as AgentTurn['status'], accepted: t.accepted === true,
    text: typeof t.text === 'string' ? t.text : '', assistantText: typeof t.assistantText === 'string' ? t.assistantText : '',
    canStop: t.canStop === true, approval: parseApproval(t.approval), steerRequested: t.steerRequested === true,
    ...(typeof t.canSteer === 'boolean' ? { canSteer: t.canSteer } : {}),
    activity: typeof t.activity === 'string' && t.activity ? t.activity.slice(0, 80) : null,
    steps, stepCount: typeof t.stepCount === 'number' && t.stepCount > steps.length ? Math.floor(t.stepCount) : steps.length,
    startedAt: typeof t.startedAt === 'number' ? t.startedAt : null, finishedAt: typeof t.finishedAt === 'number' ? t.finishedAt : null,
    messageId: typeof t.messageId === 'string' && t.messageId ? t.messageId : null, createdAt: t.createdAt, updatedAt: t.updatedAt };
}
function parseSteps(value: unknown): AgentStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((s): AgentStep[] => !s || typeof s !== 'object' || typeof s.label !== 'string' || !s.label || typeof s.at !== 'number' ? []
    : [{ label: s.label.slice(0, 80), ...(typeof s.detail === 'string' && s.detail ? { detail: s.detail.slice(0, 200) } : {}), at: s.at }]);
}
// Copy spells out one to nine.
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const count = (n: number, unit: string) => `${WORDS[n] ?? n} ${unit}${n === 1 ? '' : 's'}`;
// A length of time the way a person would say it: "12 seconds", "one minute", "one hour and five minutes".
// Past a minute the seconds are dropped.
export function spokenDuration(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return count(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return count(minutes, 'minute');
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${count(hours, 'hour')} and ${count(rest, 'minute')}` : count(hours, 'hour');
}
// Beside the live line once it has been a while: "two minutes". Nothing in the first minute; the line itself
// shows it is alive, and a ticking counter is the opposite of calm.
export function workingFor(turn: AgentTurn | null | undefined, now: number) {
  const start = turn?.startedAt ?? turn?.steps?.[0]?.at;
  if (!start || now - start < 60_000) return '';
  return spokenDuration(Math.floor((now - start) / 60_000) * 60_000);
}
// What a finished reply keeps of its work: "Worked for 12 seconds". Null when the server didn't time it.
export function workedFor(turn: AgentTurn | null | undefined) {
  if (!turn || turn.status !== 'completed' || !turn.startedAt || !turn.finishedAt || turn.finishedAt < turn.startedAt) return null;
  return `Worked for ${spokenDuration(turn.finishedAt - turn.startedAt)}`;
}
// Plain "Thinking" gets more reassuring the longer a task runs; real activity lines are left alone.
export function patientLine(line: string, ms: number) {
  if (line !== 'Thinking') return line;
  return ms >= 60_000 ? 'Still working on it' : ms >= 20_000 ? 'Thinking it through' : line;
}
// The steps as a person would retell them. A step with something to show (a command, a file, a thought) is
// always kept. One with nothing to add is said once, where it first happened: "Thinking, Working on it,
// Writing", not the same two lines ten times over.
export function readableSteps(steps: AgentStep[]) {
  const said = new Set<string>();
  return steps.filter(step => { const repeat = said.has(step.label); said.add(step.label); return !!step.detail || !repeat; });
}
// Finished replies by the message they wrote, so each one can say how long it took.
export function workByMessage(turns: AgentTurn[]) {
  return new Map(turns.flatMap((t): [string, AgentTurn][] => t.messageId && workedFor(t) ? [[t.messageId, t]] : []));
}

// The server lists newest first. The reply in progress is the one turn that
// has started; everything still queued waits behind it, oldest first.
export function splitTurns(turns: AgentTurn[]) {
  const current = turns.find(t => ['running', 'waiting_for_approval', 'stopping'].includes(t.status))
    ?? turns.find(t => t.status !== 'queued' && t.status !== 'steered') ?? null;
  const waiting = turns.filter(t => t.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
  return { current, waiting };
}
// Waiting messages not already shown above (as the reply in progress or the
// chat's first message). A queued turn can be both while it's up next.
export function queuedBelow(waiting: AgentTurn[], shown: (AgentTurn | null | undefined)[]) {
  return waiting.filter(t => !shown.some(s => s?.id === t.id));
}
// A message sent while a reply is running joins that reply, so the agent reads it at its next step. Only text
// can: files wait and are sent after. A reply that is stopping, or hasn't started, or whose agent can't take a
// message mid-task (the server says so; an older server doesn't, and then it's worth asking) takes nothing.
export function joinsReply(current: AgentTurn | null | undefined, text: string, files = 0) {
  return !!current && (current.status === 'running' || current.status === 'waiting_for_approval') && current.canSteer !== false && !!text.trim() && !files;
}
// While this phone follows its own reply, its list isn't reloaded until that ends. A message the agent has read
// meanwhile still joins the conversation at once: above the reply in progress, where it will stay. Anything
// already shown (by id, or as this phone's own unconfirmed message) is left alone.
export function withRead<M extends { id: string; role: string; text?: string; pending?: boolean; localId?: string }>(shown: M[], history: M[]): M[] {
  const have = new Set(shown.map(m => m.id));
  const mine = new Set(shown.filter(m => m.role === 'user' && m.localId).map(m => m.text));
  const read = history.filter(m => m.role === 'user' && !have.has(m.id) && !mine.has(m.text));
  if (!read.length) return shown;
  const reply = shown.findLastIndex(m => m.role === 'assistant' && !!m.pending);
  return reply < 0 ? [...shown, ...read] : [...shown.slice(0, reply), ...read, ...shown.slice(reply)];
}
// The conversation, top to bottom: what's been said, the messages on their way into the reply in progress, that
// reply, then the messages waiting for it to finish. `said` may already end with this phone's own reply row.
export function inOrder<R>(said: R[], joining: R[], reply: R | null, waiting: R[], isLiveReply: (row: R) => boolean): R[] {
  const at = said.findLastIndex(isLiveReply);
  const before = at < 0 ? said : said.slice(0, at), live = at < 0 ? [] : said.slice(at);
  return [...before, ...joining, ...live, ...(reply ? [reply] : []), ...waiting];
}
