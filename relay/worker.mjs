import { RelaySession } from './session.mjs';
import { CORS, parseFrame, unavailable, validHub } from '../server/relay-protocol.mjs';

export function hubRegistry(env) {
  try {
    const registry = JSON.parse(env.SERVANT_RELAY_HUBS || '{}');
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return {};
    return Object.fromEntries(Object.entries(registry).filter(([hub, hash]) => validHub(hub) && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)));
  } catch { return {}; }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = /^\/hubs\/([a-zA-Z0-9_-]{22,80})(\/connect|\/v1\/secure|\/health)$/.exec(url.pathname);
    if (!match || url.search || !hubRegistry(env)[match[1]]) return unavailable(404);
    if (request.method === 'OPTIONS' && match[2] !== '/connect') return new Response(null, { status: 204, headers: CORS });
    return env.HUBS.get(env.HUBS.idFromName(match[1])).fetch(request);
  },
};

export class Hub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.session = new RelaySession({ send: frame => {
      const host = this.host();
      if (!host) throw new Error('Host offline');
      host.send(JSON.stringify(frame));
    } });
    this.recent = [];
    // Ping/pong does not wake an idle object. Accepted host attachments survive
    // hibernation; active HTTP streams keep this object's memory alive.
    if (typeof WebSocketRequestResponsePair !== 'undefined') ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  host() { return this.ctx.getWebSockets().find(socket => socket.deserializeAttachment()?.authenticated && socket.readyState === 1); }
  async fetch(request) {
    const url = new URL(request.url);
    const hub = url.pathname.split('/')[2];
    const expected = hubRegistry(this.env)[hub];
    if (!expected) return unavailable(404);
    if (url.pathname.endsWith('/connect')) {
      if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return unavailable(400);
      if (this.ctx.getWebSockets().length >= 3) return unavailable(429);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ authenticated: false, expected });
      // Never place the host credential in a URL, cookie, or access log.
      const timeout = setTimeout(() => {
        if (!server.deserializeAttachment()?.authenticated) server.close(1008, 'Authentication required');
      }, 10_000);
      this.ctx.waitUntil(new Promise(resolve => setTimeout(resolve, 10_010)).then(() => clearTimeout(timeout)));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname.endsWith('/health') && request.method === 'GET') {
      return new Response(JSON.stringify({ ok: !!this.host() }), { status: this.host() ? 200 : 503, headers: { ...CORS, 'content-type': 'application/json' } });
    }
    if (request.method !== 'POST' || !url.pathname.endsWith('/v1/secure')) return unavailable(404);
    if (!this.host()) return unavailable();
    // Per-hub flood bound, not an authorization substitute. The Mac authenticates
    // the encrypted device credential. Production edges should add per-IP limits.
    const now = Date.now();
    this.recent = this.recent.filter(at => at > now - 60_000);
    if (this.recent.length >= 180) return unavailable(429);
    this.recent.push(now);
    return this.session.forward(request);
  }
  async webSocketMessage(socket, data) {
    try {
      if (data === 'ping') { socket.send('pong'); return; }
      const frame = parseFrame(data);
      const saved = socket.deserializeAttachment();
      if (!saved?.authenticated) {
        if (frame.type !== 'auth' || typeof frame.token !== 'string' || !/^[a-zA-Z0-9_-]{43,128}$/.test(frame.token)) throw new Error('Invalid authentication');
        const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(frame.token)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (digest !== saved.expected) throw new Error('Invalid authentication');
        this.session.close();
        for (const other of this.ctx.getWebSockets()) if (other !== socket && other.deserializeAttachment()?.authenticated) {
          other.serializeAttachment({ authenticated: false }); other.close(1000, 'Replaced');
        }
        socket.serializeAttachment({ authenticated: true });
        socket.send(JSON.stringify({ type: 'ready' }));
        return;
      }
      if (this.host() !== socket) throw new Error('Stale host');
      await this.session.receive(frame);
    } catch {
      if (socket.deserializeAttachment()?.authenticated) this.session.close();
      socket.serializeAttachment({ authenticated: false });
      socket.close(1008, 'Invalid relay frame');
    }
  }
  webSocketClose(socket) {
    if (socket.deserializeAttachment()?.authenticated) this.session.close();
    socket.serializeAttachment({ authenticated: false });
    socket.close(1000, 'Disconnected');
  }
  webSocketError(socket) { this.webSocketClose(socket); }
}
