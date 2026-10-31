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

export async function startWorker({ directory, createServices, intervalMs = 250, log = console }) {
  const release = acquireWorkerLock(directory);
  const owner = crypto.randomUUID();
  let services;
  try {
    services = await createServices();
    const interrupted = services.messaging.recoverInterruptedJobs();
    if (interrupted) log.warn(`[servant] ${interrupted} interrupted agent job(s) require a new request; none were replayed`);
  } catch (error) {
    try { services?.push.close?.(); }
    finally {
      try { services?.messaging.close(); }
      finally { try { services?.closeState?.(); } finally { release(); } }
    }
    throw error;
  }
  const { messaging, push, closeState = () => {} } = services;
  let stopping = false;
  let agentTask = null;
  let notificationTask = null;
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
      await push.drain();
    }).catch(error => log.error('[servant] notification worker retrying:', error.message))
      .finally(() => { notificationTask = null; });
    return notificationTask;
  };
  const agentTimer = intervalMs > 0 ? setInterval(tickAgent, intervalMs) : null;
  const pushTimer = intervalMs > 0 ? setInterval(tickNotifications, Math.max(intervalMs, 1000)) : null;
  if (intervalMs > 0) { void tickAgent(); void tickNotifications(); }
  const shutdown = () => shutdownPromise ??= (async () => {
    stopping = true;
    clearInterval(agentTimer);
    clearInterval(pushTimer);
    try {
      await Promise.all([agentTask, notificationTask]);
      await messaging.whenIdle();
      messaging.drainOutbox(event => push.enqueue(event));
      await push.shutdown();
    } finally {
      try { push.close?.(); }
      finally {
        try { messaging.close(); }
        finally { try { closeState(); } finally { release(); } }
      }
    }
  })();
  return { owner, tickAgent, tickNotifications, shutdown };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.env.SERVANT_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
  process.umask(0o077);
  try {
    const { createWorkerServices } = await import('./server.mjs');
    const worker = await startWorker({ directory, createServices: createWorkerServices });
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
