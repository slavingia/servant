#!/usr/bin/env node
// Outbound relay connection, supervised by the existing tunnel launch service.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { connectRelay } from './relay-client.mjs';
import { validHub } from './relay-protocol.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export function relayOptions(env = process.env) {
  if (!env.SERVANT_RELAY_CONFIG) throw new Error('Set SERVANT_RELAY_CONFIG to a private relay JSON file');
  const filename = path.resolve(env.SERVANT_RELAY_CONFIG);
  if (fs.statSync(filename).mode & 0o077) throw new Error('Relay config must have permissions 0600');
  let config;
  try { config = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new Error('Cannot read relay configuration'); }
  let origin;
  try { origin = new URL(config.relay); } catch { throw new Error('Relay must be an HTTPS origin'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Relay must be an HTTPS origin');
  if (!validHub(config.hubId) || typeof config.hostToken !== 'string' || !/^[a-zA-Z0-9_-]{43,128}$/.test(config.hostToken)) throw new Error('Invalid relay hub ID or host token');
  const dataDir = path.resolve(env.SERVANT_DATA_DIR || path.join(HERE, 'data'));
  let hubConfig = {};
  try { hubConfig = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read server config'); }
  const port = Number(env.SERVANT_PORT ?? hubConfig.port ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local port');
  const publicUrl = `${origin.origin}/hubs/${config.hubId}`;
  if (env.SERVANT_DISCOVERY_URL) throw new Error('Remove SERVANT_DISCOVERY_URL when selecting stable relay mode');
  if (env.SERVANT_PUBLIC_URL && env.SERVANT_PUBLIC_URL.replace(/\/$/, '') !== publicUrl) throw new Error('SERVANT_PUBLIC_URL conflicts with the stable relay address');
  return { url: publicUrl.replace(/^https:/, 'wss:') + '/connect', publicUrl, token: config.hostToken, port, dataDir };
}

export function publishRelayAddress(dataDir, publicUrl) {
  const filename = path.join(dataDir, 'config.json');
  const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (config.publicUrl === publicUrl && config.discovery === 'off' && !config.discoveryUrl) return;
  // Stable relay invites do not require gh, a gist, or a discovery callback.
  // Keep gistId so an operator can explicitly migrate legacy phones once.
  config.publicUrl = publicUrl;
  config.discovery = 'off';
  delete config.discoveryUrl;
  const temporary = `${filename}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, filename);
}

export function superviseRelay(options) {
  const controller = new AbortController();
  const log = options.log || console.log;
  const exited = (async () => {
    let backoff = 1000;
    while (!controller.signal.aborted) {
      const started = Date.now();
      try {
        await connectRelay({ ...options, signal: controller.signal, log,
          ready: () => publishRelayAddress(options.dataDir, options.publicUrl) });
      } catch { /* Do not log network exceptions containing private URLs/tokens. */ }
      if (controller.signal.aborted) break;
      log('[servant] relay disconnected; reconnecting');
      if (Date.now() - started > 60_000) backoff = 1000;
      await delay(backoff + Math.floor(Math.random() * 250), undefined, { signal: controller.signal }).catch(() => {});
      backoff = Math.min(30_000, backoff * 2);
    }
    return 0;
  })();
  return { exited, stop: () => { controller.abort(); return exited; } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.umask(0o077);
    const service = superviseRelay(relayOptions());
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void service.stop());
    process.exitCode = await service.exited;
  } catch (error) { console.error(`[servant] ${error.message}`); process.exitCode = 1; }
}
