import test from 'node:test';
import assert from 'node:assert/strict';
import { assetPath, externalUrl, isAppUrl, workspaceConfig } from './policy.mjs';

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
