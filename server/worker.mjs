#!/usr/bin/env node
// Independent durable channel-agent and push worker. API deployments leave this
// process running; a worker upgrade waits for its current turn before exiting.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// Keep ownership alive even if a caller does not retain its release callback.
// Otherwise native connection finalization could silently relinquish the lock.
const heldWorkerLocks = new Set();

export function acquireWorkerLock(directory) {
  const previous = process.umask(0o077);
  let db;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    db = new DatabaseSync(path.join(directory, 'worker-lock.db'));
    db.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS worker_lock (id INTEGER PRIMARY KEY)');
    // This dedicated database is not used by API requests. A reserved SQLite
    // lock is held for the worker's lifetime, and released by the OS on death.
    // No expiry or PID reuse can let two live workers own external side effects.
    db.exec('BEGIN IMMEDIATE');
    heldWorkerLocks.add(db);
  } catch (error) {
    db?.close();
    throw new Error('Another Servant worker owns this data directory, or its worker lock is unavailable', { cause: error });
  } finally { process.umask(previous); }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { db.exec('ROLLBACK'); }
    finally { try { db.close(); } finally { heldWorkerLocks.delete(db); } }
  };
}

export async function startWorker({ directory, createServices, intervalMs = 250, closerMs = 60 * 60 * 1000, closerIdleMs, log = console }) {
  const release = acquireWorkerLock(directory);
  const owner = crypto.randomUUID();
  let services;
  try {
    services = await createServices();
    const interrupted = services.messaging.recoverInterruptedJobs();
    if (interrupted) log.warn(`[servant] ${interrupted} interrupted agent job(s) require a new request; none were replayed`);
    const privateTurns = services.agentTurns?.recoverInterrupted();
    if (privateTurns) log.warn(`[servant] recovered ${privateTurns} private turn(s); existing Hermes runs resume without replaying prompts`);
  } catch (error) {
    try { services?.push.close?.(); }
    finally {
      try { services?.agentTurns?.close(); services?.messaging.close(); }
      finally { try { services?.closeState?.(); } finally { release(); } }
    }
    throw error;
  }
  const { messaging, push, agentTurns, closeIdleChats, closeState = () => {} } = services;
  let stopping = false;
  let agentTask = null;
  let notificationTask = null;
  const privateTasks = new Set();
  let closerTask = null;
  let shutdownPromise;
  const tickAgent = () => {
    if (stopping || agentTask) return agentTask || Promise.resolve(false);
    agentTask = messaging.processAgentJob(owner).catch(error => {
      log.error('[servant] channel agent job interrupted:', error.message);
      return false;
    }).finally(() => { agentTask = null; });
    return agentTask;
  };
  const tickNotifications = () => {
    if (stopping || notificationTask) return notificationTask || Promise.resolve();
    notificationTask = Promise.resolve().then(async () => {
      messaging.drainOutbox(event => push.enqueue(event));
      agentTurns?.drainOutbox(event => push.enqueue(event));
      await push.drain();
    }).catch(error => log.error('[servant] notification worker retrying:', error.message))
      .finally(() => { notificationTask = null; });
    return notificationTask;
  };
  const tickPrivate = () => {
    if (stopping || !agentTurns) return Promise.resolve(false);
    const task = agentTurns.processNext().catch(error => {
      log.error('[servant] private agent turn interrupted:', error.message);
      return false;
    }).finally(() => { privateTasks.delete(task); });
    privateTasks.add(task);
    return task;
  };
  // Hourly: close finished chats nobody has come back to (see closeIdleChats).
  const tickCloser = () => {
    if (stopping || !closeIdleChats || closerTask) return closerTask || Promise.resolve([]);
    closerTask = closeIdleChats({ log, ...(closerIdleMs !== undefined ? { idleMs: closerIdleMs } : {}) }).then(closed => {
      if (closed.length) log.log(`[servant] closer closed ${closed.length} finished chat(s)`);
      return closed;
    }, error => { log.error('[servant] closer retrying:', error.message); return []; })
      .finally(() => { closerTask = null; });
    return closerTask;
  };
  const closerTimer = intervalMs > 0 && closerMs > 0 ? setInterval(tickCloser, closerMs) : null;
  closerTimer?.unref?.();
  const agentTimer = intervalMs > 0 ? setInterval(tickAgent, intervalMs) : null;
  const privateTimer = intervalMs > 0 ? setInterval(tickPrivate, intervalMs) : null;
  const pushTimer = intervalMs > 0 ? setInterval(tickNotifications, Math.max(intervalMs, 1000)) : null;
  if (intervalMs > 0) { void tickAgent(); void tickPrivate(); void tickNotifications(); }
  const shutdown = () => shutdownPromise ??= (async () => {
    stopping = true;
    clearInterval(agentTimer);
    clearInterval(privateTimer);
    clearInterval(pushTimer);
    clearInterval(closerTimer);
    try {
      await Promise.all([agentTask, notificationTask, closerTask, ...privateTasks]);
      await agentTurns?.whenIdle();
      await messaging.whenIdle();
      messaging.drainOutbox(event => push.enqueue(event));
      agentTurns?.drainOutbox(event => push.enqueue(event));
      await push.shutdown();
    } finally {
      try { push.close?.(); }
      finally {
        try { agentTurns?.close(); messaging.close(); }
        finally { try { closeState(); } finally { release(); } }
      }
    }
  })();
  return { owner, tickAgent, tickPrivate, tickNotifications, tickCloser, shutdown };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.env.SERVANT_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
  process.umask(0o077);
  try {
    const { createWorkerServices } = await import('./server.mjs');
    // Test instances shorten the closer's hour/day; production uses the defaults.
    const ms = name => process.env[name] ? Number(process.env[name]) : undefined;
    const worker = await startWorker({ directory, createServices: createWorkerServices,
      ...(ms('SERVANT_CLOSER_MS') !== undefined ? { closerMs: ms('SERVANT_CLOSER_MS') } : {}), closerIdleMs: ms('SERVANT_CLOSER_IDLE_MS') });
    console.log('[servant] durable worker ready');
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      console.log('[servant] worker finishing current work');
      worker.shutdown().then(() => process.exit(0), error => {
        console.error('[servant] worker shutdown failed:', error.message);
        process.exit(1);
      });
    });
  } catch (error) {
    console.error('[servant] worker could not start:', error.message);
    process.exitCode = 1;
  }
}
