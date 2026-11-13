import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedPermission, assetPath, contentSecurityPolicy, externalUrl, frameOrigins, inviteLink, isAppUrl, teamIdentifier, updateMode, workspaceConfig } from './policy.mjs';

test('only servant://pair invite links reach the app', () => {
  const link = 'servant://pair?code=ABCDE-FGH23&server=http%3A%2F%2F127.0.0.1%3A8787&key=02' + 'a'.repeat(64);
  assert.equal(inviteLink(link), link);
  for (const url of ['servant://pair', 'servant://chat?code=X', 'https://pair?code=X', 'javascript:alert(1)', 'servant://pair?code=' + 'A'.repeat(5000), undefined, 42]) assert.equal(inviteLink(url), null);
});

test('local assets cannot escape their root or use another origin', () => {
  assert.equal(assetPath('/bundle/web', 'servant-app://app/assets/a.js'), '/bundle/web/assets/a.js');
  for (const url of ['file:///etc/passwd', 'servant-app://else/assets/a.js', 'servant-app://app/%2e%2e%2fpackage.json', 'servant-app://app/%00', 'servant-app://app/..%5csecret']) assert.equal(assetPath('/bundle/web', url), null);
  assert.equal(isAppUrl('servant-app://app.attacker.test'), false);
});
test('OS links cannot invoke arbitrary protocols or carry credentials', () => {
  assert.equal(externalUrl('https://example.org/help'), 'https://example.org/help');
  for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'servant://pair', 'https://user:password@example.org']) assert.equal(externalUrl(url), null);
});
test('workspace projection includes only public settings and production requires HTTPS', () => {
  const value = { server: 'https://example.org/', serverKey: '02' + 'a'.repeat(64), token: 'secret', adminKey: 'secret' };
  assert.deepEqual(workspaceConfig(value), { server: 'https://example.org', serverKey: value.serverKey });
  assert.throws(() => workspaceConfig({ ...value, server: 'http://127.0.0.1:8788' }));
  assert.equal(workspaceConfig({ ...value, server: 'http://127.0.0.1:8788' }, { allowLoopback: true }).server, 'http://127.0.0.1:8788');
  assert.throws(() => workspaceConfig({ ...value, server: 'http://external.test' }, { allowLoopback: true }));
});
test('only Developer ID builds install updates in place', () => {
  assert.equal(teamIdentifier('Identifier=com.example.servant.desktop\nTeamIdentifier=AB12CD34EF\nSealed Resources version=2'), 'AB12CD34EF');
  for (const output of ['Signature=adhoc\nTeamIdentifier=not set', 'code object is not signed at all', '', undefined]) assert.equal(teamIdentifier(output), null);
  assert.equal(updateMode('AB12CD34EF'), 'install');
  assert.equal(updateMode(null), 'notify');
});
test('the window may use the camera, microphone and a shared screen for meetings but nothing else', () => {
  assert.equal(allowedPermission('clipboard-sanitized-write'), true);
  assert.equal(allowedPermission('display-capture', {}), true);
  assert.equal(allowedPermission('media', { mediaTypes: ['audio', 'video'] }), true);
  assert.equal(allowedPermission('media', { mediaType: 'audio' }), true);
  for (const [p, d] of [['media', {}], ['media', { mediaTypes: ['audio', 'screen'] }], ['clipboard-read', {}], ['geolocation', {}], ['notifications', {}]]) assert.equal(allowedPermission(p, d), false);
});
test('frame origins are bare https origins set at build time; tweets can always embed', () => {
  assert.deepEqual(frameOrigins(undefined), []);
  assert.deepEqual(frameOrigins(' https://example-org.github.io, https://example-org.github.io/ https://b.example '), ['https://example-org.github.io', 'https://b.example']);
  for (const bad of ['http://example-org.github.io', 'https://example-org.github.io/prototypes/', 'https://u:p@x.example', 'not a url', "https://x.example;script-src"]) assert.throws(() => frameOrigins(bad), bad);
  assert.match(contentSecurityPolicy(), /frame-src https:\/\/platform\.twitter\.com;/);
  assert.match(contentSecurityPolicy(['https://example-org.github.io']), /frame-src https:\/\/example-org\.github\.io https:\/\/platform\.twitter\.com;/);
});

test('multi-server credential files cannot escape storage and the manifest selects one server', async () => {
  const { accountFileName, activeAccountKey } = await import('./policy.mjs');
  const id = 'key:' + '02' + 'a'.repeat(64);
  const key = activeAccountKey({ version: 1, activeId: id, ids: [id] });
  assert.equal(accountFileName('servant.account'), 'account.enc');
  assert.equal(accountFileName('servant.accounts'), 'accounts.enc');
  assert.match(accountFileName(key), /^account-[0-9a-f]{64}\.enc$/);
  assert.equal(accountFileName(key), accountFileName(key));
  for (const bad of ['../secrets', 'servant.account...', 'servant.account.abc', 'servant.account.abcdef/../../secret']) assert.equal(accountFileName(bad), null);
  assert.equal(activeAccountKey({ version: 1, activeId: 'missing', ids: [id] }), null);
});
test('desktop notifications allow only scoped opaque destinations and bounded previews', async () => {
  const { desktopNotification } = await import('./policy.mjs');
  const notice = { accountId: 'key:demo', title: 'x'.repeat(100), body: 'y'.repeat(300), data: { userId: 'u', deviceId: 'd', conversationId: 'ch_general', token: 'secret' } };
  const valid = desktopNotification(notice);
  assert.equal(valid.title.length, 80);
  assert.equal(valid.body.length, 240);
  assert.deepEqual(valid.data, { userId: 'u', deviceId: 'd', conversationId: 'ch_general' });
  assert.equal(desktopNotification({ ...notice, data: { ...notice.data, conversationId: 'https://evil.test' } }), null);
});
