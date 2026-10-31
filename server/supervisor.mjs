#!/usr/bin/env node
// Stable loopback ingress and private, serialized API release switching.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const DEPLOYMENT_PROTOCOL = 1;
export const validReleaseId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id);
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

export function verifyRelease(runtimeDir, id) {
  if (!validReleaseId(id)) throw problem('Invalid release ID');
  const directory = path.join(runtimeDir, 'releases', id);
  if (fs.lstatSync(directory).isSymbolicLink()) throw problem('Release directories cannot be symlinks');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.id !== id || manifest.deploymentProtocol !== DEPLOYMENT_PROTOCOL || !manifest.files ||
      typeof manifest.files !== 'object' || Array.isArray(manifest.files) || !manifest.files['server.mjs']) {
    throw problem('Unsupported or invalid release manifest');
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(mjs|json)$/.test(name) || name === 'manifest.json' || !/^[0-9a-f]{64}$/.test(expected)) {
      throw problem('Invalid release file manifest');
    }
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || sha(fs.readFileSync(file)) !== expected) throw problem(`Release checksum mismatch: ${name}`);
  }
  const actual = fs.readdirSync(directory).filter(name => name !== 'manifest.json').sort();
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(manifest.files).sort())) throw problem('Release contains unmanifested files');
  return { directory, manifest };
}

function filteredHeaders(headers) {
  const result = { ...headers };
  const nominated = String(headers.connection || '').split(',').map(value => value.trim().toLowerCase());
  for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...nominated]) delete result[name];
  return result;
}

async function requestJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw problem('Control request too large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { throw problem('Invalid control JSON'); }
}

export async function startSupervisor({ runtimeDir, dataDir, host = '127.0.0.1', port = 8787,
  initialRelease, candidateTimeoutMs = 30000, maxRetiring = 3, node = process.execPath, childEnv = {},
  log = console, restartDelayMs = 500 } = {}) {
  if (!runtimeDir || !dataDir) throw new Error('runtimeDir and dataDir are required');
  runtimeDir = path.resolve(runtimeDir); dataDir = path.resolve(dataDir);
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('Supervisor must bind a loopback address');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid supervisor port');
  if (!Number.isSafeInteger(candidateTimeoutMs) || candidateTimeoutMs < 1) throw new Error('Invalid candidate timeout');
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeDir, 0o700);
  fs.mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true, mode: 0o700 });
  const stateFile = path.join(runtimeDir, 'deployment.json');
  const socketPath = path.join(runtimeDir, 'control.sock');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let active = null, previous = saved.previousRelease || null, operation = null, stopping = false;
  let restartTimer, closePromise;
  const children = new Set();
  const retiring = new Set();
  const persist = (release, previousRelease) => {
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, activeRelease: release, previousRelease, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  };
  const status = () => ({
    active: active && { release: active.release, pid: active.child.pid, port: active.port, inFlight: active.inFlight, ready: !active.exited },
    previousRelease: previous,
    retiring: [...retiring].map(record => ({ release: record.release, pid: record.child.pid, inFlight: record.inFlight, signaled: record.signaled })),
    deploying: !!operation, stopping,
  });

  const maybeStop = record => {
    if (record.retiring && record.inFlight === 0 && !record.signaled && !record.exited) {
      record.signaled = true;
      record.child.kill('SIGTERM'); // API waits indefinitely for accepted work.
    }
  };
  const retire = record => {
    if (!record || record.exited || record.retiring) return;
    record.retiring = true;
    retiring.add(record);
    // Close only infinite event feeds first. Keep the listener accepting work
    // already dispatched by this proxy until all finite responses have ended.
    if (record.child.connected) record.child.send({ type: 'drain-events' }, () => {});
    maybeStop(record);
  };

  function launch(release) {
    const { directory } = verifyRelease(runtimeDir, release);
    const logFd = fs.openSync(path.join(runtimeDir, 'logs', `${release}.log`), 'a', 0o600);
    const child = spawn(node, [path.join(directory, 'server.mjs')], {
      cwd: directory,
      env: { ...process.env, ...childEnv, SERVANT_DATA_DIR: dataDir, SERVANT_HOST: '127.0.0.1', SERVANT_PORT: '0',
        SERVANT_RELEASE_ID: release, SERVANT_DEPLOY_PROTOCOL: String(DEPLOYMENT_PROTOCOL), SERVANT_WORKER_MODE: 'external', SERVANT_SHUTDOWN_TIMEOUT_MS: '0' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const record = { release, child, port: null, inFlight: 0, retiring: false, signaled: false, exited: false };
    children.add(record);
    let output = '';
    const consume = chunk => {
      fs.writeSync(logFd, chunk);
      output = (output + chunk.toString()).slice(-16384);
      const match = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) record.port = Number(match[1]);
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.on('error', () => { /* completion and candidate checks report startup failure */ });
    record.done = new Promise(resolve => child.once('close', (code, signal) => {
      record.exited = true;
      record.exitCode = code;
      children.delete(record); retiring.delete(record); fs.closeSync(logFd);
      resolve({ code, signal });
      if (active === record && !stopping) {
        log.error('[servant] active API exited; restarting its release');
        scheduleRestart(record.release);
      }
    }));
    return record;
  }

  async function discard(record) {
    if (!record || record.exited) return;
    // Candidates were never routed traffic and do not run workers.
    record.child.kill('SIGTERM');
    const timer = setTimeout(() => { if (!record.exited) record.child.kill('SIGKILL'); }, 1000);
    try { await record.done; } finally { clearTimeout(timer); }
  }

  async function candidate(release) {
    const record = launch(release);
    const deadline = Date.now() + candidateTimeoutMs;
    try {
      while (!record.exited && Date.now() < deadline && !stopping) {
        if (record.port) {
          try {
            const response = await fetch(`http://127.0.0.1:${record.port}/ready`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
            const body = await response.json();
            if (response.ok && body.ok === true && body.release === release && body.deploymentProtocol === DEPLOYMENT_PROTOCOL) {
              const health = await fetch(`http://127.0.0.1:${record.port}/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
              const data = await health.json();
              if (health.ok && data.ok === true && !record.exited) return record;
            }
          } catch { /* Candidate may still be initializing. */ }
        }
        await sleep(25);
      }
      throw problem(record.exited ? 'Candidate API exited before readiness' : 'Candidate API readiness deadline exceeded', 502);
    } catch (error) { await discard(record); throw error; }
  }

  async function smoke(record) {
    for (const endpoint of ['/ready', '/health']) {
      const response = await fetch(`http://127.0.0.1:${record.port}${endpoint}`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
      const body = await response.json();
      if (!response.ok || body.ok !== true || (endpoint === '/ready' &&
          (body.release !== record.release || body.deploymentProtocol !== DEPLOYMENT_PROTOCOL))) {
        throw problem('Candidate failed post-switch smoke check', 502);
      }
    }
    if (record.exited) throw problem('Candidate exited during post-switch smoke check', 502);
  }

  function scheduleRestart(release) {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(async () => {
      if (stopping || (active && !active.exited)) return;
      if (operation) return scheduleRestart(release);
      try { await deploy(release, true); }
      catch { if (!stopping) scheduleRestart(release); }
    }, restartDelayMs);
    restartTimer.unref?.();
  }

  function deploy(release, recovering = false) {
    if (stopping) return Promise.reject(problem('Supervisor is stopping', 503));
    if (operation) return Promise.reject(problem('Another deployment is in progress', 409));
    if (retiring.size >= maxRetiring) return Promise.reject(problem('Old releases are still draining; wait before deploying again', 409));
    if (active?.release === release && !active.exited) return Promise.resolve(status());
    operation = (async () => {
      let fresh;
      try {
        fresh = await candidate(release);
        if (stopping) throw problem('Supervisor is stopping', 503);
        const old = active;
        const oldPrevious = previous;
        const prior = recovering ? previous : old?.release || previous;
        persist(release, prior);
        active = fresh;
        previous = prior;
        try { await smoke(fresh); }
        catch (error) {
          if (old && !old.exited) {
            active = old; previous = oldPrevious;
            persist(old.release, oldPrevious);
            retire(fresh);
            throw problem('Candidate failed post-switch smoke; previous release restored', 502);
          }
          throw error;
        }
        retire(old);
        log.log(`[servant] active API release ${release}`);
        return { ...status(), deploying: false };
      } catch (error) {
        if (fresh && active !== fresh && !fresh.retiring) await discard(fresh);
        throw error;
      } finally { operation = null; }
    })();
    return operation;
  }

  const proxy = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname); }
    catch { req.resume(); return json(res, 400, { error: 'Invalid request path' }); }
    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      req.resume(); return json(res, 403, { error: 'Administrative routes require direct local access' });
    }
    const record = active;
    if (!record || record.exited || stopping) { req.resume(); return json(res, 503, { error: 'API unavailable' }); }
    record.inFlight++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true; record.inFlight--; maybeStop(record);
    };
    const headers = filteredHeaders(req.headers);
    delete headers['x-servant-admin'];
    // Mark the proxy hop as remote, even for requests reaching it directly.
    headers['cf-connecting-ip'] = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '127.0.0.1');
    const upstream = http.request({ hostname: '127.0.0.1', port: record.port, method: req.method, path: req.url, headers, agent: false }, incoming => {
      res.writeHead(incoming.statusCode || 502, filteredHeaders(incoming.headers));
      incoming.on('error', () => res.destroy());
      incoming.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) json(res, 502, { error: 'API connection failed' });
      else res.destroy();
    });
    req.on('aborted', () => { upstream.destroy(); release(); });
    res.on('finish', release);
    res.on('close', () => { upstream.destroy(); release(); });
    req.pipe(upstream);
  });
  proxy.requestTimeout = 0;
  proxy.headersTimeout = 30000;
  proxy.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));

  const control = http.createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url === '/status') return json(res, 200, status());
      if (req.method !== 'POST') throw problem('Not found', 404);
      const body = await requestJson(req);
      if (req.url === '/deploy') return json(res, 200, await deploy(body.release));
      if (req.url === '/rollback') {
        if (!previous) throw problem('No previous release is available', 409);
        return json(res, 200, await deploy(previous));
      }
      throw problem('Not found', 404);
    })().catch(error => { if (!res.headersSent) json(res, error.status || 500, { error: error.message }); else res.end(); });
  });

  async function close() {
    if (closePromise) return closePromise;
    stopping = true; clearTimeout(restartTimer);
    closePromise = (async () => {
      const proxyClosed = new Promise(resolve => proxy.close(resolve));
      const controlClosed = new Promise(resolve => control.close(resolve));
      for (const record of children) retire(record);
      if (operation) await operation.catch(() => {});
      await Promise.all([...children].map(record => record.done));
      await Promise.all([proxyClosed, controlClosed]);
    })();
    return closePromise;
  }

  try {
    // Refuse to steal an existing supervisor's control socket. A stale socket
    // after a crash is removed only after a connection attempt proves it dead.
    if (fs.existsSync(socketPath)) {
      const available = await new Promise(resolve => {
        const req = http.get({ socketPath, path: '/status', timeout: 1000 }, response => { response.resume(); resolve(true); });
        req.on('timeout', () => { req.destroy(); resolve(true); });
        req.on('error', error => resolve(!['ECONNREFUSED', 'ENOENT'].includes(error.code)));
      });
      if (available) throw new Error('A supervisor already owns the control socket');
      fs.unlinkSync(socketPath);
    }
    const first = saved.activeRelease || initialRelease;
    if (!first) throw new Error('Stage a release and set SERVANT_INITIAL_RELEASE before first startup');
    await deploy(first, true);
    await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(port, host, resolve); });
    await new Promise((resolve, reject) => { control.once('error', reject); control.listen(socketPath, resolve); });
    fs.chmodSync(socketPath, 0o600);
    return { proxy, control, socketPath, status, deploy, rollback: () => previous ? deploy(previous) : Promise.reject(problem('No previous release is available', 409)), close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.umask(0o077);
    const service = await startSupervisor({
      runtimeDir: process.env.SERVANT_RUNTIME_DIR,
      dataDir: process.env.SERVANT_DATA_DIR,
      port: Number(process.env.SERVANT_PORT || 8787),
      initialRelease: process.env.SERVANT_INITIAL_RELEASE,
      candidateTimeoutMs: Number(process.env.SERVANT_CANDIDATE_TIMEOUT_MS || 30000),
    });
    console.log(`[servant] stable ingress listening on http://127.0.0.1:${service.proxy.address().port}`);
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void service.close().then(() => process.exit(0)); });
  } catch (error) { console.error(`[servant] supervisor: ${error.message}`); process.exitCode = 1; }
}
