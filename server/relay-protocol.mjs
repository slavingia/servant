// Relay framing contains routing information and opaque /v1/secure bytes only.
// App cryptography remains in the phone and Mac; the relay has no transport key.
export const FRAME_BYTES = 48 * 1024;
export const ENVELOPE_BYTES = 56 * 1024 * 1024;
export const MAX_REQUESTS = 8;
export const IDLE_MS = 60_000;
export const REQUEST_MS = 15 * 60_000;
export const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
// The visitor's address as the relay edge saw it. Only used to key per-address limits (pairing, email codes),
// so it must be a plain address: no whitespace, no header injection.
export const validIp = value => typeof value === 'string' && value.length <= 45 && /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]{2,45}(?:\.\d{1,3}){0,3})$/.test(value) && (value.includes('.') || value.includes(':'));
export const validHub = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{22,80}$/.test(value);

export function parseFrame(data) {
  if (typeof data !== 'string' || data.length > 70_000) throw new Error('Invalid relay frame');
  const frame = JSON.parse(data);
  const controls = ['auth', 'ready'];
  const routed = ['request', 'upload', 'uploaded', 'ack', 'headers', 'download', 'complete', 'cancel', 'error'];
  if (!frame || (!controls.includes(frame.type) && !routed.includes(frame.type)) ||
      (routed.includes(frame.type) && !validId(frame.id)) ||
      (controls.includes(frame.type) && frame.id !== undefined)) throw new Error('Invalid relay frame');
  return frame;
}
export function encodeChunk(bytes) {
  if (bytes.length > FRAME_BYTES) throw new Error('Relay chunk too large');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function decodeChunk(data) {
  if (typeof data !== 'string' || data.length > Math.ceil(FRAME_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('Invalid relay chunk');
  return Uint8Array.from(atob(data), character => character.charCodeAt(0));
}
export function splitChunks(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += FRAME_BYTES) chunks.push(bytes.subarray(offset, offset + FRAME_BYTES));
  return chunks;
}
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type, accept', 'cache-control': 'no-store' };
export const unavailable = (status = 503) => new Response(JSON.stringify({ error: 'relay_unavailable' }), {
  status, headers: { ...CORS, 'content-type': 'application/json' },
});
