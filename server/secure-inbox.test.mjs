import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSecureInbox, secureInboxPublicUrl } from './secure-inbox.mjs';

const staff = { id: 'owner', name: 'Pat Tester', role: 'owner' };
const member = { id: 'member', name: 'Jo Park', role: 'member' };
const users = () => ({ owner: staff, member });
const message = (text = 'Hello', extra = {}) => ({ text, requestId: crypto.randomUUID(), ...extra });
const start = (extra = {}) => ({ name: 'Ana Ruiz', subject: 'A private question', ...message(), ...extra });
const file = (name = 'example.txt', content = 'private document') => ({ name, data: Buffer.from(content).toString('base64') });
function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-inbox-'));
  let inbox = createSecureInbox({ directory, users, ...options });
  t.after(() => { inbox.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { get inbox() { return inbox; }, directory, restart() { inbox.close(); inbox = createSecureInbox({ directory, users, ...options }); return inbox; } };
}

test('public entry link uses only a configured direct HTTPS origin or loopback development origin', () => {
  assert.equal(secureInboxPublicUrl('https://chat.example.gov'), 'https://chat.example.gov/contact');
  assert.equal(secureInboxPublicUrl('https://chat.example.gov/'), 'https://chat.example.gov/contact');
  assert.equal(secureInboxPublicUrl('https://chat.example.gov:8443'), 'https://chat.example.gov:8443/contact');
  for (const local of ['localhost', '127.0.0.1', '[::1]']) assert.equal(secureInboxPublicUrl(`http://${local}:8080/`), `http://${local}:8080/contact`);
  for (const input of [undefined, null, {}, '', 'not a URL', '//chat.example.gov', 'http://chat.example.gov', 'ftp://chat.example.gov', 'https://chat.example.gov/hubs/example-app', 'https://chat.example.gov/contact', 'https://chat.example.gov//', 'https://user:secret@chat.example.gov', 'https://user@chat.example.gov', 'https://chat.example.gov/?secret=value', 'https://chat.example.gov/#secret']) {
    assert.equal(secureInboxPublicUrl(input), null, String(input));
  }
});

test('a visitor starts a durable conversation, staff reply, both sides exchange files, and reads are per person', t => {
  const { inbox } = setup(t);
  const started = inbox.start(start({ email: 'ana@example.gov', attachments: [file()] }), { ip: '127.0.0.1' });
  const id = started.conversation.id;
  assert.equal(started.messages.length, 1);
  assert.equal(started.messages[0].sender, 'visitor');
  assert.equal(started.conversation.email, 'ana@example.gov');
  assert.equal(started.conversation.unread, 0);
  assert.equal(inbox.list(staff).conversations[0].unread, 1);
  const original = started.messages[0].attachments[0];
  assert.equal(inbox.staffFile(staff, id, original.id).file.data, file().data);
  assert.equal(inbox.guestFile(started.token, original.id).file.mime, 'application/octet-stream');
  const reply = inbox.staffPost(staff, id, message('Here is the answer', { attachments: [file('answer.pdf')] }));
  assert.equal(reply.message.senderName, 'Pat Tester');
  assert.equal(inbox.guestDetail(started.token).conversation.unread, 1);
  assert.equal(inbox.guestFile(started.token, reply.message.attachments[0].id).file.data, file().data);
  inbox.staffRead(staff, id, started.messages[0].sequence);
  assert.equal(inbox.list(staff).conversations[0].unread, 0);
  assert.equal(inbox.list(member).conversations[0].unread, 1);
  inbox.guestRead(started.token, reply.message.sequence);
  inbox.guestRead(started.token, 0); // Old tab cannot move a watermark backwards.
  assert.equal(inbox.guestDetail(started.token).conversation.unread, 0);
  assert.throws(() => inbox.guestRead(started.token, reply.message.sequence + 1), { code: 'cursor' });
  assert.throws(() => inbox.staffRead(staff, id, -1), { code: 'cursor' });
});

test('guest tokens and attachment IDs cannot read another conversation or list the team inbox', t => {
  const { inbox } = setup(t);
  const a = inbox.start(start({ attachments: [file()] }));
  const b = inbox.start(start({ name: 'Jo Park', attachments: [file('other.txt')] }));
  assert.notEqual(a.token, b.token);
  assert.equal(inbox.guestDetail(a.token).conversation.id, a.conversation.id);
  assert.throws(() => inbox.guestFile(b.token, a.messages[0].attachments[0].id), { status: 404 });
  assert.throws(() => inbox.staffFile(staff, a.conversation.id, b.messages[0].attachments[0].id), { status: 404 });
  assert.throws(() => inbox.guestDetail(staff.id), { status: 401 });
  assert.throws(() => inbox.list({ id: a.token }), { status: 403 });
  assert.throws(() => inbox.staffDetail({ id: 'removed' }, a.conversation.id), { status: 403 });
  assert.equal(inbox.guestDetail(a.token).conversation.assigneeId, null);
});

test('status and assignment keep content, visitors reopen resolved work, and search/filter list correctly', t => {
  const { inbox } = setup(t);
  const a = inbox.start(start());
  inbox.update(staff, a.conversation.id, { status: 'resolved', assigneeId: member.id });
  assert.equal(inbox.list(staff).conversations.length, 0);
  assert.equal(inbox.list(staff, { status: 'resolved' }).conversations[0].assigneeName, member.name);
  assert.equal(inbox.list(staff, { status: 'all', q: 'private' }).conversations.length, 1);
  assert.equal(inbox.list(staff, { status: 'all', q: 'missing' }).conversations.length, 0);
  assert.equal(inbox.guestDetail(a.token).conversation.assigneeId, null);
  const reopened = inbox.guestPost(a.token, message('One more thing'));
  assert.equal(reopened.conversation.status, 'open');
  assert.equal(inbox.guestDetail(a.token).messages.length, 2);
  inbox.update(staff, a.conversation.id, { assigneeId: null });
  assert.equal(inbox.staffDetail(staff, a.conversation.id).conversation.assigneeId, null);
  assert.throws(() => inbox.update(staff, a.conversation.id, { assigneeId: 'missing' }), { code: 'assignee' });
  assert.throws(() => inbox.update(staff, a.conversation.id, { assigneeId: { toString: 'not a function' } }), { code: 'assignee' });
  assert.throws(() => inbox.update(staff, a.conversation.id, { status: 'deleted' }), { code: 'status' });
  assert.throws(() => inbox.update(staff, a.conversation.id, { subject: 'replace original' }), { code: 'invalid_update' });
});

test('retrying a start or send is idempotent across process restarts, and reused IDs cannot alter authored text', t => {
  const fixture = setup(t);
  const input = start({ attachments: [file()] });
  const a = fixture.inbox.start(input);
  assert.equal(fixture.inbox.start(input).token, a.token);
  assert.equal(fixture.inbox.list(staff).conversations.length, 1);
  assert.throws(() => fixture.inbox.start({ ...input, text: 'changed' }), { status: 409 });
  const outgoing = message('Thank you', { attachments: [file('thanks.txt')] });
  const first = fixture.inbox.guestPost(a.token, outgoing);
  assert.equal(fixture.inbox.guestPost(a.token, outgoing).message.id, first.message.id);
  assert.throws(() => fixture.inbox.guestPost(a.token, { ...outgoing, text: 'changed' }), { status: 409 });
  fixture.restart();
  assert.equal(fixture.inbox.start(input).token, a.token);
  assert.equal(fixture.inbox.guestPost(a.token, outgoing).message.id, first.message.id);
  assert.equal(fixture.inbox.guestDetail(a.token).messages.length, 2);
  assert.equal(fixture.inbox.guestFile(a.token, first.message.attachments[0].id).file.data, file().data);
  const bytes = fs.readFileSync(path.join(fixture.directory, 'inbox.db'));
  assert.equal(bytes.includes(Buffer.from(a.token)), false);
  assert.equal(bytes.includes(Buffer.from(input.requestId)), false);
  assert.equal(fs.statSync(path.join(fixture.directory, 'inbox-key')).mode & 0o777, 0o600);
});

test('authored content and files refuse update or delete, including when preservation is enabled elsewhere', t => {
  const { inbox, directory } = setup(t);
  const a = inbox.start(start({ attachments: [file()] }));
  const db = new DatabaseSync(path.join(directory, 'inbox.db'));
  t.after(() => db.close());
  for (const sql of [
    "UPDATE inbox_conversations SET subject='changed'", 'DELETE FROM inbox_conversations',
    "UPDATE inbox_messages SET text='changed'", 'DELETE FROM inbox_messages',
    "UPDATE inbox_files SET name='changed'", 'DELETE FROM inbox_files',
  ]) assert.throws(() => db.exec(sql), /Inbox content is permanent/);
  assert.equal(inbox.guestDetail(a.token).messages[0].text, 'Hello');
  assert.equal(inbox.guestFile(a.token, a.messages[0].attachments[0].id).file.data, file().data);
});

test('validation rejects empty messages, unsafe file names, malformed encoding, large content, and invalid cursors', t => {
  const { inbox } = setup(t);
  for (const extra of [{ name: '' }, { subject: '' }, { email: 'not an address' }, { text: '' }, { text: 'a'.repeat(20_001) }, { requestId: 'short' }, { attachments: [file('../private')] }, { attachments: [{ name: 'a', data: 'x===' }] }, { attachments: Array.from({ length: 5 }, () => file()) }]) {
    assert.throws(() => inbox.start(start(extra)), error => error.status === 400);
  }
  const a = inbox.start(start());
  assert.throws(() => inbox.guestDetail(a.token, -1), { code: 'cursor' });
  assert.throws(() => inbox.guestDetail(a.token, 1.5), { code: 'cursor' });
  assert.throws(() => inbox.guestPost(a.token, null), { code: 'invalid_body' });
  const big = { name: 'big.bin', data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') };
  assert.throws(() => inbox.guestPost(a.token, message('', { attachments: [big] })), error => [400, 413].includes(error.status));
  assert.equal(inbox.guestDetail(a.token).messages.length, 1);
});

test('rate limits survive restarts, reset with time, count file-only messages, and retries do not consume quota', t => {
  let at = 100 * 60 * 60 * 1000;
  const fixture = setup(t, { now: () => at, limits: { startsPerHour: 1, messagesPerMinute: 2 } });
  const input = start();
  const a = fixture.inbox.start(input, { ip: '127.0.0.1' });
  fixture.inbox.start(input, { ip: '127.0.0.1' });
  assert.throws(() => fixture.inbox.start(start(), { ip: '127.0.0.1' }), { status: 429 });
  fixture.restart();
  assert.throws(() => fixture.inbox.start(start(), { ip: '127.0.0.1' }), { status: 429 });
  const send = message('', { attachments: [file()] });
  fixture.inbox.guestPost(a.token, send);
  fixture.inbox.guestPost(a.token, send);
  assert.throws(() => fixture.inbox.guestPost(a.token, message('third')), { status: 429 });
  at += 60 * 60 * 1000;
  assert.ok(fixture.inbox.start(start(), { ip: '127.0.0.1' }).token);
  assert.ok(fixture.inbox.guestPost(a.token, message('after reset')).message);
});

test('bounded message pages have no gaps and conversation limits refuse atomically without losing originals', t => {
  const { inbox } = setup(t, { limits: { messagesPerMinute: 1000, messagesPerConversation: 102, bytesPerConversation: 30 } });
  const a = inbox.start(start());
  for (let i = 0; i < 101; i++) inbox.guestPost(a.token, message(`Message ${i}`));
  const first = inbox.guestDetail(a.token);
  assert.equal(first.messages.length, 100);
  assert.equal(first.hasMore, true);
  const second = inbox.guestDetail(a.token, first.messages.at(-1).sequence);
  assert.equal(second.messages.length, 2);
  assert.equal(second.hasMore, false);
  assert.throws(() => inbox.guestPost(a.token, message('too many')), { code: 'conversation_full' });
  const b = inbox.start(start({ attachments: [file()] }));
  assert.throws(() => inbox.guestPost(b.token, message('', { attachments: [file('large.txt', 'a'.repeat(31))] })), { code: 'conversation_full' });
  assert.equal(inbox.guestDetail(b.token).messages.length, 1);
});

test('global content quotas count UTF-8 bytes, survive restart, and retain existing content on refusal', t => {
  const initial = start({ text: 'é'.repeat(20), attachments: [file()] });
  const initialBytes = Buffer.byteLength(initial.name + initial.subject + initial.text) + Buffer.from(attachmentData(initial), 'base64').length;
  const fixture = setup(t, { limits: { totalBytes: initialBytes + 4 } });
  const a = fixture.inbox.start(initial);
  const successful = message('four');
  fixture.inbox.staffPost(staff, a.conversation.id, successful);
  fixture.inbox.staffPost(staff, a.conversation.id, successful); // Retry reserves nothing twice.
  assert.throws(() => fixture.inbox.guestPost(a.token, message('x')), { status: 507, code: 'inbox_full' });
  assert.throws(() => fixture.inbox.start(start()), { status: 507 });
  fixture.restart();
  assert.throws(() => fixture.inbox.guestPost(a.token, message('', { attachments: [file()] })), { status: 507 });
  assert.equal(fixture.inbox.list(staff).conversations.length, 1);
  assert.equal(fixture.inbox.guestDetail(a.token).messages.length, 2);
  assert.equal(fixture.inbox.guestFile(a.token, a.messages[0].attachments[0].id).file.data, file().data);
  fixture.inbox.update(staff, a.conversation.id, { status: 'resolved' });
  assert.equal(fixture.inbox.guestDetail(a.token).conversation.status, 'resolved');
});

const attachmentData = input => input.attachments[0].data;

test('global conversation and message quotas roll back partial starts without affecting existing conversations', t => {
  const conversationLimit = setup(t, { limits: { totalConversations: 1 } });
  const first = conversationLimit.inbox.start(start());
  assert.throws(() => conversationLimit.inbox.start(start()), { code: 'inbox_full' });
  assert.equal(conversationLimit.inbox.list(staff).conversations.length, 1);
  assert.ok(conversationLimit.inbox.guestPost(first.token, message('Reply still fits')));
  const messageLimit = setup(t, { limits: { totalMessages: 1 } });
  const second = messageLimit.inbox.start(start());
  assert.throws(() => messageLimit.inbox.start(start()), { code: 'inbox_full' });
  assert.throws(() => messageLimit.inbox.staffPost(staff, second.conversation.id, message()), { code: 'inbox_full' });
  assert.equal(messageLimit.inbox.list(staff).conversations.length, 1);
  assert.equal(messageLimit.inbox.guestDetail(second.token).messages.length, 1);
});

// Staff saw only an unread count in Cases when a visitor wrote. A visitor's message now resolves to an alert the
// way a direct message does, for the people who should hear about it.
test('a visitor message alerts the assignee, or every team member when nobody is assigned, until they have read it', t => {
  const { inbox } = setup(t);
  const started = inbox.start(start({ text: 'Is my example account open?' }), { ip: '127.0.0.1' });
  const id = started.conversation.id, first = started.messages[0].sequence;
  const alert = inbox.notificationFor(staff, id, first);
  assert.deepEqual(alert, { kind: 'dm', caseId: id, title: 'Ana Ruiz · CASE-000001', body: 'Is my example account open?' });
  assert.deepEqual(inbox.notificationFor(member, id, first), alert, 'unassigned: every team member');
  assert.equal(inbox.notificationFor({ id: 'stranger' }, id, first), null, 'not someone on the team');
  assert.equal(inbox.notificationFor(staff, 'inbox_missing', first), null);
  assert.equal(inbox.notificationFor(staff, id, 'x'), null);

  inbox.staffRead(member, id, first);
  assert.equal(inbox.notificationFor(member, id, first), null, 'already read');
  assert.ok(inbox.notificationFor(staff, id, first), 'reads are per person');

  const reply = inbox.staffPost(staff, id, message('Yes, it is.'));
  assert.equal(inbox.notificationFor(member, id, reply.message.sequence), null, 'a teammate\'s reply is not a visitor message');

  inbox.update(staff, id, { assigneeId: 'member' });
  const next = inbox.guestPost(started.token, message('', { attachments: [file()] }));
  assert.deepEqual(inbox.notificationFor(member, id, next.message.sequence), { kind: 'dm', caseId: id, title: 'Ana Ruiz · CASE-000001', body: 'Sent an attachment' });
  assert.equal(inbox.notificationFor(staff, id, next.message.sequence), null, 'assigned to someone else');
});

test('a case whose assignee has left the team alerts everyone again', t => {
  const people = { owner: staff, member };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-inbox-'));
  const inbox = createSecureInbox({ directory, users: () => people });
  t.after(() => { inbox.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const started = inbox.start(start(), { ip: '127.0.0.1' });
  const id = started.conversation.id;
  inbox.update(staff, id, { assigneeId: 'member' });
  assert.equal(inbox.notificationFor(staff, id, started.messages[0].sequence), null);
  delete people.member;
  assert.ok(inbox.notificationFor(staff, id, started.messages[0].sequence));
});
