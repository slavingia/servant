import { CORS, ENVELOPE_BYTES, IDLE_MS, MAX_REQUESTS, REQUEST_MS, decodeChunk, deferred, encodeChunk, splitChunks, unavailable } from '../server/relay-protocol.mjs';

// One instance per hub. Nothing is persisted. Interrupted HTTP streams fail
// closed; app retries must create a fresh cryptographic request envelope.
export class RelaySession {
  constructor({ send, now = Date.now, idleMs = IDLE_MS, requestMs = REQUEST_MS, maxRequests = MAX_REQUESTS } = {}) {
    this.send = send;
    this.now = now;
    this.idleMs = idleMs;
    this.requestMs = requestMs;
    this.maxRequests = maxRequests;
    this.pending = new Map();
  }
  async forward(request) {
    if (this.pending.size >= this.maxRequests) return unavailable(429);
    const declared = request.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > ENVELOPE_BYTES)) return unavailable(413);
    if (!request.body || request.signal.aborted) return unavailable(400);
    const id = crypto.randomUUID().replaceAll('-', '');
    const headers = deferred();
    const stream = new TransformStream();
    const job = { id, headers, writer: stream.writable.getWriter(), readable: stream.readable,
      reader: request.body.getReader(), bytes: 0, created: this.now(), signal: request.signal, ended: false };
    // Rejections during an upstream/client disconnect are handled by finish().
    job.writer.closed.catch(() => this.finish(id));
    job.abort = () => this.finish(id, 499);
    this.pending.set(id, job);
    request.signal.addEventListener('abort', job.abort, { once: true });
    this.touch(job);
    try { this.send({ type: 'request', id }); }
    catch { this.finish(id); return unavailable(); }
    void this.upload(job).catch(() => this.finish(id));
    return headers.promise;
  }
  touch(job) {
    clearTimeout(job.timer);
    const remaining = this.requestMs - (this.now() - job.created);
    job.timer = setTimeout(() => this.finish(job.id, 504), Math.max(1, Math.min(this.idleMs, remaining)));
  }
  async upload(job) {
    try {
      while (!job.ended) {
        const { value, done } = await job.reader.read();
        if (done) break;
        job.bytes += value.byteLength;
        if (job.bytes > ENVELOPE_BYTES) { this.finish(job.id, 413); return; }
        for (const chunk of splitChunks(value)) {
          if (job.ended) return;
          const ack = deferred(); job.ack = ack;
          this.send({ type: 'upload', id: job.id, data: encodeChunk(chunk) });
          await ack.promise;
        }
      }
      if (!job.ended) { job.uploaded = true; this.send({ type: 'uploaded', id: job.id }); }
    } finally { job.reader.releaseLock(); }
  }
  async receive(frame) {
    const job = this.pending.get(frame.id);
    if (!job) return;
    this.touch(job);
    if (frame.type === 'ack' && frame.direction === 'upload') {
      if (!job.ack) { this.finish(job.id, 502); return; }
      const ack = job.ack; job.ack = null; ack.resolve();
    } else if (frame.type === 'headers') {
      if (job.started || !job.uploaded) { this.finish(job.id, 502); return; }
      job.started = true;
      job.headers.resolve(new Response(job.readable, { status: 200, headers: {
        ...CORS, 'content-type': 'application/x-servant-encrypted',
      } }));
    } else if (frame.type === 'download') {
      if (!job.started || job.writing) { this.finish(job.id, 502); return; }
      job.writing = true;
      try {
        // Ack only after the HTTP consumer accepts this chunk: a slow phone
        // cannot make the relay or Mac accumulate an unbounded response.
        await job.writer.write(decodeChunk(frame.data));
        if (!job.ended) this.send({ type: 'ack', direction: 'download', id: job.id });
      } catch { this.finish(job.id, 502); }
      finally { job.writing = false; }
    } else if (frame.type === 'complete') {
      if (!job.started || job.writing) { this.finish(job.id, 502); return; }
      this.remove(job);
      void job.writer.close().catch(() => {});
    } else if (frame.type === 'error') this.finish(job.id, 502);
    else this.finish(job.id, 502);
  }
  remove(job) {
    job.ended = true;
    clearTimeout(job.timer);
    job.signal.removeEventListener('abort', job.abort);
    this.pending.delete(job.id);
  }
  finish(id, status = 503) {
    const job = this.pending.get(id);
    if (!job) return;
    this.remove(job);
    const error = new Error('Relay connection interrupted');
    job.ack?.reject(error);
    try { void job.reader.cancel(error).catch(() => {}); } catch { /* reader already released */ }
    void job.writer.abort(error).catch(() => {});
    if (!job.started) job.headers.resolve(unavailable(status));
    try { this.send({ type: 'cancel', id }); } catch { /* already disconnected */ }
  }
  close() { for (const id of this.pending.keys()) this.finish(id); }
}
