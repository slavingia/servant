import { sealRequest, validServerKey } from './tunnel-crypto.ts';

export type SecureResponse = {
  ok: boolean; status: number; headers: Headers;
  body: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel: () => Promise<void> } };
  json: () => Promise<any>;
};

// No plaintext fallback, including pairing, error responses, attachments and SSE.
export async function encryptedFetch(base: string, serverKey: string | undefined, path: string, init: RequestInit = {}, transport: typeof fetch = fetch, random: (length: number) => Promise<Uint8Array> = async length => crypto.getRandomValues(new Uint8Array(length))): Promise<SecureResponse> {
  if (!validServerKey(serverKey)) throw new Error('Encryption setup required. Open a new invite from your admin.');
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  if (init.body != null && typeof init.body !== 'string') throw new Error('Unsupported encrypted request body');
  const secret = await random(32);
  const tunnel = sealRequest(serverKey, { method: init.method || 'GET', path, headers, body: init.body || '', at: Date.now() }, secret, await random(32));
  secret.fill(0);
  let response;
  try {
    response = await transport(`${base}/v1/secure`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-servant-encrypted' },
      body: JSON.stringify(tunnel.envelope), signal: init.signal, redirect: 'error',
    });
  } catch (error) { tunnel.destroy(); throw error; }
  if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('application/x-servant-encrypted')) {
    tunnel.destroy();
    await response.body?.cancel();
    throw new Error(`Encrypted connection unavailable (${response.status}). Check your invite and server version.`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  const cancel = async () => { ended = true; tunnel.destroy(); await reader.cancel(); };
  const next = async () => {
    try {
      while (!buffer.includes('\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Encrypted response ended unexpectedly');
        buffer += decoder.decode(chunk.value, { stream: true });
        if (!buffer.includes('\n') && buffer.length > 256 * 1024) throw new Error('Encrypted response frame too large');
      }
      const boundary = buffer.indexOf('\n');
      if (boundary > 256 * 1024) throw new Error('Encrypted response frame too large');
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      return tunnel.openFrame(line);
    } catch (error) { await cancel(); throw error; }
  };
  const first = await next();
  if (first.type !== 'headers' || !Number.isInteger(first.status) || first.status < 100 || first.status > 599) {
    await cancel(); throw new Error('Invalid encrypted response');
  }
  const read = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
    if (ended) return { done: true };
    const frame = await next();
    if (frame.type === 'end') { await cancel(); return { done: true }; }
    if (frame.type !== 'chunk' || typeof frame.data !== 'string') { await cancel(); throw new Error('Invalid encrypted response'); }
    return { done: false, value: new TextEncoder().encode(frame.data) };
  };
  const result: SecureResponse = {
    ok: first.status >= 200 && first.status < 300, status: first.status, headers: new Headers(first.headers),
    body: { getReader: () => ({ read, cancel }) },
    json: async () => {
      const text = new TextDecoder();
      let value = '';
      for (;;) { const part = await read(); if (part.done) break; value += text.decode(part.value, { stream: true }); }
      return JSON.parse(value + text.decode());
    },
  };
  // Most mutation callers ignore the body. Still authenticate the entire reply
  // and its end marker before reporting success, and release the network reader.
  if (!result.headers.get('content-type')?.startsWith('text/event-stream')) {
    let text = '';
    const decoder = new TextDecoder();
    for (;;) { const part = await read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }); }
    text += decoder.decode();
    result.json = async () => JSON.parse(text);
    let consumed = false;
    result.body = { getReader: () => ({
      read: async () => { if (consumed) return { done: true }; consumed = true; return { done: false, value: new TextEncoder().encode(text) }; },
      cancel: async () => { consumed = true; },
    }) };
  }
  return result;
}
