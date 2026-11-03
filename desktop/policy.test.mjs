import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedPermission, assetPath, externalUrl, inviteLink, isAppUrl, teamIdentifier, updateMode, workspaceConfig } from './policy.mjs';

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
  assert.equal(teamIdentifier('Identifier=gov.irs.servant.desktop\nTeamIdentifier=AB12CD34EF\nSealed Resources version=2'), 'AB12CD34EF');
  for (const output of ['Signature=adhoc\nTeamIdentifier=not set', 'code object is not signed at all', '', undefined]) assert.equal(teamIdentifier(output), null);
  assert.equal(updateMode('AB12CD34EF'), 'install');
  assert.equal(updateMode(null), 'notify');
});
test('the window may use the camera and microphone for meetings but nothing else', () => {
  assert.equal(allowedPermission('clipboard-sanitized-write'), true);
  assert.equal(allowedPermission('media', { mediaTypes: ['audio', 'video'] }), true);
  assert.equal(allowedPermission('media', { mediaType: 'audio' }), true);
  for (const [p, d] of [['media', {}], ['media', { mediaTypes: ['audio', 'screen'] }], ['display-capture', {}], ['clipboard-read', {}], ['geolocation', {}], ['notifications', {}]]) assert.equal(allowedPermission(p, d), false);
});
