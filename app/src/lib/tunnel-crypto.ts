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
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
export type TunnelRequest = { method: string; path: string; headers: Record<string, string>; body: string; at: number };
export type TunnelFrame = { type: 'headers'; status: number; headers: Record<string, string> } | { type: 'chunk'; data: string } | { type: 'end' };

export function sealRequest(serverKey: string, request: TunnelRequest, secret: Uint8Array, salt: Uint8Array) {
  if (!validServerKey(serverKey) || salt.length !== 32) throw new Error('A trusted server key is required. Open a new invite from your admin.');
  const publicKey = bytesToHex(p256.getPublicKey(secret));
  const shared = p256.getSharedSecret(secret, hexToBytes(serverKey)).slice(1);
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
