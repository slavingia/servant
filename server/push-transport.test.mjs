import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import { createPushTransport } from './push-transport.mjs';

test('APNs sends alerts and calls using the configured app topic and signed credentials', async t => {
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
    for (const voip of [false, true]) {
      const result = await send({ platform: voip ? 'ios-voip' : 'ios', token: 'a'.repeat(64), environment: voip ? 'development' : 'production' }, {
        title: 'A message', body: 'Hello', data: { conversationId: 'ch_test' },
        call: { meetingId: 'meet_test', caller: 'A friend', place: 'Test room' },
      });
      assert.equal(result.ok, true);
      const request = sent.at(-1);
      assert.equal(request.host, voip ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
      assert.equal(request.headers[':method'], 'POST');
      assert.equal(request.headers[':path'], '/3/device/' + 'a'.repeat(64));
      assert.equal(request.headers['apns-topic'], (topic || 'com.example.servant') + (voip ? '.voip' : ''));
      assert.equal(request.headers['apns-push-type'], voip ? 'voip' : 'alert');
      if (voip) {
        assert.equal(request.body.meetingId, 'meet_test');
        assert.equal(request.body.aps, undefined);
        assert.equal(request.headers['apns-collapse-id'], undefined);
      } else {
        assert.equal(request.body.aps.alert.body, 'Hello');
        assert.equal(request.body.body.conversationId, 'ch_test');
        assert.ok(request.headers['apns-collapse-id']);
      }
      const [header, payload, signature] = request.headers.authorization.replace(/^bearer /, '').split('.');
      assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'fixture-key' });
      assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, 'fixture-team');
      assert.ok(crypto.verify('sha256', Buffer.from(header + '.' + payload), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
      assert.equal(request.destroyed, true);
    }
  }
  assert.equal(sent.length, 6);
});
