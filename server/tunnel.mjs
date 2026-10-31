#!/usr/bin/env node
// Keep the public entrypoint alive independently of API deployment/restarts.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const publicAddress = value => /^https:\/\/[a-z0-9.-]+(?::\d+)?\/?$/i.test(value || '');

export function tunnelOptions(env = process.env) {
  const dataDir = path.resolve(env.SERVANT_DATA_DIR || path.join(HERE, 'data'));
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read tunnel config.json'); }
  const port = Number(env.SERVANT_PORT ?? config.port ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SERVANT_PORT must be a valid TCP port');
  const named = !!env.SERVANT_TUNNEL_ID;
  if (env.SERVANT_TUNNEL_CONFIG && !named) throw new Error('SERVANT_TUNNEL_CONFIG requires SERVANT_TUNNEL_ID');
  if (named && (!env.SERVANT_TUNNEL_CONFIG || !publicAddress(env.SERVANT_PUBLIC_URL))) {
    throw new Error('Named tunnels require SERVANT_TUNNEL_CONFIG and an HTTPS SERVANT_PUBLIC_URL');
  }
  if (named) fs.accessSync(env.SERVANT_TUNNEL_CONFIG, fs.constants.R_OK);
  const args = ['tunnel', '--no-autoupdate'];
  if (named) args.push('--config', env.SERVANT_TUNNEL_CONFIG, 'run', env.SERVANT_TUNNEL_ID);
  else args.push('--url', `http://127.0.0.1:${port}`);
  return { executable: env.CF || '/opt/homebrew/bin/cloudflared', args, dataDir,
    publicUrl: named ? env.SERVANT_PUBLIC_URL.replace(/\/$/, '') : '', node: env.NODE || process.execPath };
}

async function probe(url, signal) {
  const response = await fetch(`${url}/health`, { signal, redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); return false; }
  const body = await response.json();
  return body.ok === true;
}

function childProcess(executable, args, options) {
  const child = spawn(executable, args, { detached: true, ...options });
  child.finished = new Promise(resolve => {
    child.once('error', () => resolve(1));
    child.once('close', code => resolve(code ?? 1));
  });
  return child;
}

function signalGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) {
    // A stop can race the child's exec/setsid. Signal the direct child too if
    // its new process group is not addressable yet (EPERM on macOS).
    if (!['ESRCH', 'EPERM'].includes(error.code)) throw error;
    child.kill(signal);
  }
}

async function terminate(child, timeout) {
  if (!child) return;
  const deadline = Date.now() + timeout;
  signalGroup(child, 'SIGTERM');
  const timer = setTimeout(() => signalGroup(child, 'SIGKILL'), timeout);
  try {
    await child.finished;
    // A publisher may exit before its gh child. Retain the kill deadline until
    // its process group is gone, including descendants that ignore SIGTERM.
    while (child.pid && Date.now() < deadline) {
      try { process.kill(-child.pid, 0); }
      catch (error) { if (['ESRCH', 'EPERM'].includes(error.code)) return; throw error; }
      await delay(Math.min(20, Math.max(1, deadline - Date.now())));
    }
    signalGroup(child, 'SIGKILL');
  } finally { clearTimeout(timer); }
}

export function superviseTunnel({ executable, args, dataDir, publicUrl = '', node = process.execPath,
  publishScript = path.join(HERE, 'publish.mjs'), check = probe,
  retryMs = 2000, refreshMs = 120000, shutdownMs = 10000, log = console }) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(path.join(dataDir, 'cloudflared.log'), 'a', 0o600);
  const tunnel = childProcess(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let url = publicUrl;
  let partial = '';
  let stopped = false;
  let timer;
  let activeProbe;
  let publisher;
  let finish;
  let stopping;
  const exited = new Promise(resolve => { finish = resolve; });
  const consume = chunk => {
    fs.writeSync(logFd, chunk);
    if (!publicUrl) {
      partial = (partial + chunk.toString()).slice(-16384);
      // Only accept a complete hostname (cloudflared may split writes).
      const found = [...partial.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=[\s|"'])/g)].at(-1);
      if (found) url = found[0];
    }
  };
  tunnel.stdout.on('data', consume);
  tunnel.stderr.on('data', consume);

  async function publish() {
    let success = false;
    try {
      if (url && !stopped) {
        activeProbe = new AbortController();
        const signal = AbortSignal.any([activeProbe.signal, AbortSignal.timeout(10000)]);
        if (await check(url, signal) && !stopped) {
          publisher = childProcess(node, [publishScript, url], {
            env: { ...process.env, SERVANT_DATA_DIR: dataDir }, stdio: ['ignore', 'inherit', 'inherit'],
          });
          // gh can wait on network; bound the whole publisher process group.
          const deadline = setTimeout(() => signalGroup(publisher, 'SIGKILL'), 30000);
          try { success = await publisher.finished === 0; }
          finally { clearTimeout(deadline); publisher = undefined; }
        }
      }
    } catch { /* API or edge not ready. Keep the tunnel alive and retry. */ }
    finally {
      activeProbe = undefined;
      if (!stopped) timer = setTimeout(publish, success ? refreshMs : retryMs);
    }
  }

  function stop(code = 0) {
    if (stopping) return stopping;
    stopped = true;
    clearTimeout(timer);
    activeProbe?.abort();
    stopping = Promise.all([terminate(tunnel, shutdownMs), terminate(publisher, shutdownMs)])
      .finally(() => { fs.closeSync(logFd); finish(code); });
    return stopping;
  }
  tunnel.finished.then(() => {
    if (!stopped) {
      log.error('[servant] tunnel exited; supervisor will restart it');
      void stop(1);
    }
  });
  timer = setTimeout(publish, 0);
  return { stop, exited, pid: tunnel.pid };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.umask(0o077);
    const service = superviseTunnel(tunnelOptions());
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void service.stop());
    process.exitCode = await service.exited;
  } catch (error) {
    console.error(`[servant] ${error.message}`);
    process.exitCode = 1;
  }
}
