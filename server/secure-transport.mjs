import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

const PROTOCOL = 'servant-tunnel-v1';
const WINDOW = 120000;
const LIMIT = 24 * 1024 * 1024;
const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

export function serverIdentity(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'transport-key');
  const key = crypto.createECDH('prime256v1');
  try { key.setPrivateKey(fs.readFileSync(file)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error; // Never silently rotate a damaged key.
    key.generateKeys();
    try { fs.writeFileSync(file, key.getPrivateKey(), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; key.setPrivateKey(fs.readFileSync(file)); }
  }
  fs.chmodSync(file, 0o600);
  return { key, publicKey: key.getPublicKey('hex', 'compressed') };
}

function bytes(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid encoding');
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value || (length && result.length !== length)) throw new Error('Invalid encoding');
  return result;
}
function decrypt(key, data) {
  if (data.length < 16) throw new Error('Invalid ciphertext');
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.alloc(12));
  cipher.setAAD(Buffer.from(`${PROTOCOL}:request`));
  cipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()]);
}

export function createSecureTransport(directory) {
  const identity = serverIdentity(directory);
  // Durable replay protection: a restart must not permit replaying a write.
  const db = new DatabaseSync(path.join(directory, 'transport-replays.db'));
  // API processes share replay protection. Wait for a competing writer rather
  // than treating ordinary lock contention as an invalid encrypted request.
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE IF NOT EXISTS replays (id TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
  const prune = db.prepare('DELETE FROM replays WHERE expires < ?');
  const remember = db.prepare('INSERT OR IGNORE INTO replays VALUES (?, ?)');
  return {
    publicKey: identity.publicKey,
    close: () => db.close(),
    async handle(outerReq, outerRes, handler) {
      let keys, request;
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of outerReq) {
          size += chunk.length;
          if (size > LIMIT) throw new Error('Too large');
          chunks.push(chunk);
        }
        const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (envelope.v !== 1 || typeof envelope.publicKey !== 'string' || !/^(02|03)[0-9a-f]{64}$/.test(envelope.publicKey)) throw new Error('Invalid envelope');
        const salt = bytes(envelope.salt, 32);
        const shared = identity.key.computeSecret(Buffer.from(envelope.publicKey, 'hex'));
        keys = Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(`${PROTOCOL}:${identity.publicKey}:${envelope.publicKey}`), 64));
        shared.fill(0);
        request = JSON.parse(decrypt(keys.subarray(0, 32), bytes(envelope.data)).toString('utf8'));
        if (!Number.isSafeInteger(request.at) || Math.abs(Date.now() - request.at) > WINDOW) throw new Error('Expired');
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) || typeof request.path !== 'string' || !/^\/v1\/[a-z]/.test(request.path) || request.path.length > 2048) throw new Error('Invalid route');
        const route = new URL(request.path, 'http://server');
        if (!route.pathname.startsWith('/v1/') || route.pathname === '/v1/secure' || route.origin !== 'http://server') throw new Error('Invalid route');
        if (typeof request.body !== 'string' || !request.headers || typeof request.headers !== 'object') throw new Error('Invalid request');
        prune.run(Date.now());
        const id = crypto.createHash('sha256').update(envelope.publicKey).update(salt).digest('hex');
        if (!remember.run(id, request.at + WINDOW).changes) throw new Error('Replay');
      } catch {
        keys?.fill(0);
        outerRes.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
        outerRes.end(JSON.stringify({ error: { code: 'encrypted_request_invalid', message: 'Invalid or expired encrypted request' } }));
        return;
      }

      // Only allow application headers. Never let an encrypted client forge the
      // transport IP or the local-admin header used by the existing router.
      const req = Readable.from(request.body ? [Buffer.from(request.body)] : []);
      req.method = request.method;
      req.url = request.path;
      req.headers = { 'content-type': 'application/json', 'cf-connecting-ip': outerReq.headers['cf-connecting-ip'] || outerReq.socket.remoteAddress };
      for (const name of ['authorization', 'accept']) if (typeof request.headers[name] === 'string') req.headers[name] = request.headers[name];
      req.socket = outerReq.socket;
      req.encryptedTransport = true;

      outerRes.writeHead(200, { ...cors, 'Content-Type': 'application/x-servant-encrypted', 'X-Accel-Buffering': 'no' });
      let sequence = 0;
      let ended = false;
      const frame = value => {
        if (ended || outerRes.destroyed) return false;
        if (sequence >= 0xffffffff) { outerRes.destroy(); return false; }
        const nonce = Buffer.alloc(12);
        nonce.writeUInt32BE(sequence++, 8);
        const cipher = crypto.createCipheriv('aes-256-gcm', keys.subarray(32), nonce);
        cipher.setAAD(Buffer.from(`${PROTOCOL}:response`));
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]);
        return outerRes.write(`${ciphertext.toString('base64')}\n`);
      };
      const res = new EventEmitter();
      res.headersSent = false;
      res.statusCode = 200;
      const headers = {};
      res.setHeader = (name, value) => { headers[name.toLowerCase()] = String(value); };
      res.writeHead = (status, extra = {}) => {
        if (res.headersSent) return res;
        res.statusCode = status;
        for (const [name, value] of Object.entries(extra)) res.setHeader(name, value);
        res.headersSent = true;
        frame({ type: 'headers', status, headers });
        return res;
      };
      res.write = data => {
        if (!res.headersSent) res.writeHead(res.statusCode);
        const text = String(data);
        let writable = true;
        for (let i = 0; i < text.length;) {
          let end = Math.min(i + 16384, text.length);
          if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
          writable = frame({ type: 'chunk', data: text.slice(i, end) });
          i = end;
        }
        return writable;
      };
      res.end = data => {
        if (ended) return;
        if (data !== undefined) res.write(data);
        if (!res.headersSent) res.writeHead(res.statusCode);
        frame({ type: 'end' });
        ended = true;
        keys.fill(0);
        outerRes.end();
      };
      outerRes.once('close', () => { ended = true; keys.fill(0); res.emit('close'); req.destroy(); });
      try { await handler(req, res); }
      catch (error) {
        if (res.headersSent) { outerRes.destroy(); return; }
        const status = error.status || 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: status === 500 ? 'server_error' : error.code || 'bad_request', message: status === 500 ? 'Something went wrong on the server' : error.message } }));
      }
    },
  };
}
