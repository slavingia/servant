import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceDeviceKind, sourceDeviceFields, privateMessageView } from './source-device.mjs';

test('device categories use only known session labels and canonical presentation', () => {
  for (const label of ['iPhone', 'Android phone', 'Phone', 'iPad']) assert.equal(sourceDeviceKind({ label }), 'mobile');
  assert.equal(sourceDeviceKind({ label: 'Mac' }), 'computer');
  assert.equal(sourceDeviceKind({ label: 'Browser' }), 'web');
  for (const label of ['', 'Alice secret workstation name', 'fake-Mac-browser']) assert.equal(sourceDeviceKind({ label }), null);
  assert.deepEqual(sourceDeviceFields('mobile', { role: 'owner' }), { sourceDevice: { kind: 'mobile', label: 'Mobile' } });
  for (const role of ['member', 'admin', undefined]) assert.deepEqual(sourceDeviceFields('computer', { role }), {});
  assert.deepEqual(sourceDeviceFields(null, { role: 'owner' }), {});
});

test('private projection ignores supplied provenance and requires a local user-message snapshot', () => {
  const fake = { id: 'msg_x', role: 'user', text: 'hello', sourceDevice: { kind: 'web', label: 'secret arbitrary label' } };
  const map = new Map([['msg_x', 'mobile']]);
  assert.deepEqual(privateMessageView(fake, { role: 'owner' }, map).sourceDevice, { kind: 'mobile', label: 'Mobile' });
  assert.ok(!('sourceDevice' in privateMessageView(fake, { role: 'member' }, map)));
  assert.ok(!('sourceDevice' in privateMessageView(fake, { role: 'owner' }, new Map())));
  assert.ok(!('sourceDevice' in privateMessageView({ ...fake, role: 'assistant' }, { role: 'owner' }, map)));
});

test('an agent sign-in is marked, and its label reaches everyone, unlike mobile and computer', () => {
  assert.equal(sourceDeviceKind({ label: 'Anything', agent: true }), 'agent');
  for (const label of ['Hermes on Mac', 'hermes', 'MCP client', 'Agent', 'Automation']) assert.equal(sourceDeviceKind({ label }), 'agent');
  assert.equal(sourceDeviceKind({ label: 'Hermes-lookalike-phone' }), null);
  assert.equal(sourceDeviceKind({ label: 'Mac' }), 'computer');
  for (const role of ['owner', 'member', undefined]) assert.deepEqual(sourceDeviceFields('agent', { role }), { sourceDevice: { kind: 'agent', label: 'Posted by agent' } });
  assert.deepEqual(sourceDeviceFields('mobile', { role: 'member' }), {});
});
