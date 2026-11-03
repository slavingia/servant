// Negotiate the repository-owned bridge before using runs. Stock Hermes's runs
// API does not preserve the session stream's history/media behavior.
import { setTimeout as sleep } from 'node:timers/promises';
import { createMediaDeltaFilter } from './media.mjs';

const agentError = message => Object.assign(new Error(message), { code: 'agent_error' });
// What the agent reads mid-task. Files can't ride along, so only text steers.
export const steerText = steer => String(steer.text || '').trim();

export async function hermesRequest(up, method, pathname, body, extra = {}) {
  return fetch(new URL(pathname, up.url), { method,
    headers: { Authorization: `Bearer ${up.key}`, 'Content-Type': 'application/json', ...extra.headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: extra.signal });
}

export async function readHermesEvents(body, receive) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      let payload;
      try { payload = JSON.parse(data); } catch { continue; }
      const named = block.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
      await receive(named || payload.event || 'message', payload);
    }
    if (buffer.length > 64 * 1024 * 1024) throw agentError('Agent event is too large');
  }
}

export async function supportsDurableRuns(up) {
  try {
    const response = await hermesRequest(up, 'GET', '/v1/capabilities', undefined, { signal: AbortSignal.timeout(5000) });
    if (response.status === 404) return false;
    if (!response.ok) throw agentError('Agent capabilities are unavailable');
    const capabilities = await response.json();
    return capabilities?.features?.servant_durable_media_runs === true && capabilities?.features?.servant_exact_approvals === true;
  } catch (error) {
    // A transient probe failure must not silently downgrade a bridge to the
    // legacy transport and remove its Stop/approval behavior for this request.
    throw error?.code === 'agent_error' ? error : agentError('Agent capabilities are unavailable');
  }
}

// Bridges from before steering keep queueing; messages just wait their turn.
export async function supportsSteer(up) {
  try {
    const response = await hermesRequest(up, 'GET', '/v1/capabilities', undefined, { signal: AbortSignal.timeout(5000) });
    return response.ok && (await response.json())?.features?.servant_steer === true;
  } catch { return false; }
}

export async function runDurableHermes({ up, sessionId, input, sessionKey, runId, onAccepted, onEvent, checkpoint, controls, steered = () => {}, canSteer = false, pollMs = 500 }) {
  if (!runId) {
    const response = await hermesRequest(up, 'POST', '/v1/runs', {
      session_id: sessionId, input: [{ role: 'user', content: input }],
    }, { headers: { 'X-Hermes-Session-Key': sessionKey } });
    if (!response.ok) throw agentError(`Could not start agent (${response.status})`);
    const data = await response.json();
    if (typeof data.run_id !== 'string' || !data.run_id) throw agentError('Agent did not identify its run');
    runId = data.run_id;
    checkpoint(runId);
    try { await onAccepted(); }
    catch (error) {
      await hermesRequest(up, 'POST', `/v1/runs/${encodeURIComponent(runId)}/stop`).catch(() => {});
      throw error;
    }
  }
  const route = `/v1/runs/${encodeURIComponent(runId)}`;
  const streamAbort = new AbortController();
  const filter = createMediaDeltaFilter();
  let terminal, final = '', eventError, unread = '', usage = null;
  const seenApprovals = new Set([controls().approval?.id].filter(Boolean));
  const receive = async (name, payload) => {
    if (terminal) return;
    if (name === 'message.delta') {
      const text = filter(payload.delta || '');
      if (text) onEvent('assistant.delta', { delta: text });
    } else if (name === 'tool.started') onEvent(name, { tool_name: payload.tool });
    else if (name === 'approval.request') {
      if (!payload.approval_id || seenApprovals.has(payload.approval_id)) return;
      seenApprovals.add(payload.approval_id);
      onEvent(name, payload);
    }
    else if (name === 'run.completed') {
      const tail = filter('', true);
      if (tail) onEvent('assistant.delta', { delta: tail });
      final = payload.output || '';
      if (payload.usage && typeof payload.usage === 'object') usage = payload.usage;
      onEvent('assistant.completed', { content: final });
      terminal = 'completed';
    } else if (name === 'run.cancelled') terminal = 'cancelled';
    else if (name === 'run.failed') terminal = 'failed';
  };
  // This subscription belongs to the Mac worker, never the phone/API process.
  // If it is unavailable after a worker restart, poll the existing run; do not
  // resubmit the prompt or replay tool effects.
  const events = (async () => {
    const response = await hermesRequest(up, 'GET', `${route}/events`, undefined, { signal: streamAbort.signal });
    if (response.ok && response.body) await readHermesEvents(response.body, async (name, payload) => {
      try { await receive(name, payload); } catch (error) { eventError = error; throw error; }
    });
  })().catch(() => { /* Status is authoritative if the event connection drops. */ });
  let stopped = false, answeredApproval;
  const delivered = new Map(); // turn id -> exact text Hermes accepted
  try {
    while (!terminal) {
      try {
      const control = controls();
      if (control.stop && !stopped) {
        const response = await hermesRequest(up, 'POST', `${route}/stop`, undefined, { signal: AbortSignal.timeout(15000) });
        if (response.ok || response.status === 409) stopped = true;
      }
      if (!control.stop && !controls().stop && control.choice && control.approval && answeredApproval !== control.approval.id) {
        const response = await hermesRequest(up, 'POST', `${route}/approval`, { approval_id: control.approval.id, choice: control.choice }, { signal: AbortSignal.timeout(15000) });
        if (response.ok || response.status === 409) {
          answeredApproval = control.approval.id;
          onEvent('approval.responded', { approvalId: control.approval.id, choice: control.choice });
        }
      }
      // Steers ride the bridge-owned approval route ({ steer }), so stock
      // Hermes never receives them; without the capability they stay queued.
      for (const steer of canSteer && !control.stop ? control.steers || [] : []) {
        if (delivered.has(steer.id)) continue;
        const text = steerText(steer);
        const sent = await hermesRequest(up, 'POST', `${route}/approval`, { steer: text, steer_id: steer.id }, { signal: AbortSignal.timeout(15000) });
        if (sent.ok) { delivered.set(steer.id, text); steered(steer.id); }
        else if (sent.status === 409) break; // run is finishing: leave it queued for next
      }
      const response = await hermesRequest(up, 'GET', route, undefined, { signal: AbortSignal.timeout(15000) });
      if (response.status === 404) throw Object.assign(agentError('The agent no longer has this run'), { code: 'run_lost' });
      if (!response.ok) throw new Error('Agent status temporarily unavailable');
      const status = await response.json();
      if (typeof status.unread_steer === 'string') unread = status.unread_steer;
      if (status.status === 'waiting_for_approval' && status.pending_approval) await receive('approval.request', status.pending_approval);
      if (status.status === 'completed') {
        if (!usage && status.usage && typeof status.usage === 'object') usage = status.usage;
        await receive('run.completed', status);
      }
      else if (status.status === 'cancelled') terminal = 'cancelled';
      else if (status.status === 'failed') terminal = 'failed';
      // If an SSE event is malformed/fails persistence, stop instead of losing
      // the approval or running indefinitely with an unjournaled response.
      if (eventError) {
        await hermesRequest(up, 'POST', `${route}/stop`, undefined, { signal: AbortSignal.timeout(15000) }).catch(() => {});
        throw eventError;
      }
      } catch (error) {
        if (error === eventError || error?.code === 'run_lost' || error?.code === 'agent_error') throw error;
        // The existing run may still be executing tools. Keep its active slot
        // and retry reads/ID-bound controls, never launch the prompt again.
      }
      if (!terminal) await sleep(pollMs);
    }
    // Events can report completion before the status poll sees unread steers.
    if (delivered.size && !unread) {
      try {
        const response = await hermesRequest(up, 'GET', route, undefined, { signal: AbortSignal.timeout(15000) });
        const status = response.ok ? await response.json() : {};
        if (typeof status.unread_steer === 'string') unread = status.unread_steer;
      } catch { /* unknown: treat delivered steers as read */ }
    }
    if (terminal === 'failed') throw agentError('The agent failed');
    // Hermes hands back any steer it never read. Those messages run next.
    const unreadSteers = [...delivered].filter(([, text]) => unread && unread.includes(text)).map(([id]) => id);
    return { answer: final, status: terminal, unreadSteers, usage };
  } finally {
    streamAbort.abort();
    await events;
  }
}
