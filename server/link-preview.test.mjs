import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLinkPreviews, fetchPreview, firstLink, pageSummary, previewUrl, publicAddress } from './link-preview.mjs';
import { createMessaging } from './messaging.mjs';

test('the first web link in a message is the one previewed; code and tweets are not', () => {
  assert.equal(firstLink('See https://example.gov/report. Then https://example.org/b'), 'https://example.gov/report');
  assert.equal(firstLink('(https://example.gov/a_b)'), 'https://example.gov/a_b');
  for (const text of ['no link here', 'http://example.gov/plain', 'run `curl https://example.gov/x`', '```\nhttps://example.gov/in-code\n```', 'https://x.com/someone/status/1', 'https://twitter.com/a/status/2', '', null]) assert.equal(firstLink(text), null, String(text));
});

test('only addresses on the public internet are acceptable', () => {
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(publicAddress(address), true, address);
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '2001:db8::1', 'not-an-address', '']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('::ffff:8.8.8.8'), true);
});

test('only an https page on a real host name is ever asked for', () => {
  assert.equal(previewUrl('https://example.gov/report?x=1').hostname, 'example.gov');
  for (const url of ['http://example.gov/', 'https://127.0.0.1/', 'https://[::1]/', 'https://2130706433/', 'https://0x7f.0.0.1/', 'https://localhost/', 'https://intranet/', 'https://server.local/', 'https://db.internal/',
    'https://example.gov:8443/', 'https://user:pw@example.gov/', 'ftp://example.gov/', 'file:///etc/passwd', 'javascript:alert(1)', 'nonsense']) assert.equal(previewUrl(url), null, url);
});

test('a page\'s own title, description and site name are kept as plain text', () => {
  const html = `<html><head><title>Fallback &amp; title</title>
    <meta property="og:title" content="Permit renewals &amp; fees &#8212; 2026">
    <meta name="description" content="How to renew   a permit.\n<b>Bold</b> &lt;script&gt;alert(1)&lt;/script&gt;">
    <meta property='og:site_name' content='Example Agency'></head><body>ignored</body></html>`;
  assert.deepEqual(pageSummary(html, 'https://www.example.gov/permits'), { url: 'https://www.example.gov/permits', title: 'Permit renewals & fees — 2026', description: 'How to renew a permit. Bold alert(1)', site: 'Example Agency' });
  assert.deepEqual(pageSummary('<title> Only a title </title>', 'https://www.example.gov/x'), { url: 'https://www.example.gov/x', title: 'Only a title', description: '', site: 'example.gov' });
  assert.equal(pageSummary('<p>No title at all</p>', 'https://example.gov/'), null);
  const long = pageSummary(`<title>${'t'.repeat(500)}</title><meta name="description" content="${'d'.repeat(900)}">`, 'https://example.gov/');
  assert.deepEqual([long.title.length, long.description.length], [140, 280]);
});

// A stand-in for the network: which names resolve to what, and what each address answers.
function network(names, pages) {
  const requests = [];
  const lookup = (host, _options, done) => names[host] ? done(null, names[host].map(address => ({ address, family: address.includes(':') ? 6 : 4 }))) : done(new Error('ENOTFOUND'));
  const request = (url, options, onResponse) => {
    const req = new EventEmitter();
    req.destroy = error => { if (error) req.emit('error', error); };
    req.end = () => options.lookup(url.hostname, {}, (_e, address) => {
      requests.push({ url: url.href, connectedTo: address, headers: options.headers });
      const page = pages[url.href] ?? { status: 404 };
      const res = new EventEmitter();
      Object.assign(res, { statusCode: page.status ?? 200, headers: { 'content-type': page.type ?? 'text/html; charset=utf-8', ...(page.location ? { location: page.location } : {}) }, resume() {}, destroy() { res.destroyed = true; } });
      onResponse(res);
      if (page.body !== undefined) { for (const chunk of [].concat(page.body)) if (!res.destroyed) res.emit('data', Buffer.from(chunk)); if (!res.destroyed) res.emit('end'); }
    });
    return req;
  };
  return { lookup, request, requests };
}

test('a public page is read once, from the address that was checked', async () => {
  const net = network({ 'example.gov': ['93.184.216.34'] }, { 'https://example.gov/report': { body: '<title>Annual report</title><meta name="description" content="Numbers for the year">' } });
  assert.deepEqual(await fetchPreview('https://example.gov/report', net), { url: 'https://example.gov/report', title: 'Annual report', description: 'Numbers for the year', site: 'example.gov' });
  assert.deepEqual(net.requests.map(r => [r.url, r.connectedTo]), [['https://example.gov/report', '93.184.216.34']]);
  assert.equal(net.requests[0].headers['User-Agent'], 'ServantLinkPreview/1.0');
  assert.equal('Cookie' in net.requests[0].headers || 'Authorization' in net.requests[0].headers, false, 'nothing of the server or the person is sent');
});

test('a name that points inside the network is never contacted, directly or by redirect', async () => {
  const pages = { 'https://example.gov/go': { status: 302, location: 'https://inside.example.gov/admin' }, 'https://example.gov/meta': { status: 301, location: 'http://169.254.169.254/latest/meta-data' },
    'https://inside.example.gov/admin': { body: '<title>Admin</title>' }, 'https://mixed.example.gov/': { body: '<title>Mixed</title>' } };
  const net = network({ 'example.gov': ['93.184.216.34'], 'inside.example.gov': ['10.0.0.5'], 'mixed.example.gov': ['93.184.216.34', '127.0.0.1'] }, pages);
  assert.equal(await fetchPreview('https://inside.example.gov/admin', net), null);
  assert.equal(await fetchPreview('https://mixed.example.gov/', net), null, 'one private address among public ones is enough to refuse');
  assert.equal(await fetchPreview('https://example.gov/go', net), null, 'a redirect is checked like the first address');
  assert.equal(await fetchPreview('https://example.gov/meta', net), null);
  assert.equal(await fetchPreview('https://nowhere.example.gov/', net), null);
  assert.deepEqual(net.requests.map(r => r.url), ['https://example.gov/go', 'https://example.gov/meta'], 'only the public pages were asked for');
});

test('redirects are followed a few times; other answers, other content and oversized pages give no preview or only their start', async () => {
  const hop = n => ({ status: 302, location: `https://example.gov/hop${n}` });
  const net = network({ 'example.gov': ['93.184.216.34'] }, {
    'https://example.gov/short': { status: 301, location: '/long' }, 'https://example.gov/long': { body: '<title>Moved here</title>' },
    'https://example.gov/hop0': hop(1), 'https://example.gov/hop1': hop(2), 'https://example.gov/hop2': hop(3), 'https://example.gov/hop3': hop(4), 'https://example.gov/hop4': { body: '<title>Too far</title>' },
    'https://example.gov/file.pdf': { type: 'application/pdf', body: '%PDF' }, 'https://example.gov/gone': { status: 500, body: '<title>Error</title>' },
    'https://example.gov/huge': { body: ['<title>Start of a huge page</title>', 'x'.repeat(600 * 1024), '<title>never read</title>'] },
  });
  assert.equal((await fetchPreview('https://example.gov/short', net)).title, 'Moved here');
  assert.equal(await fetchPreview('https://example.gov/hop0', net), null, 'no more than three redirects');
  assert.equal(await fetchPreview('https://example.gov/file.pdf', net), null);
  assert.equal(await fetchPreview('https://example.gov/gone', net), null);
  assert.equal((await fetchPreview('https://example.gov/huge', net)).title, 'Start of a huge page');
});

test('a page is asked for once however often it is posted, and only a few at a time', async () => {
  let calls = 0, now = 0;
  const read = createLinkPreviews({ fetcher: async link => { calls++; return { url: link, title: 'T', description: '', site: 's' }; }, clock: () => now });
  await read('https://example.gov/a'); await read('https://example.gov/a');
  assert.equal(calls, 1);
  now = 11 * 60_000;
  await read('https://example.gov/a');
  assert.equal(calls, 2, 'asked again after ten minutes');
  let release; const held = new Promise(resolve => { release = resolve; });
  const slow = createLinkPreviews({ limit: 2, fetcher: async () => { await held; return null; } });
  const first = slow('https://example.gov/1'), second = slow('https://example.gov/2');
  assert.equal(await slow('https://example.gov/3'), null, 'a third while two are being read is skipped');
  release(); await Promise.all([first, second]);
});

const people = { pat: { id: 'pat', name: 'Pat Tester', role: 'owner' }, jo: { id: 'jo', name: 'Jo Park', role: 'member' } };
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
function chat(linkPreview) {
  const asked = [];
  const m = createMessaging({ file: ':memory:', users: () => people, agentName: () => 'Agent', askAgent: async () => 'See https://example.gov/from-agent',
    linkPreview: linkPreview === undefined ? async link => { asked.push(link); return { url: link, title: `Title of ${new URL(link).pathname}`, description: 'About it', site: 'example.gov' }; } : linkPreview });
  const route = async (userId, method, path, body = {}) => {
    let response;
    await m.handle({}, {}, { user: people[userId], method, parts: path.split('/').filter(Boolean), url: new URL(path, 'http://local'), cors: {}, readBody: async () => body,
      send: (_r, status, data) => { response = { status, data }; }, fail: (_r, status, code) => { response = { status, code }; } });
    return response;
  };
  const shown = async id => (await route('pat', 'GET', `/v1/conversations/${id}/messages`)).data.messages;
  return { m, asked, route, shown };
}

test('a posted link gets its preview after the message is delivered, and it follows edits and deletes', async () => {
  const { m, asked, route, shown } = chat();
  try {
    const c = m.createChannel(people.pat, { name: 'links', memberIds: ['jo'] });
    const posted = m.post(c, 'jo', 'The report is at https://example.gov/report and https://example.gov/second');
    assert.equal((await shown(c.id)).at(-1).preview, undefined, 'the message is there before its preview');
    await settle();
    assert.deepEqual((await shown(c.id)).at(-1).preview, { url: 'https://example.gov/report', title: 'Title of /report', description: 'About it', site: 'example.gov' });
    assert.deepEqual(asked, ['https://example.gov/report'], 'one page per message: the first link');
    // Edited to another link: the old preview goes at once, the new one arrives.
    assert.equal((await route('jo', 'PATCH', `/v1/messages/${posted.seq}`, { text: 'Use https://example.gov/final instead' })).status, 200);
    assert.equal((await shown(c.id)).at(-1).preview, undefined);
    await settle();
    assert.equal((await shown(c.id)).at(-1).preview.url, 'https://example.gov/final');
    // Edited to no link, then deleted: no preview, and nothing left behind.
    await route('jo', 'PATCH', `/v1/messages/${posted.seq}`, { text: 'Never mind' });
    await settle();
    assert.equal((await shown(c.id)).at(-1).preview, undefined);
    const again = m.post(c, 'jo', 'https://example.gov/again');
    await settle();
    assert.equal((await route('jo', 'DELETE', `/v1/messages/${again.seq}`)).status, 200);
    assert.equal(m.db.prepare('SELECT COUNT(*) AS n FROM link_previews').get().n, 0);
  } finally { m.close(); }
});

test('no page is read for a message without a link, the agent\'s own, or when previews are off', async () => {
  const on = chat();
  try {
    const c = on.m.createChannel(people.pat, { name: 'quiet' });
    on.m.post(c, 'pat', 'No link in this one');
    on.m.post(c, 'pat', 'Plain http is not read: http://example.gov/x, nor code `https://example.gov/y`');
    const mention = on.m.post(c, 'pat', '@agent where is it?');
    await on.m.agentReply(on.m.db.prepare('SELECT * FROM conversations WHERE id = ?').get(c.id), mention);
    await settle();
    assert.deepEqual(on.asked, []);
  } finally { on.m.close(); }
  for (const off of [null, async () => null, async () => { throw new Error('unreachable'); }]) {
    const { m, shown } = chat(off);
    try {
      const c = m.createChannel(people.pat, { name: 'off' });
      m.post(c, 'pat', 'https://example.gov/report');
      await settle();
      assert.equal((await shown(c.id)).at(-1).preview, undefined);
      assert.equal((await shown(c.id)).at(-1).text, 'https://example.gov/report', 'the message itself is unaffected');
    } finally { m.close(); }
  }
});
