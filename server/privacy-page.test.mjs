import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privacyPage } from './privacy-page.mjs';

test('the privacy page shows config contactEmail, or points at the server owner when unset', () => {
  const none = privacyPage();
  assert.match(none, /Servant privacy policy/);
  // No address anywhere in what the page says (its stylesheet has @media, which is not an address).
  assert.doesNotMatch(none.replace(/<style>[\s\S]*?<\/style>/, ''), /mailto:|@/);
  assert.match(none, /To delete your account and data, ask the person who runs your team's server\./);
  assert.match(none, /Questions: ask the person who runs your team's server\./);
  assert.doesNotMatch(privacyPage({ contactEmail: '' }), /mailto:/);
  assert.doesNotMatch(privacyPage({ contactEmail: 'not an email' }), /mailto:/);

  const set = privacyPage({ contactEmail: ' privacy@example.gov ' });
  assert.equal(set.match(/<a href="mailto:privacy@example\.gov">privacy@example\.gov<\/a>/g).length, 2);
  assert.match(set, /or email <!--email_off--><a href="mailto:privacy@example\.gov">/);
  assert.equal(set.match(/<!--email_off-->/g).length, 2, "both contacts stay readable when Cloudflare email obfuscation is enabled");
  assert.doesNotMatch(privacyPage({ contactEmail: 'a@b.c"><script>' }), /<script>/);
});

test('the privacy page shows the optional footer, escaped and capped, and nothing when unset', () => {
  const note = 'A personal project of Pat Tester, who does not speak for any agency';
  assert.match(privacyPage({ footer: note }), /A personal project of Pat Tester, who does not speak for any agency<\/p>\n<\/body>/);
  assert.doesNotMatch(privacyPage(), /personal project/);
  assert.doesNotMatch(privacyPage({ footer: '   ' }), /class="footer/);
  assert.doesNotMatch(privacyPage({ footer: '<script>x</script>' }), /<script>/);
  assert.doesNotMatch(privacyPage({ footer: 'a'.repeat(400) }), /a{301}/);
});
