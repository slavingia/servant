// Application-layer encryption: the owner's server is the trusted endpoint.
// Keep this module platform-independent so the actual wire protocol is testable.
import { p256 } from '@noble/curves/nist.js';
import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const protocol = 'servant-tunnel-v1';
export const validServerKey = (key: unknown): key is string => typeof key === 'string' && /^(02|03)[0-9a-f]{64}$/.test(key);
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function fromBase64(value: string): Uint8Array {
  // A plain loop: a callback per byte made every reply frame twice as slow to read on a phone.
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
export type TunnelRequest = { method: string; path: string; headers: Record<string, string>; body: string; at: number };

// Every request multiplies two fixed points by a fresh secret: the curve's base point (the one-time
// public key) and the pinned server key (the shared secret). Both use a table of the point's
// multiples, built once, so a request costs two short table walks instead of a full ladder on the
// thread that also draws the screen. The tables hold public values only, the secret is still new
// for every request and the bytes on the wire are the same. Width 4 is the smallest table that
// gets most of the gain: it is built in a third of the time of the library's default.
const TABLE_WIDTH = 4;
const Point = p256.Point;
Point.BASE.precompute(TABLE_WIDTH);
type ServerPoint = InstanceType<typeof Point>;
const serverPoints = new Map<string, ServerPoint>();
// One per server this device is signed in to; a handful at most.
const MAX_SERVER_POINTS = 4;

/** The pinned server key as a curve point, checked once and kept with its table of multiples. */
export function serverPoint(serverKey: string): ServerPoint {
  const known = serverPoints.get(serverKey);
  if (known) return known;
  if (!validServerKey(serverKey)) throw new Error('A trusted server key is required. Open a new invite from your admin.');
  // fromBytes refuses anything that is not a point on the curve.
  const point = Point.fromBytes(hexToBytes(serverKey));
  if (point.is0()) throw new Error('A trusted server key is required. Open a new invite from your admin.');
  point.precompute(TABLE_WIDTH);
  if (serverPoints.size >= MAX_SERVER_POINTS) serverPoints.delete(serverPoints.keys().next().value!);
  serverPoints.set(serverKey, point);
  return point;
}

/** ECDH with the pinned server key: the x coordinate of secret × server key, as in version 1 of the wire format. */
export function sharedSecret(serverKey: string, secret: Uint8Array): Uint8Array {
  return serverPoint(serverKey).multiply(Point.Fn.fromBytes(secret)).toBytes(true).slice(1);
}
export type TunnelFrame = { type: 'headers'; status: number; headers: Record<string, string> } | { type: 'chunk'; data: string } | { type: 'end' };

export function sealRequest(serverKey: string, request: TunnelRequest, secret: Uint8Array, salt: Uint8Array) {
  if (!validServerKey(serverKey) || salt.length !== 32) throw new Error('A trusted server key is required. Open a new invite from your admin.');
  const publicKey = bytesToHex(p256.getPublicKey(secret));
  const shared = sharedSecret(serverKey, secret);
  const context = encoder.encode(`${protocol}:${serverKey}:${publicKey}`);
  const keys = hkdf(sha256, shared, salt, context, 64);
  shared.fill(0);
  const aad = encoder.encode(`${protocol}:request`);
  const data = toBase64(gcm(keys.subarray(0, 32), new Uint8Array(12), aad).encrypt(encoder.encode(JSON.stringify(request))));
  let sequence = 0;
  let ended = false;
  return {
    envelope: { v: 1, publicKey, salt: toBase64(salt), data },
    openFrame(line: string): TunnelFrame {
      if (ended || sequence >= 0xffffffff) throw new Error('Invalid encrypted response sequence');
      const nonce = new Uint8Array(12);
      new DataView(nonce.buffer).setUint32(8, sequence++);
      const plaintext = gcm(keys.subarray(32), nonce, encoder.encode(`${protocol}:response`)).decrypt(fromBase64(line));
      const frame = JSON.parse(decoder.decode(plaintext)) as TunnelFrame;
      if (frame.type === 'end') { ended = true; keys.fill(0); }
      return frame;
    },
    destroy() { keys.fill(0); },
  };
}
