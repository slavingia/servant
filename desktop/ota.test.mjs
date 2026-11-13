import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkFiles, createWebUpdates, RUNTIME, updateAddress, verifyManifest } from './ota.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'servant-desktop-ota-'));
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
// A self-signed certificate is what the app embeds; for the verifier a public key PEM is equivalent input.
const certificate = publicKey.export({ type: 'spki', format: 'pem' });
const sha = buf => crypto.createHash('sha256').update(buf).digest('base64url');
const sign = (text, key = privateKey) => crypto.sign('sha256', Buffer.from(text), key).toString('base64');

function makeServer({ files, id = crypto.randomUUID(), type = 'update', key = privateKey, tamper = null } = {}) {
  const blobs = new Map();
  const list = Object.entries(files ?? { 'index.html': '<html>v1</html>', '_expo/a.js': 'a()' }).map(([p, content]) => {
    const buf = Buffer.from(content); blobs.set(sha(buf), buf);
    return { path: p, hash: sha(buf), size: buf.length, contentType: 'text/plain' };
  });
  const body = type === 'update' ? { type, id, runtimeVersion: RUNTIME, createdAt: new Date().toISOString(), files: list }
    : type === 'rollback' ? { type, id, runtimeVersion: RUNTIME } : { type, runtimeVersion: RUNTIME };
  const text = JSON.stringify(body);
  const requests = [];
  const fetchImpl = async url => {
    requests.push(String(url));
    const u = new URL(url);
    if (u.pathname === '/ota/web/manifest') return new Response(text, { status: 200, headers: { 'x-servant-signature': sign(text, key) } });
    const hash = u.pathname.split('/').pop();
    const buf = blobs.get(hash);
    if (!buf) return new Response('no', { status: 404 });
    return new Response(tamper ? Buffer.from('evil') : buf, { status: 200 });
  };
  return { fetchImpl, id, requests, list };
}
const setup = (server, opts = {}) => {
  const dir = tmp();
  return { dir, u: createWebUpdates({ dir, certificate, serverUrl: 'https://servant.example', fetchImpl: server.fetchImpl, log: { warn() {} }, ...opts }) };
};

test('address: https or loopback only, no credentials', () => {
  assert.equal(updateAddress('https://x.example/'), `https://x.example/ota/web/manifest?runtime=${RUNTIME}`);
  assert.ok(updateAddress('http://127.0.0.1:8787'));
  assert.equal(updateAddress('http://x.example'), null);
  assert.equal(updateAddress('https://user:pw@x.example'), null);
  assert.equal(updateAddress('nonsense'), null);
});

test('manifest: wrong key, tampering, missing signature and wrong shell are all refused', () => {
  const text = JSON.stringify({ type: 'none', runtimeVersion: RUNTIME });
  assert.equal(verifyManifest(text, sign(text), certificate).type, 'none');
  assert.throws(() => verifyManifest(text, sign(text, otherKey), certificate), /isn't signed by your server/);
  assert.throws(() => verifyManifest(text + ' ', sign(text), certificate), /isn't signed by your server/);
  assert.throws(() => verifyManifest(text, null, certificate), /without a signature/);
  const other = JSON.stringify({ type: 'none', runtimeVersion: 'mac-shell-9' });
  assert.throws(() => verifyManifest(other, sign(other), certificate), /different app version/);
  assert.throws(() => verifyManifest(text, sign(text), 'not a certificate'), /no valid update certificate/);
});

test('files: traversal, absolute, odd characters, duplicates and a missing index are refused', () => {
  const good = { path: 'index.html', hash: 'A'.repeat(43), size: 1 };
  assert.doesNotThrow(() => checkFiles([good, { ...good, path: '_expo/static/js/web/entry-0f.js' }, { ...good, path: '_expo/static/js/web/[id]-0f.js' }]));
  for (const bad of ['../x', '/etc/passwd', 'a/../../b', 'a\\b', 'a;b', '.hidden', 'a//b', '']) assert.throws(() => checkFiles([good, { ...good, path: bad }]), /unsafe file name/, bad);
  assert.throws(() => checkFiles([good, good]), /twice/);
  assert.throws(() => checkFiles([{ ...good, path: 'a.js' }]), /no index.html/);
  assert.throws(() => checkFiles([{ ...good, hash: 'short' }]), /wrongly/);
  assert.throws(() => checkFiles([]), /no files/);
});

test('installs a signed update, serves it on the next launch, and keeps it once it proves itself', async () => {
  const server = makeServer();
  const { dir, u } = setup(server);
  assert.equal(u.chooseRoot(), null, 'nothing yet: the built-in interface runs');
  const result = await u.check();
  assert.deepEqual(result, { status: 'ready', id: server.id });
  assert.equal(fs.readFileSync(path.join(dir, 'bundles', server.id, 'index.html'), 'utf8'), '<html>v1</html>');
  assert.equal(fs.readFileSync(path.join(dir, 'bundles', server.id, '_expo', 'a.js'), 'utf8'), 'a()');
  assert.equal((await u.check()).status, 'current', 'same update again is a no-op');
  const launched = u.chooseRoot();
  assert.equal(launched.id, server.id);
  u.markGood();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8')).trial, false);
  for (let i = 0; i < 5; i++) assert.equal(u.chooseRoot().id, server.id, 'a proven bundle is never abandoned');
});

test('a bundle that never finishes loading is dropped after two trial launches', async () => {
  const server = makeServer();
  const { dir, u } = setup(server);
  await u.check();
  assert.equal(u.chooseRoot().id, server.id);   // trial launch 1: crashes before markGood
  assert.equal(u.chooseRoot().id, server.id);   // trial launch 2: crashes again
  assert.equal(u.chooseRoot(), null, 'back to the built-in interface');
  assert.ok(!fs.existsSync(path.join(dir, 'bundles', server.id)), 'the bad bundle is deleted');
  assert.equal(u.current(), null);
});

test('a download that fails its checksum installs nothing', async () => {
  const server = makeServer({ tamper: true });
  const { dir, u } = setup(server);
  const result = await u.check();
  assert.equal(result.status, 'unavailable');
  assert.match(result.error, /checksum/);
  assert.equal(u.chooseRoot(), null);
  assert.deepEqual(fs.existsSync(path.join(dir, 'bundles')) ? fs.readdirSync(path.join(dir, 'bundles')) : [], [], 'no half-written bundle left');
});

test('a manifest signed by a different key is refused before any file is fetched', async () => {
  const server = makeServer({ key: otherKey });
  const { u } = setup(server);
  const result = await u.check();
  assert.equal(result.status, 'unavailable');
  assert.match(result.error, /isn't signed by your server/);
  assert.equal(server.requests.filter(r => r.includes('/ota/assets/')).length, 0);
});

test('only changed files are downloaded for the next update', async () => {
  const first = makeServer({ files: { 'index.html': '<html>v1</html>', '_expo/a.js': 'a()' } });
  const { dir, u } = setup(first);
  await u.check(); u.chooseRoot(); u.markGood();
  const second = makeServer({ files: { 'index.html': '<html>v1</html>', '_expo/a.js': 'a2()' } });
  const u2 = createWebUpdates({ dir, certificate, serverUrl: 'https://servant.example', fetchImpl: second.fetchImpl, log: { warn() {} } });
  assert.equal((await u2.check()).status, 'ready');
  assert.equal(second.requests.filter(r => r.includes('/ota/assets/')).length, 1, 'index.html came from the current bundle');
  assert.ok(!fs.existsSync(path.join(dir, 'bundles', first.id)), 'the old bundle is cleaned up');
});

test('rollback goes back to the built-in interface', async () => {
  const server = makeServer();
  const { dir, u } = setup(server);
  await u.check(); u.chooseRoot(); u.markGood();
  const rollback = makeServer({ type: 'rollback' });
  const u2 = createWebUpdates({ dir, certificate, serverUrl: 'https://servant.example', fetchImpl: rollback.fetchImpl, log: { warn() {} } });
  assert.equal((await u2.check()).status, 'rolledBack');
  assert.equal(u2.chooseRoot(), null);
  assert.equal((await u2.check()).status, 'current', 'a second rollback check is a no-op');
});

test('says why when it cannot update', async () => {
  const dir = tmp();
  const say = fetchImpl => createWebUpdates({ dir, certificate, serverUrl: 'https://servant.example', fetchImpl, log: { warn() {} } }).check();
  assert.match((await say(async () => { throw new Error('offline'); })).error, /Can't reach your server/);
  assert.match((await say(async () => new Response('', { status: 404 }))).error, /doesn't offer app updates/);
  assert.match((await say(async () => new Response('', { status: 503 }))).error, /no update signing key/);
  assert.match((await createWebUpdates({ dir, certificate, serverUrl: () => undefined, fetchImpl: async () => new Response('') }).check()).error, /Sign in/);
});
