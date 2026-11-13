import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateLegal, renderLegalPage } from './generate-legal.mjs';

const homepage = '<link rel="canonical" href="https://example.gov/"><header><nav><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav></header><footer>Personal server</footer>';
test('legal pages retain server text inside the personal site design and escape public fields', () => {
  const options = { contactEmail: 'contact@example.gov', footer: 'Operator <example>' };
  for (const kind of ['terms', 'privacy']) {
    const html = renderLegalPage(kind, options, homepage);
    assert.ok(html.includes('href="/style.css"'));
    assert.ok(html.includes(`href="/${kind}" aria-current="page"`));
    assert.ok(html.includes(`href="https://example.gov/${kind}"`));
    assert.ok(html.includes('mailto:contact@example.gov'));
    assert.ok(html.includes('Operator &lt;example&gt;'));
    assert.ok(html.includes('Signing out removes'));
    assert.ok(!html.includes('__cf_email__'));
  }
  assert.ok(renderLegalPage('terms', options, homepage).includes('Original commitments'));
  assert.ok(renderLegalPage('privacy', options, homepage).includes('Builds configured with Firebase Crashlytics'));
});
test('regeneration copies only public contact fields and never server secrets', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-legal-'));
  try {
    const config = path.join(scratch, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ contactEmail: 'contact@example.gov', footer: 'Example server', upstreams: { owner: { key: 'not-for-public-html' } }, adminToken: 'another-private-value' }));
    const output = path.join(scratch, 'public');
    generateLegal(config, output);
    for (const file of ['privacy.html', 'terms.html']) {
      const html = fs.readFileSync(path.join(output, file), 'utf8');
      assert.ok(html.includes('contact@example.gov'));
      assert.ok(!html.includes('not-for-public-html'));
      assert.ok(!html.includes('another-private-value'));
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
