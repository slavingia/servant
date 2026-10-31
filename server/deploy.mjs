#!/usr/bin/env node
// Stage source-only immutable API releases and switch through the private socket.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { DEPLOYMENT_PROTOCOL, validReleaseId, verifyRelease } from './supervisor.mjs';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function stageRelease({ sourceDir, runtimeDir, id } = {}) {
  if (!sourceDir || !runtimeDir) throw new Error('sourceDir and runtimeDir are required');
  sourceDir = path.resolve(sourceDir); runtimeDir = path.resolve(runtimeDir);
  const files = {};
  const content = new Map();
  for (const name of fs.readdirSync(sourceDir).sort()) {
    if (!(name.endsWith('.mjs') || name === 'package.json') || name.endsWith('.test.mjs') || name === 'encrypted-test-client.mjs') continue;
    const file = path.join(sourceDir, name);
    if (!fs.lstatSync(file).isFile()) throw new Error(`Source must be a regular file: ${name}`);
    const bytes = fs.readFileSync(file);
    files[name] = digest(bytes); content.set(name, bytes);
  }
  if (!files['server.mjs']) throw new Error('Source directory must contain server.mjs');
  const hash = digest(JSON.stringify(files));
  id ??= `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${hash.slice(0, 10)}`;
  if (!validReleaseId(id)) throw new Error('Invalid release ID');
  const releases = path.join(runtimeDir, 'releases');
  fs.mkdirSync(releases, { recursive: true, mode: 0o700 });
  const destination = path.join(releases, id);
  if (fs.existsSync(destination)) {
    const existing = verifyRelease(runtimeDir, id);
    if (existing.manifest.sourceHash !== hash) throw new Error('Release ID already has different content');
    return { release: id, directory: destination, sourceHash: hash };
  }
  const staging = fs.mkdtempSync(path.join(releases, '.staging-'));
  try {
    for (const [name, bytes] of content) fs.writeFileSync(path.join(staging, name), bytes, { mode: 0o400 });
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({
      id, deploymentProtocol: DEPLOYMENT_PROTOCOL, createdAt: new Date().toISOString(), sourceHash: hash, files,
    }, null, 2), { mode: 0o400 });
    fs.chmodSync(staging, 0o500);
    fs.renameSync(staging, destination);
    verifyRelease(runtimeDir, id);
    return { release: id, directory: destination, sourceHash: hash };
  } catch (error) {
    if (fs.existsSync(staging)) { fs.chmodSync(staging, 0o700); fs.rmSync(staging, { recursive: true, force: true }); }
    throw error;
  }
}

export function controlRequest(runtimeDir, route, body) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ socketPath: path.join(path.resolve(runtimeDir), 'control.sock'), path: route,
      method: bytes ? 'POST' : 'GET', headers: bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {},
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode >= 400) throw new Error(value.error || `Control request failed (${res.statusCode})`);
          resolve(value);
        } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Control request timed out; inspect status before retrying')));
    req.end(bytes);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1]; };
  try {
    process.umask(0o077);
    const command = process.argv[2];
    const runtimeDir = option('runtime') || process.env.SERVANT_RUNTIME_DIR;
    if (!runtimeDir) throw new Error('Provide --runtime or SERVANT_RUNTIME_DIR');
    let result;
    if (command === 'stage') result = stageRelease({ sourceDir: option('source'), runtimeDir, id: option('id') });
    else if (command === 'deploy') result = await controlRequest(runtimeDir, '/deploy', { release: option('release') });
    else if (command === 'rollback') result = await controlRequest(runtimeDir, '/rollback', {});
    else if (command === 'status') result = await controlRequest(runtimeDir, '/status');
    else throw new Error('Usage: deploy.mjs stage --source <server-dir> --runtime <dir> [--id <id>] | deploy --release <id> | rollback | status');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`[servant] deploy: ${error.message}`); process.exitCode = 1; }
}
