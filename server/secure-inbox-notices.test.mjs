// Reply emails for someone writing through the public page (docs/secure-inbox.md, "Reply emails").
// Before this a visitor was never told the team had replied: the page said "There are no email notifications",
// and whoever closed the tab had to remember to come back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSecureInbox, NOTICE_CODE_MINUTES } from './secure-inbox.mjs';
import { codeMail, createInboxNotices, inboxNoticeSettings, noticeMail } from './secure-inbox-notices.mjs';

const staff = { id: 'owner', name: 'Pat Tester', role: 'owner' };
const users = () => ({ owner: staff });
const request = extra => ({ requestId: crypto.randomUUID(), ...extra });
const startInput = extra => request({ name: 'Ana Ruiz', email: 'ana@example.gov', subject: 'Example account review', text: 'I need help updating the example account.', ...extra });
const ORIGIN = 'https://chat.example.gov';
const MINUTE = 60_000;
function setup(t, options = {}) {
  const clock = { at: Date.UTC(2026, 10, 11, 10) };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-notices-'));
  const inbox = createSecureInbox({ directory, users, now: () => clock.at, ...options });
  t.after(() => { inbox.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { inbox, clock };
}
// A conversation whose visitor has confirmed an address.
function confirmed(inbox, extra) {
  const started = inbox.start(startInput(extra));
  const { mail } = inbox.guestNotifyStart(started.token, { email: 'ana@example.gov' });
  inbox.guestNotifyConfirm(started.token, { code: mail.code });
  return started;
}
const kinds = (inbox, id) => inbox.activity(staff, id).activity.map(event => event.kind);
const refuses = (work, code) => assert.throws(work, error => error.code === code, `expected ${code}`);

test('an address is used only after its code is typed into the conversation it was given for', t => {
  const { inbox } = setup(t);
  const started = inbox.start(startInput());
  const id = started.conversation.id;
  assert.equal(started.created, true);
  assert.deepEqual(started.notify, { state: 'none', email: null }, 'a contact address alone turns nothing on');
  const { notify, mail } = inbox.guestNotifyStart(started.token, { email: ' Ana@Example.gov ' });
  assert.deepEqual(notify, { state: 'pending', email: 'ana@example.gov' });
  assert.deepEqual({ to: mail.to, minutes: mail.minutes }, { to: 'ana@example.gov', minutes: NOTICE_CODE_MINUTES });
  assert.match(mail.code, /^\d{6}$/);
  assert.deepEqual(inbox.claimNotices(ORIGIN, { delayMs: 0 }), [], 'nothing is emailed to an address nobody has confirmed');

  const wrong = mail.code === '000000' ? '000001' : '000000';
  refuses(() => inbox.guestNotifyConfirm(started.token, { code: wrong }), 'notice_code_wrong');
  refuses(() => inbox.guestNotifyConfirm(started.token, { code: '12345' }), 'notice_code_wrong');
  refuses(() => inbox.guestNotifyConfirm(started.token, {}), 'notice_code_wrong');
  const other = inbox.start(startInput());
  refuses(() => inbox.guestNotifyConfirm(other.token, { code: mail.code }), 'notice_code_expired');
  assert.deepEqual(inbox.guestNotifyConfirm(started.token, { code: ` ${mail.code.slice(0, 3)} ${mail.code.slice(3)} ` }).notify, { state: 'on', email: 'ana@example.gov' });
  assert.deepEqual(inbox.guestDetail(started.token).notify, { state: 'on', email: 'ana@example.gov' });
  assert.deepEqual(inbox.caseDetail(staff, id).notify, { state: 'on', email: 'ana@example.gov' }, 'the team sees whether the visitor is told');
  assert.deepEqual(kinds(inbox, id), ['case.created', 'notice.on']);
  refuses(() => inbox.guestNotifyConfirm(started.token, { code: mail.code }), 'notice_code_expired');
  refuses(() => inbox.guestNotifyStart(started.token, { email: 'jo@example.gov' }), 'notice_on');
});

test('a code stops working after five wrong tries or thirty minutes, and a new one replaces it', t => {
  const { inbox, clock } = setup(t);
  const started = inbox.start(startInput());
  const first = inbox.guestNotifyStart(started.token, { email: 'ana@example.gov' }).mail.code;
  const wrong = first === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i++) refuses(() => inbox.guestNotifyConfirm(started.token, { code: wrong }), 'notice_code_wrong');
  refuses(() => inbox.guestNotifyConfirm(started.token, { code: first }), 'notice_code_expired');
  const second = inbox.guestNotifyStart(started.token, { email: 'ana@example.gov' }).mail.code;
  clock.at += NOTICE_CODE_MINUTES * MINUTE + 1;
  refuses(() => inbox.guestNotifyConfirm(started.token, { code: second }), 'notice_code_expired');
  const third = inbox.guestNotifyStart(started.token, { email: 'ana@example.gov' }).mail.code;
  assert.equal(inbox.guestNotifyConfirm(started.token, { code: third }).notify.state, 'on');
});

test('an address that could reach a second recipient or a mail header is refused', t => {
  const { inbox } = setup(t);
  const { token } = inbox.start(startInput());
  for (const email of ['', 'ana', 'ana@example', 'ana@example.gov\nBcc: jo@example.gov', 'ana@example.gov%0aBcc:jo@example.gov', 'ana@example.gov, jo@example.gov', 'ana @example.gov', 'a..b@example.gov', `${'a'.repeat(65)}@example.gov`, null, 7, ['ana@example.gov']]) {
    refuses(() => inbox.guestNotifyStart(token, { email }), 'invalid_email');
  }
  assert.deepEqual(inbox.guestDetail(token).notify, { state: 'none', email: null });
});

test('codes are limited for a conversation and for a mailbox, so the public page cannot be used to mail someone over and over', t => {
  const { inbox } = setup(t);
  const one = inbox.start(startInput());
  for (let i = 0; i < 5; i++) inbox.guestNotifyStart(one.token, { email: `ana${i}@example.gov` });
  refuses(() => inbox.guestNotifyStart(one.token, { email: 'ana9@example.gov' }), 'rate_limited');
  for (let i = 0; i < 5; i++) inbox.guestNotifyStart(inbox.start(startInput()).token, { email: 'jo@example.gov' });
  refuses(() => inbox.guestNotifyStart(inbox.start(startInput()).token, { email: 'jo@example.gov' }), 'rate_limited');
});

test('a team reply the visitor has not read is emailed once it has waited, and a burst of replies is one email', t => {
  const { inbox, clock } = setup(t);
  const started = confirmed(inbox);
  const id = started.conversation.id;
  assert.deepEqual(inbox.claimNotices(ORIGIN), [], 'the visitor\'s own message is not news to them');
  const first = inbox.staffPost(staff, id, request({ text: 'We received your details.' })).message;
  clock.at += 30_000;
  assert.deepEqual(inbox.claimNotices(ORIGIN), [], 'not yet: they may be reading along');
  const second = inbox.staffPost(staff, id, request({ text: 'One more question.' })).message;
  clock.at += 31_000;
  const [notice, ...rest] = inbox.claimNotices(ORIGIN);
  assert.deepEqual(rest, []);
  assert.deepEqual({ id: notice.id, to: notice.to, through: notice.through }, { id, to: 'ana@example.gov', through: second.sequence });
  assert.ok(second.sequence > first.sequence);
  // The link is the same private return link the team can copy, and it opens this conversation only.
  assert.equal(notice.url, inbox.visitorLink(staff, id, ORIGIN).url);
  const token = /^https:\/\/chat\.example\.gov\/contact#resume=([A-Za-z0-9_-]{43})$/.exec(notice.url)[1];
  assert.equal(inbox.guestDetail(token).conversation.id, id);
  assert.deepEqual(inbox.claimNotices(ORIGIN), [], 'a claimed notice is not handed out twice');
  inbox.noticeSent(notice.id, notice.through);
  assert.deepEqual(kinds(inbox, id), ['case.created', 'notice.on', 'case.link-created', 'notice.sent']);
  // The team can see afterwards who turned emails on and where each one went.
  assert.deepEqual(inbox.activity(staff, id).activity.filter(event => event.kind.startsWith('notice.')).map(event => [event.actorName, event.text]),
    [['Ana Ruiz', 'Turned on reply emails to ana@example.gov.'], ['System', 'Emailed ana@example.gov that a reply is waiting.']]);
  clock.at += 10 * MINUTE;
  assert.deepEqual(inbox.claimNotices(ORIGIN), [], 'one email for the unread batch, not one per pass');
  inbox.staffPost(staff, id, request({ text: 'A later reply.' }));
  clock.at += 61_000;
  assert.equal(inbox.claimNotices(ORIGIN).length, 1, 'each later reply is told again');
});

test('no email goes to someone who has read the reply, turned emails off, or not finished confirming', t => {
  const { inbox, clock } = setup(t);
  const reader = confirmed(inbox);
  const reply = inbox.staffPost(staff, reader.conversation.id, request({ text: 'Read on the page.' })).message;
  inbox.guestRead(reader.token, reply.sequence);
  const stopped = confirmed(inbox);
  inbox.staffPost(staff, stopped.conversation.id, request({ text: 'After they stopped.' }));
  assert.deepEqual(inbox.guestNotifyStop(stopped.token).notify, { state: 'off', email: 'ana@example.gov' });
  const pending = inbox.start(startInput());
  inbox.guestNotifyStart(pending.token, { email: 'ana@example.gov' });
  inbox.staffPost(staff, pending.conversation.id, request({ text: 'Before they confirmed.' }));
  const never = inbox.start(startInput());
  inbox.staffPost(staff, never.conversation.id, request({ text: 'They gave an address but no code.' }));
  clock.at += 5 * MINUTE;
  assert.deepEqual(inbox.claimNotices(ORIGIN), []);
  assert.deepEqual(kinds(inbox, stopped.conversation.id), ['case.created', 'notice.on', 'notice.off']);
  assert.deepEqual(inbox.guestNotifyStop(stopped.token).notify.state, 'off', 'stopping twice is not an error');
  assert.equal(kinds(inbox, stopped.conversation.id).length, 3);
});

test('a reply written before the address was confirmed is not emailed afterwards: the person confirming is on the page', t => {
  const { inbox, clock } = setup(t);
  const started = inbox.start(startInput());
  inbox.staffPost(staff, started.conversation.id, request({ text: 'Already here when they confirm.' }));
  const { mail } = inbox.guestNotifyStart(started.token, { email: 'ana@example.gov' });
  inbox.guestNotifyConfirm(started.token, { code: mail.code });
  clock.at += 5 * MINUTE;
  assert.deepEqual(inbox.claimNotices(ORIGIN), []);
});

test('nothing is claimed without a public address to link to, and private team work never causes an email', t => {
  const { inbox, clock } = setup(t);
  const started = confirmed(inbox);
  const id = started.conversation.id;
  inbox.addNote(staff, id, request({ text: 'Internal discussion' }));
  inbox.addTask(staff, id, request({ text: 'Review evidence' }));
  inbox.update(staff, id, { status: 'resolved' });
  clock.at += 5 * MINUTE;
  assert.deepEqual(inbox.claimNotices(ORIGIN), [], 'notes, follow-ups and resolving are not replies');
  inbox.staffPost(staff, id, request({ text: 'A reply.' }));
  clock.at += 61_000;
  for (const origin of ['', undefined, 'http://chat.example.gov', 'https://chat.example.gov/hubs/example-app']) assert.deepEqual(inbox.claimNotices(origin), []);
  assert.equal(inbox.claimNotices(ORIGIN).length, 1);
});

test('a failed email is tried again later and recorded once; sending is limited per conversation', t => {
  const { inbox, clock } = setup(t, { limits: { noticesPerConversationPerHour: 2 } });
  const started = confirmed(inbox);
  const id = started.conversation.id;
  inbox.staffPost(staff, id, request({ text: 'First.' }));
  clock.at += 61_000;
  const [notice] = inbox.claimNotices(ORIGIN);
  inbox.noticeFailed(notice.id);
  assert.deepEqual(inbox.claimNotices(ORIGIN), [], 'not straight away');
  clock.at += 5 * MINUTE + 1;
  const [again] = inbox.claimNotices(ORIGIN);
  assert.equal(again.through, notice.through);
  inbox.noticeFailed(again.id);
  assert.deepEqual(kinds(inbox, id).filter(kind => kind === 'notice.failed'), ['notice.failed'], 'one record, however many tries');
  assert.equal(inbox.activity(staff, id).activity.find(event => event.kind === 'notice.failed').text, 'Could not email ana@example.gov about a reply. The server will try again.');
  clock.at += 10 * MINUTE + 1;
  assert.deepEqual(inbox.claimNotices(ORIGIN), [], 'two were claimed this hour, which is this conversation\'s limit');
  clock.at += 61 * MINUTE;
  const [third] = inbox.claimNotices(ORIGIN);
  inbox.noticeSent(third.id, third.through);
  assert.deepEqual(kinds(inbox, id).slice(-1), ['notice.sent']);
});

test('the two emails say what to do and carry nothing from the conversation', () => {
  const code = codeMail({ team: 'Example team', code: '482913', minutes: 30 });
  assert.equal(code.subject, 'Your code for Example team is 482913');
  assert.match(code.text, /^Your code is 482913\./);
  assert.match(code.text, /works for 30 minutes/);
  assert.match(code.text, /If you did not ask for this, ignore this email\./);
  const notice = noticeMail({ team: 'Example team', url: 'https://chat.example.gov/contact#resume=abc' });
  assert.equal(notice.subject, 'New reply from Example team');
  assert.match(notice.text, /^Example team replied to your conversation\.\n\nRead the reply and answer here:\nhttps:\/\/chat\.example\.gov\/contact#resume=abc\n/);
  assert.match(notice.text, /This link is private\./);
  assert.match(notice.text, /To stop these emails, open the link and choose Stop emails\./);
  assert.equal(noticeMail({ team: 'Example\r\nBcc: jo@example.gov', url: 'u' }).subject, 'New reply from Example Bcc: jo@example.gov', 'a team name cannot add a header');
  assert.equal(codeMail({ team: '', code: '000000', minutes: 30 }).subject, 'Your code for the team is 000000');
});

test('the server needs a mailer and a public address before it offers or sends email', () => {
  const mailer = { command: '/path/to/send-mail.sh' };
  assert.equal(inboxNoticeSettings({ publicUrl: ORIGIN, secureInbox: { mailer } }).ready, true);
  assert.equal(inboxNoticeSettings({ publicUrl: ORIGIN, emailVerification: { mailer } }).ready, true, 'the sign-in mailer is the default');
  assert.equal(inboxNoticeSettings({ publicUrl: ORIGIN, emailVerification: { mailer: { command: 'a' } }, secureInbox: { mailer } }).mailer, mailer, 'the inbox\'s own mailer wins');
  assert.equal(inboxNoticeSettings({ publicUrl: ORIGIN }).ready, false);
  assert.equal(inboxNoticeSettings({ publicUrl: ORIGIN, secureInbox: { mailer: { command: '  ' } } }).ready, false);
  assert.equal(inboxNoticeSettings({ publicUrl: 'https://chat.example.gov/hubs/example-app', secureInbox: { mailer } }).ready, false, 'a relay address cannot serve the page the email links to');
  assert.equal(inboxNoticeSettings({ secureInbox: { mailer } }).ready, false);
  assert.equal(inboxNoticeSettings({}).delayMs, 60_000);
  assert.equal(inboxNoticeSettings({ secureInbox: { noticeDelaySeconds: 5 } }).delayMs, 5000);
  assert.equal(inboxNoticeSettings({ secureInbox: { noticeDelaySeconds: 0 } }).delayMs, 0);
  for (const bad of [-1, '5', null, NaN]) assert.equal(inboxNoticeSettings({ secureInbox: { noticeDelaySeconds: bad } }).delayMs, 60_000);
  assert.equal(inboxNoticeSettings({ secureInbox: { noticeDelaySeconds: 99999 } }).delayMs, 3600_000);
});

test('end to end: a code, then one email per unread reply, and no message text ever leaves the server', async t => {
  const { inbox, clock } = setup(t);
  const outbox = [];
  const config = { name: 'Example team', publicUrl: ORIGIN, secureInbox: { mailer: { command: 'send' } } };
  const notices = createInboxNotices({ inbox: () => inbox, config: () => config, send: async (message, settings) => { outbox.push({ message, command: settings.mailer.command }); }, log: () => {} });
  assert.equal(notices.available(), true);
  const started = inbox.start(startInput());
  const id = started.conversation.id;
  assert.deepEqual((await notices.begin(started.token, { email: 'ana@example.gov' })).notify, { state: 'pending', email: 'ana@example.gov' });
  assert.equal(outbox.length, 1);
  assert.deepEqual(Object.keys(outbox[0].message).sort(), ['code', 'minutes', 'subject', 'text', 'to']);
  assert.equal(outbox[0].message.to, 'ana@example.gov');
  inbox.guestNotifyConfirm(started.token, { code: outbox[0].message.code });
  inbox.staffPost(staff, id, request({ text: 'Secret reply about the account.', attachments: [{ name: 'secret-next-steps.txt', data: Buffer.from('private').toString('base64') }] }));
  assert.equal(await notices.sweep(), 0, 'not within the first minute');
  clock.at += 61_000;
  assert.equal(await notices.sweep(), 1);
  assert.equal(await notices.sweep(), 0);
  const sent = outbox[1].message;
  assert.deepEqual(Object.keys(sent).sort(), ['subject', 'text', 'to', 'url']);
  assert.equal(sent.to, 'ana@example.gov');
  assert.equal(sent.url, inbox.visitorLink(staff, id, ORIGIN).url);
  assert.ok(sent.text.includes(sent.url));
  const everything = JSON.stringify(outbox);
  for (const secret of ['Secret reply', 'secret-next-steps', 'Example account review', 'I need help', 'Pat Tester', 'Ana Ruiz', 'CASE-', id]) assert.ok(!everything.includes(secret), `${secret} is not in any email`);
  assert.deepEqual(kinds(inbox, id), ['case.created', 'notice.on', 'case.link-created', 'notice.sent']);
});

test('a code that cannot be sent is forgotten, the address is kept for another try, and a failed notice does not stop the next', async t => {
  const { inbox, clock } = setup(t);
  let fail = true;
  const sent = [];
  const config = { name: 'Example team', publicUrl: ORIGIN, secureInbox: { mailer: { command: 'send' } } };
  const logged = [];
  const notices = createInboxNotices({ inbox: () => inbox, config: () => config, send: async message => { if (fail) throw new Error('Email delivery failed'); sent.push(message); }, log: line => logged.push(line) });
  const started = inbox.start(startInput());
  await assert.rejects(notices.begin(started.token, { email: 'ana@example.gov' }), error => error.status === 502 && error.code === 'email_send_failed' && /could not be sent/.test(error.message));
  assert.deepEqual(inbox.guestDetail(started.token).notify, { state: 'off', email: 'ana@example.gov' });
  assert.ok(logged.every(line => !line.includes('ana@example.gov')), 'the log does not keep the address');
  fail = false;
  const { notify } = await notices.begin(started.token, { email: 'ana@example.gov' });
  assert.equal(notify.state, 'pending');
  inbox.guestNotifyConfirm(started.token, { code: sent[0].code });
  inbox.staffPost(staff, started.conversation.id, request({ text: 'Reply.' }));
  clock.at += 61_000;
  fail = true;
  assert.equal(await notices.sweep(), 0);
  fail = false;
  assert.equal(await notices.sweep(), 0, 'waits before trying again');
  clock.at += 5 * MINUTE + 1;
  assert.equal(await notices.sweep(), 1);
  assert.deepEqual(kinds(inbox, started.conversation.id).slice(-2), ['notice.failed', 'notice.sent']);
});

test('with no mailer nothing is offered or sent', async t => {
  const { inbox, clock } = setup(t);
  const notices = createInboxNotices({ inbox: () => inbox, config: () => ({ name: 'Example team', publicUrl: ORIGIN }), send: async () => { throw new Error('must not be called'); }, log: () => {} });
  assert.equal(notices.available(), false);
  const started = inbox.start(startInput());
  await assert.rejects(notices.begin(started.token, { email: 'ana@example.gov' }), error => error.status === 503 && error.code === 'email_unavailable');
  assert.deepEqual(inbox.guestDetail(started.token).notify, { state: 'none', email: null });
  clock.at += 5 * MINUTE;
  assert.equal(await notices.sweep(), 0);
  assert.equal(await notices.idle(), 0);
});
