import test from 'node:test';
import assert from 'node:assert/strict';
import { surveyReplyUrl } from './survey-reply.ts';

test('email reply opens one recipient with the survey subject and no feedback body', () => {
  const url = new URL(surveyReplyUrl(' pat.tester+survey@EXAMPLE.GOV ', 'Website experience')!);
  assert.equal(url.protocol, 'mailto:');
  assert.equal(decodeURIComponent(url.pathname), 'pat.tester+survey@example.gov');
  assert.deepEqual([...url.searchParams], [['subject', 'Re: Website experience']]);
  assert.equal(url.hash, '');
  assert.equal(surveyReplyUrl('pat@example.gov', '')?.endsWith('?subject=Survey%20feedback'), true);
});

test('missing or unsafe contact values cannot introduce recipients, headers, or another URL scheme', () => {
  for (const email of [null, undefined, '', 'not-an-email', 'pat@example.gov,jo@example.gov', 'pat@example.gov;jo@example.gov',
    'Pat <pat@example.gov>', 'pat@example.gov?bcc=jo@example.gov', 'pat@example.gov#fragment', 'pat@example.gov\r\nBcc:jo@example.gov',
    '\npat@example.gov', 'pat\u0000@example.gov', 'pat%0d%0abcc=jo@example.gov', 'pat%0A@example.gov', 'pat%0D@example.gov', 'mailto:pat@example.gov', 'https://example.gov',
    'pat..tester@example.gov', '.pat@example.gov', 'pat@example..gov', `${'a'.repeat(250)}@example.gov`]) {
    assert.equal(surveyReplyUrl(email, 'Survey'), null, String(email));
  }
});

test('accepted mailbox question marks and percent signs are encoded without creating URL headers', () => {
  for (const email of ['pat%team@example.gov', 'pat?reply@example.gov', 'pat?bcc=jo&subject=hello%team@example.gov']) {
    const url = new URL(surveyReplyUrl(email, 'Survey')!);
    assert.equal(decodeURIComponent(url.pathname), email);
    assert.deepEqual([...url.searchParams], [['subject', 'Re: Survey']]);
    assert.equal(url.hash, '');
    assert.ok(url.pathname.includes('%25') || url.pathname.includes('%3F'));
  }
});

test('reply addresses follow the server mailbox and domain length limits', () => {
  assert.ok(surveyReplyUrl(`${'a'.repeat(64)}@example.gov`, 'Survey'));
  assert.equal(surveyReplyUrl(`${'a'.repeat(65)}@example.gov`, 'Survey'), null);
  assert.ok(surveyReplyUrl(`pat@${'a'.repeat(63)}.gov`, 'Survey'));
  assert.equal(surveyReplyUrl(`pat@${'a'.repeat(64)}.gov`, 'Survey'), null);
});

test('mailbox punctuation and subject URL syntax stay encoded within their own fields', () => {
  const url = new URL(surveyReplyUrl("pat&jo#team@example.gov", 'Survey?bcc=jo@example.gov&body=private#fragment\r\nBcc: someone')!);
  assert.equal(decodeURIComponent(url.pathname), 'pat&jo#team@example.gov');
  assert.equal(url.hash, '');
  assert.deepEqual([...url.searchParams], [['subject', 'Re: Survey?bcc=jo@example.gov&body=private#fragment Bcc: someone']]);
  assert.doesNotMatch(url.searchParams.get('subject')!, /[\r\n\u0000-\u001f\u007f]/);
  assert.equal(surveyReplyUrl('pat@example.gov', '\ud800'), null);
});
