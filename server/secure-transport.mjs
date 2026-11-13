import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

const PROTOCOL = 'servant-tunnel-v1';
const WINDOW = 120000;
// 30 MiB attachments expand twice: base64 upload JSON inside base64 ciphertext.
// Keep the outer cap explicit, with enough room for the 41 MiB route body cap.
const LIMIT = 56 * 1024 * 1024;
const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
// The body is buffered before anything is authenticated, so its size, speed and total memory are all bounded:
// a client that stalls or trickles is cut off, and all requests together may hold only this much at once.
const IDLE_MS = 30_000;          // no bytes for this long: give up
const TOTAL_MS = 5 * 60_000;     // a 56 MiB upload from a slow phone still fits
const MAX_IN_FLIGHT = 3 * LIMIT; // across all concurrent requests (the relay host caps its side at 64 MiB)

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

export function createSecureTransport(directory, { idleMs = IDLE_MS, totalMs = TOTAL_MS, maxInFlightBytes = MAX_IN_FLIGHT } = {}) {
  const identity = serverIdentity(directory);
  // Durable replay protection: a restart must not permit replaying a write.
  const db = new DatabaseSync(path.join(directory, 'transport-replays.db'));
  // API processes share replay protection. Wait for a competing writer rather
  // than treating ordinary lock contention as an invalid encrypted request.
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE IF NOT EXISTS replays (id TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
  const prune = db.prepare('DELETE FROM replays WHERE expires < ?');
  const remember = db.prepare('INSERT OR IGNORE INTO replays VALUES (?, ?)');
  let inFlight = 0; // bytes of unauthenticated bodies currently buffered
  const refuse = (res, status, code, message) => {
    res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code, message } }));
  };
  return {
    publicKey: identity.publicKey,
    close: () => db.close(),
    async handle(outerReq, outerRes, handler) {
      let keys, request;
      const declared = outerReq.headers?.['content-length'];
      if (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) > LIMIT)) {
        outerReq.resume?.();
        return refuse(outerRes, 413, 'encrypted_request_too_large', 'Encrypted request too large');
      }
      const chunks = [];
      let size = 0;
      try {
        // Stop reading on a stall (idle) or a trickle (total), and count what is held across requests.
        const started = Date.now();
        const iterator = outerReq[Symbol.asyncIterator]();
        try {
          for (;;) {
            const remaining = Math.min(idleMs, totalMs - (Date.now() - started));
            if (remaining <= 0) throw Object.assign(new Error('Too slow'), { slow: true });
            let timer;
            const next = await Promise.race([
              iterator.next(),
              new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Too slow'), { slow: true })), remaining); }),
            ]).finally(() => clearTimeout(timer));
            if (next.done) break;
            size += next.value.length;
            if (size > LIMIT) throw new Error('Too large');
            if (inFlight + next.value.length > maxInFlightBytes) throw Object.assign(new Error('Busy'), { busy: true });
            inFlight += next.value.length;
            chunks.push(next.value);
          }
        } finally { void iterator.return?.()?.catch?.(() => {}); }
        const text = Buffer.concat(chunks).toString('utf8');
        // The raw chunks are no longer held once parsed: give the shared budget back now, and on every error path below.
        chunks.length = 0; inFlight -= size; size = 0;
        const envelope = JSON.parse(text);
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
      } catch (error) {
        keys?.fill(0);
        inFlight -= size; chunks.length = 0; size = 0;
        if (error?.slow) { outerReq.destroy?.(); return refuse(outerRes, 408, 'encrypted_request_timeout', 'Encrypted request timed out'); }
        if (error?.busy) return refuse(outerRes, 429, 'encrypted_request_busy', 'Server is busy. Try again');
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
      // x-servant-reverify: the app says it can show the re-entry screen when a session ends (session-expiry.mjs).
      for (const name of ['authorization', 'accept', 'x-servant-reverify']) if (typeof request.headers[name] === 'string') req.headers[name] = request.headers[name];
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
        res.end(JSON.stringify({ error: status === 500 ? { code: 'server_error', message: 'Something went wrong on the server' } : { code: error.code || 'bad_request', message: error.message, ...(error.extra || {}) } }));
      }
    },
  };
}
