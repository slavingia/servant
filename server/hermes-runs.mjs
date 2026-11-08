// Negotiate the repository-owned bridge before using runs. Stock Hermes's runs
// API does not preserve the session stream's history/media behavior.
import { setTimeout as sleep } from 'node:timers/promises';
import { createMediaDeltaFilter } from './media.mjs';
import { createCloseMarkerFilter, stripCloseMarker } from './close-marker.mjs';

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

// Run keys: Servant names a run before starting it, so the run can be found or
// stopped by that name even if the "run created" reply is lost or late. Purpose
// chats require them; a failed probe counts as unsupported (they fail closed).
export async function supportsRunKeys(up) {
  try {
    const response = await hermesRequest(up, 'GET', '/v1/capabilities', undefined, { signal: AbortSignal.timeout(5000) });
    return response.ok && (await response.json())?.features?.servant_run_keys === true;
  } catch { return false; }
}
export const RUN_KEY_HEADER = 'X-Servant-Run-Key';
export const runKeyFor = turnId => `servant_${String(turnId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)}`;
const keyRoute = key => `/v1/runs/servant-key.${encodeURIComponent(key)}`;
/** The bridge's record of a run key, or null when it has none. */
export async function runKeyStatus(up, key, signal) {
  const response = await hermesRequest(up, 'GET', keyRoute(key), undefined, { signal: signal ?? AbortSignal.timeout(2000) });
  if (response.status === 404) return null;
  if (!response.ok) throw agentError(`Run key status unavailable (${response.status})`);
  return response.json();
}
/**
 * Stops whatever a run key started, or makes sure it never starts, and
 * confirms it: polls the key until the bridge reports nothing can run.
 * Bounded; returns whether the stop was confirmed.
 */
export async function stopRunByKey(up, key, { timeoutMs = 10000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const left = () => AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - Date.now())));
  let asked = false;
  while (Date.now() < deadline) {
    if (!asked) {
      const response = await hermesRequest(up, 'POST', `${keyRoute(key)}/stop`, undefined, { signal: left() }).catch(() => null);
      if (response?.ok) {
        asked = true;
        const data = await response.json().catch(() => ({}));
        if (data.stopped === true) return true;
      }
    } else {
      const status = await runKeyStatus(up, key, left()).catch(() => undefined);
      // null: the bridge holds nothing for this key (it restarted), so nothing runs.
      if (status === null || status?.stopped === true) return true;
    }
    await sleep(pollMs);
  }
  return false;
}

// Bridges from before steering keep queueing; messages just wait their turn.
export async function supportsSteer(up) {
  try {
    const response = await hermesRequest(up, 'GET', '/v1/capabilities', undefined, { signal: AbortSignal.timeout(5000) });
    return response.ok && (await response.json())?.features?.servant_steer === true;
  } catch { return false; }
}

// `signal` ends the run from outside (access was revoked). Every wait races it,
// so even a silent agent is abandoned at once: the run is told to stop, and
// nothing it says afterwards is passed on.
const within = (ms, signal) => signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms);
// Hermes 0.22 adds 'interrupted' (the gateway restarted before the run settled).
const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'expired', 'interrupted']);

/**
 * Stops a run and confirms it: asks the bridge to stop, then polls its status
 * until the bridge reports it ended (or no longer holds it). Bounded; returns
 * whether the stop was confirmed.
 */
export async function stopRunVerified(up, runId, { timeoutMs = 10000, pollMs = 250 } = {}) {
  const route = `/v1/runs/${encodeURIComponent(runId)}`;
  const deadline = Date.now() + timeoutMs;
  let asked = false;
  while (Date.now() < deadline) {
    if (!asked) {
      const response = await hermesRequest(up, 'POST', `${route}/stop`, undefined, { signal: AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - Date.now()))) }).catch(() => null);
      if (response?.status === 404) return true;
      asked = !!response && (response.ok || response.status === 409);
    }
    if (asked) {
      const status = await hermesRequest(up, 'GET', route, undefined, { signal: AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - Date.now()))) }).catch(() => null);
      if (status?.status === 404) return true;
      if (status?.ok) {
        const data = await status.json().catch(() => ({}));
        if (TERMINAL.has(data.status)) return true;
      }
    }
    await sleep(pollMs);
  }
  return false;
}

/**
 * Starts a run under `runKey`. The start isn't waited on past a revocation: on
 * abort the key is stopped at once, which stops the run if it exists or makes
 * sure it never starts. A lost or failed reply is looked up by key; if no run
 * turns up, the key is stopped, so nothing is left running.
 */
async function startKeyedRun({ up, runKey, body, sessionKey, signal }) {
  const revoked = async () => ({ revoked: true, stopConfirmed: await stopRunByKey(up, runKey) });
  let response = null;
  try {
    response = await hermesRequest(up, 'POST', '/v1/runs', body, { headers: { 'X-Hermes-Session-Key': sessionKey, [RUN_KEY_HEADER]: runKey }, signal: within(60000, signal) });
  } catch { if (signal?.aborted) return revoked(); }
  let id = null;
  if (response) {
    const data = await response.json().catch(() => ({}));
    if (response.ok && typeof data.run_id === 'string' && data.run_id) id = data.run_id;
    // Already started under this key (a worker restarted mid-start): use that run.
    else if (response.status === 409 && data?.error?.code === 'run_key_in_use' && typeof data.run_id === 'string' && data.run_id) id = data.run_id;
  }
  if (signal?.aborted) return revoked();
  // Lost, late, cut off or failed on the bridge's side: it may have started the run anyway.
  if (!id && (!response || response.ok || response.status >= 500)) {
    // The reply was lost or late: the bridge may have started it anyway.
    const deadline = Date.now() + 15000;
    while (!id && Date.now() < deadline && !signal?.aborted) {
      const status = await runKeyStatus(up, runKey, within(2000, signal)).catch(() => undefined);
      if (status?.run_id) id = status.run_id;
      else if (status === null || ['refused', 'not_started'].includes(status?.state)) break;
      else await sleep(250, undefined, { signal }).catch(() => {});
    }
    if (signal?.aborted) return revoked();
  }
  if (!id) {
    const stopped = await stopRunByKey(up, runKey);
    // A clear refusal (busy, bad request) keeps its own reason; nothing started.
    if (response && response.status >= 400 && response.status < 500 && response.status !== 409) throw agentError(`Could not start agent (${response.status})`);
    throw agentError(stopped
      ? "The agent didn't confirm it started, so nothing was left running. Try again"
      : "The agent didn't confirm it started, and couldn't confirm nothing is running");
  }
  return { runId: id };
}

export async function runDurableHermes({ up, sessionId, input, sessionKey, instructions = '', runId, runKey, onAccepted, onEvent, checkpoint, controls, steered = () => {}, canSteer = false, pollMs = 500, signal }) {
  if (!runId && runKey) {
    signal?.throwIfAborted();
    const started = await startKeyedRun({ up, runKey, sessionKey, signal,
      body: { session_id: sessionId, input: [{ role: 'user', content: input }], ...(instructions ? { instructions } : {}) } });
    if (started.revoked) return { answer: '', status: 'revoked', unreadSteers: [], usage: null, runId: null, runKey, stopConfirmed: started.stopConfirmed };
    runId = started.runId;
    checkpoint(runId);
    if (signal?.aborted) {
      const stopped = await stopRunVerified(up, runId);
      return { answer: '', status: 'revoked', unreadSteers: [], usage: null, runId, stopConfirmed: stopped };
    }
    try { await onAccepted(); }
    catch (error) {
      // Access changed (or the handoff did) right after the start: stop the run and confirm it.
      if (!await stopRunVerified(up, runId).catch(() => false)) console.error(`[servant] run ${runId} was refused after it started, and its stop wasn't confirmed`);
      throw error;
    }
  }
  if (!runId) {
    // Bridges without run keys: the reply carries the only handle on the run.
    signal?.throwIfAborted();
    // Creation is not abandoned midway: once the bridge may have accepted the
    // run, its ID is needed to stop it. If access changes while the reply is
    // on its way, the run is stopped (and the stop confirmed) as soon as the
    // ID arrives, so no run is left behind.
    const response = await hermesRequest(up, 'POST', '/v1/runs', {
      session_id: sessionId, input: [{ role: 'user', content: input }], ...(instructions ? { instructions } : {}),
    }, { headers: { 'X-Hermes-Session-Key': sessionKey }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw agentError(`Could not start agent (${response.status})`);
    const data = await response.json();
    if (typeof data.run_id !== 'string' || !data.run_id) throw agentError('Agent did not identify its run');
    runId = data.run_id;
    checkpoint(runId);
    if (signal?.aborted) {
      const stopped = await stopRunVerified(up, runId);
      return { answer: '', status: 'revoked', unreadSteers: [], usage: null, runId, stopConfirmed: stopped };
    }
    try { await onAccepted(); }
    catch (error) {
      // Access changed (or the handoff did) right after the start: stop the run and confirm it.
      if (!await stopRunVerified(up, runId).catch(() => false)) console.error(`[servant] run ${runId} was refused after it started, and its stop wasn't confirmed`);
      throw error;
    }
  }
  const route = `/v1/runs/${encodeURIComponent(runId)}`;
  const streamAbort = new AbortController();
  const media = createMediaDeltaFilter(), closer = createCloseMarkerFilter();
  const filter = (chunk, end = false) => closer(media(chunk, end), end);
  let terminal, final = '', eventError, unread = '', usage = null;
  const seenApprovals = new Set([controls().approval?.id].filter(Boolean));
  const receive = async (name, payload) => {
    if (terminal || signal?.aborted) return;
    if (name === 'message.delta') {
      const text = filter(payload.delta || '');
      if (text) onEvent('assistant.delta', { delta: text });
    } else if (name === 'tool.started') onEvent(name, { tool_name: payload.tool, preview: payload.preview });
    // Tool results never leave this worker. The tool's argument preview and a
    // short reasoning excerpt do, for the owner's progress details only.
    else if (name === 'reasoning.available') onEvent(name, { text: payload.text });
    else if (name === 'tool.completed') onEvent(name, {});
    else if (name === 'approval.request') {
      if (!payload.approval_id || seenApprovals.has(payload.approval_id)) return;
      seenApprovals.add(payload.approval_id);
      onEvent(name, payload);
    }
    else if (name === 'run.completed') {
      const tail = filter('', true);
      if (tail) onEvent('assistant.delta', { delta: tail });
      final = stripCloseMarker(payload.output || '');
      if (payload.usage && typeof payload.usage === 'object') usage = payload.usage;
      onEvent('assistant.completed', { content: final });
      terminal = 'completed';
    } else if (name === 'run.cancelled') terminal = 'cancelled';
    else if (name === 'run.failed') terminal = 'failed';
  };
  // This subscription belongs to the Mac worker, never the phone/API process.
  // If it is unavailable after a worker restart, poll the existing run; do not
  // resubmit the prompt or replay tool effects.
  // After a worker restart the bridge may refuse a second subscriber (older
  // bridges) or the connection may drop: keep retrying while polling status,
  // and show progress from the polled status so the chat never looks frozen.
  let streaming = false, subscribing = false, lastPolledEvent = null, nextSubscribe = Date.now() + 10000;
  const abandon = () => streamAbort.abort();
  signal?.addEventListener('abort', abandon, { once: true });
  const subscribe = async () => {
    subscribing = true;
    try {
      const response = await hermesRequest(up, 'GET', `${route}/events`, undefined, { signal: streamAbort.signal });
      if (!response.ok || !response.body) return;
      streaming = true;
      await readHermesEvents(response.body, async (name, payload) => {
        try { await receive(name, payload); } catch (error) { eventError = error; throw error; }
      });
    } catch { /* Status is authoritative if the event connection drops. */ }
    finally { streaming = false; subscribing = false; }
  };
  let events = subscribe();
  let stopped = false, answeredApproval, stopConfirmed = false;
  const delivered = new Map(); // turn id -> exact text Hermes accepted
  try {
    while (!terminal) {
      if (signal?.aborted) {
        stopConfirmed = await stopRunVerified(up, runId);
        terminal = 'revoked';
        break;
      }
      try {
      const control = controls();
      if (control.stop && !stopped) {
        const response = await hermesRequest(up, 'POST', `${route}/stop`, undefined, { signal: within(15000, signal) });
        if (response.ok || response.status === 409) stopped = true;
        // The bridge no longer holds this run's agent, so it can't be
        // interrupted. Stop waiting for it: the person asked to stop.
        else if (response.status === 404) { terminal = 'cancelled'; break; }
      }
      if (!control.stop && !controls().stop && control.choice && control.approval && answeredApproval !== control.approval.id) {
        const response = await hermesRequest(up, 'POST', `${route}/approval`, { approval_id: control.approval.id, choice: control.choice }, { signal: within(15000, signal) });
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
        const sent = await hermesRequest(up, 'POST', `${route}/approval`, { steer: text, steer_id: steer.id }, { signal: within(15000, signal) });
        if (sent.ok) { delivered.set(steer.id, text); steered(steer.id); }
        else if (sent.status === 409) break; // run is finishing: leave it queued for next
      }
      const response = await hermesRequest(up, 'GET', route, undefined, { signal: within(15000, signal) });
      if (response.status === 404) throw Object.assign(agentError('The agent no longer has this run'), { code: 'run_lost' });
      if (!response.ok) throw new Error('Agent status temporarily unavailable');
      const status = await response.json();
      if (typeof status.unread_steer === 'string') unread = status.unread_steer;
      if (!streaming && !terminal) {
        // No live events: progress comes from the polled status instead.
        if (status.last_event && status.last_event !== lastPolledEvent) {
          lastPolledEvent = status.last_event;
          if (status.last_event === 'tool.started') onEvent('tool.started', { tool_name: status.last_tool || '' });
          else if (status.last_event === 'tool.completed' || status.last_event === 'reasoning.available') onEvent('tool.completed', {});
        }
        if (!subscribing && Date.now() >= nextSubscribe) { nextSubscribe = Date.now() + 10000; events = subscribe(); }
      }
      if (status.status === 'waiting_for_approval' && status.pending_approval) await receive('approval.request', status.pending_approval);
      if (status.status === 'completed') {
        if (!usage && status.usage && typeof status.usage === 'object') usage = status.usage;
        await receive('run.completed', status);
      }
      else if (status.status === 'cancelled') terminal = 'cancelled';
      else if (status.status === 'failed') terminal = 'failed';
      // The bridge restarted (or dropped the run) before it settled: the answer is incomplete.
      else if (status.status === 'interrupted' || status.status === 'expired') throw Object.assign(agentError('The agent restarted before this answer finished'), { code: 'run_lost' });
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
      if (!terminal) await sleep(pollMs, undefined, { signal }).catch(() => {});
    }
    if (terminal === 'revoked') return { answer: '', status: 'revoked', unreadSteers: [], usage, runId, stopConfirmed };
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
    signal?.removeEventListener('abort', abandon);
    streamAbort.abort();
    await events;
  }
}
