import { ENVELOPE_BYTES, IDLE_MS, MAX_REQUESTS, decodeChunk, deferred, encodeChunk, parseFrame, splitChunks, validIp } from './relay-protocol.mjs';

// The relay can request exactly one local route. It can never choose a local
// origin, admin path, header or method, even if the relay is compromised.
export class RelayHostSession {
  constructor({ send, port = 8787, fetcher = fetch, maxRequests = MAX_REQUESTS,
    maxBufferedBytes = 64 * 1024 * 1024, idleMs = IDLE_MS } = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local port');
    this.send = send;
    this.url = `http://127.0.0.1:${port}/v1/secure`;
    this.fetcher = fetcher;
    this.maxRequests = maxRequests;
    this.maxBufferedBytes = maxBufferedBytes;
    this.idleMs = idleMs;
    this.bufferedBytes = 0;
    this.pending = new Map();
  }
  receive(frame) {
    if (frame.type === 'request') {
      if (this.pending.has(frame.id)) throw new Error('Duplicate relay request');
      if (this.pending.size >= this.maxRequests) { this.send({ type: 'error', id: frame.id }); return; }
      const job = { id: frame.id, chunks: [], bytes: 0, abort: new AbortController(), ip: validIp(frame.ip) ? frame.ip : undefined };
      this.pending.set(frame.id, job);
      this.touch(job);
      return;
    }
    const job = this.pending.get(frame.id);
    if (!job) return;
    this.touch(job);
    if (frame.type === 'upload') {
      if (job.uploaded) { this.finish(job.id); return; }
      const bytes = decodeChunk(frame.data);
      if (job.bytes + bytes.byteLength > ENVELOPE_BYTES || this.bufferedBytes + bytes.byteLength > this.maxBufferedBytes) { this.finish(job.id); return; }
      job.bytes += bytes.byteLength;
      this.bufferedBytes += bytes.byteLength;
      job.chunks.push(bytes);
      this.send({ type: 'ack', direction: 'upload', id: job.id });
    } else if (frame.type === 'uploaded') {
      if (job.uploaded) { this.finish(job.id); return; }
      job.uploaded = true;
      void this.fetch(job).catch(() => this.finish(job.id));
    } else if (frame.type === 'ack' && frame.direction === 'download') {
      if (!job.ack) { this.finish(job.id); return; }
      const ack = job.ack; job.ack = null; ack.resolve();
    } else if (frame.type === 'cancel') this.finish(job.id, false);
    else this.finish(job.id);
  }
  touch(job) {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => this.finish(job.id), this.idleMs);
    job.timer.unref?.();
  }
  async fetch(job) {
    // Bodies are bounded across all requests, not just per request. Retain their
    // accounting until local fetch consumes them; no unbounded websocket queue.
    const body = new Blob(job.chunks);
    job.chunks = [];
    const response = await this.fetcher(this.url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-servant-encrypted', ...(job.ip ? { 'cf-connecting-ip': job.ip } : {}) },
      body, redirect: 'error', signal: job.abort.signal,
    });
    this.bufferedBytes -= job.bytes;
    job.bytes = 0;
    if (!this.pending.has(job.id)) { await response.body?.cancel(); return; }
    // Never carry a plaintext local error or an accidental endpoint response to
    // the edge. The app treats this generic transport failure as unauthenticated.
    if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0] !== 'application/x-servant-encrypted' || !response.body) {
      await response.body?.cancel(); this.finish(job.id); return;
    }
    this.send({ type: 'headers', id: job.id });
    job.reader = response.body.getReader();
    try {
      while (this.pending.has(job.id)) {
        const { done, value } = await job.reader.read();
        if (done) break;
        for (const chunk of splitChunks(value)) {
          if (!this.pending.has(job.id)) return;
          this.touch(job);
          const ack = deferred(); job.ack = ack;
          this.send({ type: 'download', id: job.id, data: encodeChunk(chunk) });
          await ack.promise;
        }
      }
      if (this.pending.has(job.id)) {
        this.send({ type: 'complete', id: job.id });
        this.remove(job);
      }
    } finally { job.reader.releaseLock(); }
  }
  remove(job) {
    clearTimeout(job.timer);
    this.bufferedBytes -= job.bytes;
    job.bytes = 0; job.chunks = [];
    this.pending.delete(job.id);
  }
  finish(id, notify = true) {
    const job = this.pending.get(id);
    if (!job) return;
    this.remove(job);
    job.abort.abort();
    job.ack?.reject(new Error('Relay connection interrupted'));
    try { void job.reader?.cancel().catch(() => {}); } catch { /* reader released */ }
    if (notify) { try { this.send({ type: 'error', id }); } catch { /* disconnected */ } }
  }
  close() { for (const id of this.pending.keys()) this.finish(id, false); }
}

export async function connectRelay({ url, token, port, signal, WebSocketImpl = WebSocket, log = () => {}, ready = () => {} }) {
  const socket = new WebSocketImpl(url);
  const session = new RelayHostSession({ port, send: frame => socket.send(JSON.stringify(frame)) });
  let lastResponse = Date.now(), authenticated = false, done = false;
  const closed = deferred();
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(handshake); clearInterval(heartbeat);
    signal?.removeEventListener('abort', stop);
    session.close();
    try { socket.close(); } catch { /* handshake interrupted */ }
    closed.resolve();
  };
  const stop = () => finish();
  const handshake = setTimeout(finish, 15_000);
  const heartbeat = setInterval(() => {
    if (Date.now() - lastResponse > 45_000) finish();
    else if (authenticated) socket.send('ping');
  }, 20_000);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) finish();
  socket.addEventListener('open', () => { if (!done) socket.send(JSON.stringify({ type: 'auth', token })); });
  socket.addEventListener('message', event => {
    if (done) return;
    try {
      lastResponse = Date.now();
      if (event.data === 'pong') return;
      const frame = parseFrame(event.data);
      if (!authenticated) {
        if (frame.type !== 'ready') throw new Error('Relay authentication failed');
        authenticated = true; clearTimeout(handshake); log('[servant] encrypted relay connected'); ready();
      } else session.receive(frame);
    } catch { finish(); }
  });
  socket.addEventListener('close', finish);
  socket.addEventListener('error', finish);
  await closed.promise;
  return authenticated;
}
