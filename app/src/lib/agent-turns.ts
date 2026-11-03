export type AgentApproval = { id: string; command: string; description: string; choices: ('once' | 'deny')[] };
export type AgentTurn = {
  id: string; chatId: string; status: 'queued' | 'running' | 'waiting_for_approval' | 'stopping' | 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'steered';
  accepted: boolean; text: string; assistantText: string; canStop: boolean; approval?: AgentApproval | null;
  steerRequested?: boolean;
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
  return { id: t.id, chatId: t.chatId, status: t.status as AgentTurn['status'], accepted: t.accepted === true,
    text: typeof t.text === 'string' ? t.text : '', assistantText: typeof t.assistantText === 'string' ? t.assistantText : '',
    canStop: t.canStop === true, approval: parseApproval(t.approval), steerRequested: t.steerRequested === true, createdAt: t.createdAt, updatedAt: t.updatedAt };
}

// The server lists newest first. The reply in progress is the one turn that
// has started; everything still queued waits behind it, oldest first.
export function splitTurns(turns: AgentTurn[]) {
  const current = turns.find(t => ['running', 'waiting_for_approval', 'stopping'].includes(t.status))
    ?? turns.find(t => t.status !== 'queued' && t.status !== 'steered') ?? null;
  const waiting = turns.filter(t => t.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
  return { current, waiting };
}
// Steer folds a waiting message into the reply in progress. Only text can be
// steered, and only while a reply is actually running.
export function canSteer(waiting: AgentTurn, current: AgentTurn | null) {
  return !!current && ['running', 'waiting_for_approval'].includes(current.status) && !waiting.steerRequested && !!waiting.text.trim();
}
