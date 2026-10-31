// Exercise the actual app crypto and framing against the Node server.
import { encryptedFetch } from '../app/src/lib/tunnel-client.ts';
import { serverIdentity } from './secure-transport.mjs';

export async function testFetch(directory, url, options = {}) {
  const target = new URL(url);
  if (!target.pathname.startsWith('/v1/')) return fetch(url, options);
  const response = await encryptedFetch(target.origin, serverIdentity(directory).publicKey, target.pathname + target.search, options);
  const reader = response.body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      try { const { done, value } = await reader.read(); if (done) controller.close(); else controller.enqueue(value); }
      catch (error) { controller.error(error); }
    },
    cancel: () => reader.cancel(),
  });
  return new Response(stream, { status: response.status, headers: response.headers });
}
