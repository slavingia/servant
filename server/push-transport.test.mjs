import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import { createPushTransport } from './push-transport.mjs';

test('APNs sends alerts using the configured app topic and signed credentials', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-push-transport-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyPath = path.join(dir, 'apns.p8');
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const originalBundleId = process.env.SERVANT_BUNDLE_ID;
  delete process.env.SERVANT_BUNDLE_ID;
  t.after(() => {
    if (originalBundleId === undefined) delete process.env.SERVANT_BUNDLE_ID;
    else process.env.SERVANT_BUNDLE_ID = originalBundleId;
  });

  const sent = [];
  t.mock.method(http2, 'connect', host => {
    const request = { host, destroyed: false };
    sent.push(request);
    const client = new EventEmitter();
    client.destroy = () => { request.destroyed = true; };
    client.request = headers => {
      request.headers = headers;
      const stream = new EventEmitter();
      stream.end = body => {
        request.body = JSON.parse(body);
        queueMicrotask(() => {
          stream.emit('response', { ':status': 200 });
          stream.emit('end');
        });
      };
      return stream;
    };
    return client;
  });

  for (const topic of [undefined, 'com.example.servant', 'com.example.other']) {
    const config = { apnsKeyPath: keyPath, apnsKeyId: 'fixture-key', apnsTeamId: 'fixture-team', ...(topic ? { apnsTopic: topic } : {}) };
    const send = createPushTransport(() => config);
    const result = await send({ platform: 'ios', token: 'a'.repeat(64), environment: 'production' }, {
      title: 'A message', body: 'Hello', data: { conversationId: 'ch_test' },
    });
    assert.equal(result.ok, true);
    const request = sent.at(-1);
    assert.equal(request.host, 'https://api.push.apple.com');
    assert.equal(request.headers[':method'], 'POST');
    assert.equal(request.headers[':path'], '/3/device/' + 'a'.repeat(64));
    assert.equal(request.headers['apns-topic'], topic || 'com.example.servant');
    assert.equal(request.headers['apns-push-type'], 'alert');
    assert.equal(request.body.aps.alert.body, 'Hello');
    assert.equal(request.body.body.conversationId, 'ch_test');
    assert.ok(request.headers['apns-collapse-id']);
    const [header, payload, signature] = request.headers.authorization.replace(/^bearer /, '').split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'fixture-key' });
    assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, 'fixture-team');
    assert.ok(crypto.verify('sha256', Buffer.from(header + '.' + payload), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
    assert.equal(request.destroyed, true);
  }
  assert.equal(sent.length, 3);
});

// One server, two apps: the team's own build and a second one (another bundle id, another Apple team's key).
test('a device is sent to with the credentials and topic of the app it runs; an app with none is left alone', async t => {
  const { pushCredentials } = await import('./push-transport.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-push-apps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = name => { const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); const file = path.join(dir, name); fs.writeFileSync(file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 }); return { file, publicKey: pair.publicKey }; };
  const own = key('own.p8'), other = key('other.p8');
  const originalBundleId = process.env.SERVANT_BUNDLE_ID;
  delete process.env.SERVANT_BUNDLE_ID;
  t.after(() => { if (originalBundleId === undefined) delete process.env.SERVANT_BUNDLE_ID; else process.env.SERVANT_BUNDLE_ID = originalBundleId; });
  const sent = [];
  t.mock.method(http2, 'connect', host => {
    const request = { host };
    sent.push(request);
    const client = new EventEmitter();
    client.destroy = () => {};
    client.request = headers => {
      request.headers = headers;
      const stream = new EventEmitter();
      stream.end = () => queueMicrotask(() => { stream.emit('response', { ':status': 200 }); stream.emit('end'); });
      return stream;
    };
    return client;
  });
  const config = { apnsKeyPath: own.file, apnsKeyId: 'own-key', apnsTeamId: 'own-team', apnsTopic: 'com.example.servant',
    apps: { 'com.example.other': { apnsKeyPath: other.file, apnsKeyId: 'other-key', apnsTeamId: 'other-team' } } };
  const send = createPushTransport(() => config);
  const alert = { title: 'A message', body: 'Hello', data: { conversationId: 'ch_test' } };
  const device = app => ({ platform: 'ios', token: 'a'.repeat(64), environment: 'production', ...(app ? { app } : {}) });
  const signedBy = request => { const [header, payload, signature] = request.headers.authorization.replace(/^bearer /, '').split('.');
    return { kid: JSON.parse(Buffer.from(header, 'base64url')).kid, iss: JSON.parse(Buffer.from(payload, 'base64url')).iss,
      own: crypto.verify('sha256', Buffer.from(header + '.' + payload), { key: own.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')),
      other: crypto.verify('sha256', Buffer.from(header + '.' + payload), { key: other.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')) }; };

  // A build from before apps were named, and the server's own app: the server's own credentials.
  for (const app of [undefined, 'com.example.servant']) {
    assert.equal((await send(device(app), alert)).ok, true);
    assert.equal(sent.at(-1).headers['apns-topic'], 'com.example.servant');
    assert.deepEqual(signedBy(sent.at(-1)), { kid: 'own-key', iss: 'own-team', own: true, other: false });
  }
  // The second app: its own key, its own team, and its bundle id as the topic.
  assert.equal((await send(device('com.example.other'), alert)).ok, true);
  assert.equal(sent.at(-1).headers['apns-topic'], 'com.example.other');
  assert.deepEqual(signedBy(sent.at(-1)), { kid: 'other-key', iss: 'other-team', own: false, other: true });
  // Then the first again: one app's sign-in is never reused for the other.
  assert.equal((await send(device(), alert)).ok, true);
  assert.deepEqual(signedBy(sent.at(-1)), { kid: 'own-key', iss: 'own-team', own: true, other: false });
  // An app this server has no credentials for: nothing leaves, and the token is kept for when it does.
  const before = sent.length;
  assert.deepEqual(await send(device('com.example.unknown'), alert), { ok: false, invalid: false, retry: false, code: 'APP_NOT_CONFIGURED' });
  assert.equal(sent.length, before);
  // Adding its credentials later starts the alerts with no restart (the file is read for every send).
  config.apps['com.example.unknown'] = { apnsKeyPath: other.file, apnsKeyId: 'other-key', apnsTeamId: 'other-team', apnsTopic: 'com.example.unknown' };
  assert.equal((await send(device('com.example.unknown'), alert)).ok, true);
  assert.equal(sent.at(-1).headers['apns-topic'], 'com.example.unknown');

  assert.equal(pushCredentials(config, { platform: 'ios' }), config);
  assert.equal(pushCredentials({ ...config, apps: undefined }, { platform: 'ios', app: 'com.example.other' }), null);
  assert.equal(pushCredentials({ ...config, apps: undefined }, { platform: 'android', app: 'com.example.other' }).apnsKeyId, 'own-key', 'an Android app without its own entry uses the server\'s FCM project');
  assert.equal(pushCredentials({ ...config, apps: { __proto__: { evil: {} } } }, { platform: 'ios', app: 'evil' }), null, 'only its own entries count');
});
