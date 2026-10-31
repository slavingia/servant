export type AgentApproval = { id: string; command: string; description: string; choices: ('once' | 'deny')[] };
export type AgentTurn = {
  id: string; chatId: string; status: 'queued' | 'running' | 'waiting_for_approval' | 'stopping' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  accepted: boolean; text: string; assistantText: string; canStop: boolean; approval?: AgentApproval | null;
  createdAt: number; updatedAt: number;
};

const states = new Set(['queued', 'running', 'waiting_for_approval', 'stopping', 'completed', 'cancelled', 'failed', 'interrupted']);
export function activeAgentTurn(turn: AgentTurn | null | undefined) {
  return !!turn && ['queued', 'running', 'waiting_for_approval', 'stopping'].includes(turn.status);
}
export function agentTurnLabel(turn: AgentTurn) {
  return turn.status === 'waiting_for_approval' ? 'Needs your approval' : turn.status === 'queued' ? 'Waiting for the agent'
    : turn.status === 'stopping' ? 'Stopping…' : turn.status === 'cancelled' ? 'Stopped'
      : turn.status === 'interrupted' ? 'Interrupted — the saved reply is below' : turn.status === 'failed' ? 'The agent could not finish' : 'Working on your reply';
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
    canStop: t.canStop === true, approval: parseApproval(t.approval), createdAt: t.createdAt, updatedAt: t.updatedAt };
}
