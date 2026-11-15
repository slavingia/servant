// Link previews (owner's decision, 11/15): when someone posts a link, the server reads that page once and keeps
// its title, description and site name to show under the message. Readers never contact the site: there is no
// picture and nothing is fetched by the app. The site does learn that this server asked for the page.
//
// The address comes from a message, so it is treated as hostile: https only, a real host name on the default
// port, and every address that name resolves to must be on the public internet. The connection is made to the
// address that was checked (a name cannot answer one thing for the check and another for the request), each
// redirect is checked again, and the read is bounded in time and size.
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

const MAX_BYTES = 512 * 1024, TIMEOUT_MS = 5000, MAX_REDIRECTS = 3;

/** The first web link in a message, or null. Links in code are part of the code, and tweets have their own card. */
export function firstLink(text) {
  const prose = String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const match = /https:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}*_~]/.exec(prose);
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    return /^(.+\.)?(x|twitter)\.com$/i.test(url.hostname) ? null : url.href;
  } catch { return null; }
}

/** Only an address anyone on the internet could reach: nothing loopback, private, link-local or reserved. */
export function publicAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224);
  }
  if (!net.isIPv6(address)) return false;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return publicAddress(mapped[1]);
  // Global unicast is 2000::/3; everything else (loopback, unique local, link-local, multicast, mapped forms) is refused.
  return /^[23][0-9a-f]{3}:/.test(lower) && !lower.startsWith('2001:db8:');
}

/** A page address the server is willing to ask for. */
export function previewUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // A name, not a number: an address written out (in any notation) is never fetched.
  if (net.isIP(host) || !host.includes('.') || /^[0-9.x]+$/i.test(host) || /\.(local|internal|localhost|lan|home|corp)$/i.test(host) || host === 'localhost') return null;
  return url;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
  if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? whole;
  const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
  return Number.isInteger(point) && point > 31 && point < 0x110000 ? String.fromCodePoint(point) : ' ';
});
const clean = (value, max) => {
  const text = decode(String(value ?? '')).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
};

/** The title, description and site name a page gives for itself. Text only: no markup survives. */
export function pageSummary(html, url) {
  const head = String(html).slice(0, MAX_BYTES);
  const meta = name => {
    for (const tag of head.match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) ?? []) {
      const key = /\b(?:property|name)\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase();
      if (key !== name) continue;
      const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      if (content) return content[1] ?? content[2] ?? content[3];
    }
    return '';
  };
  const title = clean(meta('og:title') || meta('twitter:title') || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] || '', 140);
  if (!title) return null;
  return { url, title, description: clean(meta('og:description') || meta('description') || meta('twitter:description'), 280), site: clean(meta('og:site_name'), 60) || new URL(url).hostname.replace(/^www\./, '') };
}

// The name's addresses, all of which must be public. One is then used for the connection itself.
function resolvePublic(hostname, lookup) {
  return new Promise((resolve, reject) => lookup(hostname, { all: true }, (error, addresses) => {
    if (error || !addresses?.length) return reject(new Error('NOT_FOUND'));
    if (!addresses.every(entry => publicAddress(entry.address))) return reject(new Error('NOT_PUBLIC'));
    resolve(addresses[0]);
  }));
}

function get(url, address, request) {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET', timeout: TIMEOUT_MS, servername: url.hostname,
      // Connect to the address that was checked, whatever the name says by now.
      lookup: (_host, _options, done) => done(null, address.address, address.family),
      headers: { 'User-Agent': 'ServantLinkPreview/1.0', Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en' },
    }, res => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) { res.resume(); return resolve({ redirect: res.headers.location }); }
      if (status !== 200 || !/^(text\/html|application\/xhtml\+xml)\b/i.test(res.headers['content-type'] ?? '')) { res.destroy(); return resolve({}); }
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > MAX_BYTES) { chunks.push(chunk.subarray(0, chunk.length - (size - MAX_BYTES))); res.destroy(); resolve({ html: Buffer.concat(chunks).toString('utf8') }); } else chunks.push(chunk); });
      res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolve(size ? { html: Buffer.concat(chunks).toString('utf8') } : {}));
    });
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', reject);
    req.end();
  });
}

/** Read a page's summary, or null when it has none, cannot be reached, or is not somewhere the server will go. */
export async function fetchPreview(link, { lookup = dns.lookup, request = https.request } = {}) {
  let url = previewUrl(link);
  try {
    for (let hop = 0; url && hop <= MAX_REDIRECTS; hop++) {
      const answer = await get(url, await resolvePublic(url.hostname, lookup), request);
      if (answer.redirect) { url = previewUrl(new URL(answer.redirect, url).href); continue; }
      return answer.html ? pageSummary(answer.html, link) : null;
    }
  } catch { /* unreachable, refused, too slow: no preview */ }
  return null;
}

/** Previews for a server: a few at a time, each page asked for once in a while however often it is posted. */
export function createLinkPreviews({ fetcher = fetchPreview, limit = 4, keepMs = 10 * 60_000, clock = Date.now } = {}) {
  const recent = new Map();
  let running = 0;
  return async link => {
    const kept = recent.get(link);
    if (kept && clock() - kept.at < keepMs) return kept.preview;
    if (running >= limit) return null;
    running++;
    try {
      const preview = await fetcher(link);
      recent.set(link, { at: clock(), preview });
      if (recent.size > 500) recent.delete(recent.keys().next().value);
      return preview;
    } finally { running--; }
  };
}
