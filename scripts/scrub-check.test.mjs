import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicPaths = ['deploy/personal/README.md', ...['index', 'support', 'privacy', 'terms'].map(name => `deploy/personal/public/${name}.html`)];
const creditPath = 'app/project-credit.json';
const run = (cwd, command, args) => spawnSync(command, args, { cwd, encoding: 'utf8' });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-scrub-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(run(root, 'git', ['init', '-q']).status, 0);
  for (const file of ['scripts/scrub-check.sh', 'scripts/scrub-denylist.txt', 'scripts/scrub-public-lines.py', ...publicPaths, creditPath]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(source, file), path.join(root, file));
  }
  assert.equal(run(root, 'git', ['add', '.']).status, 0);
  return { root, check: () => run(root, 'bash', ['scripts/scrub-check.sh']) };
}

test('reviewed public identity lines pass while every eligible file is still scanned', t => {
  const f = fixture(t);
  const result = f.check();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /scrub-check: OK/);
});

test('unapproved identities, mailboxes, private paths and denied invitation terms fail in the same files', t => {
  const f = fixture(t);
  // Split denied literals so this test source does not itself publish them.
  const forbidden = [
    ['Str', 'uble'].join(''),
    ['unexpected@', 'gmail.com'].join(''),
    ['/Us', 'ers/', 'private-person', '/secrets.env'].join(''),
    ['https://testflight.apple.com/join/', 'qn5JQ', 'PyS'].join(''),
    ['EXBV39', 'ZXGR'].join(''),
  ];
  for (const file of publicPaths) {
    const target = path.join(f.root, file);
    const original = fs.readFileSync(target, 'utf8');
    for (const text of forbidden) {
      fs.writeFileSync(target, `${original}\nUnexpected: ${text}\n`);
      const result = f.check();
      assert.equal(result.status, 1, `${file} must remain subject to the denylist`);
      assert.ok(result.stdout.includes(file));
    }
    fs.writeFileSync(target, original);
  }
});

test('adding prohibited content to an approved line cannot inherit its exception', t => {
  const f = fixture(t);
  for (const file of publicPaths) {
    const target = path.join(f.root, file);
    const original = fs.readFileSync(target, 'utf8');
    const lines = original.split('\n');
    const index = file.endsWith('README.md') ? 0 : lines.findIndex(line => line.includes('rel="canonical"'));
    assert.ok(index >= 0);
    lines[index] += [' ', 'unexpected@', 'gmail.com'].join('');
    fs.writeFileSync(target, lines.join('\n'));
    assert.equal(f.check().status, 1, `changed approved line in ${file}`);
    fs.writeFileSync(target, original);
  }
});

test('approved identity text has no exception in another context or path', t => {
  const f = fixture(t);
  const original = fs.readFileSync(path.join(f.root, publicPaths[0]), 'utf8');
  const heading = original.split('\n')[0];
  fs.writeFileSync(path.join(f.root, publicPaths[0]), original + `\nPrivate note: ${heading}\n`);
  assert.equal(f.check().status, 1, 'different context in the same allowed file');
  fs.writeFileSync(path.join(f.root, publicPaths[0]), original);
  fs.writeFileSync(path.join(f.root, 'unapproved.md'), heading + '\n');
  run(f.root, 'git', ['add', 'unapproved.md']);
  assert.equal(f.check().status, 1, 'same complete approved line in an unapproved file');
});

test('filenames never receive public-line exceptions', t => {
  const f = fixture(t);
  const filename = ['deploy/personal/public/', 'Sa', 'hil', '-private.txt'].join('');
  fs.writeFileSync(path.join(f.root, filename), 'Ordinary content\n');
  run(f.root, 'git', ['add', filename]);
  const result = f.check();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /:0:<file name>/);
});

test('a missing policy helper fails closed', t => {
  const f = fixture(t);
  fs.rmSync(path.join(f.root, 'scripts/scrub-public-lines.py'));
  assert.notEqual(f.check().status, 0);
});


test('public project credit permits only the reviewed name and website fields', t => {
  const f = fixture(t);
  const target = path.join(f.root, creditPath);
  const original = fs.readFileSync(target, 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(original)), ['name', 'url']);
  assert.equal(f.check().status, 0, 'the approved four-line JSON passes');
  for (const change of [
    data => ({ ...data, name: data.name + ' private' }),
    data => ({ ...data, url: data.url + '/private' }),
    data => ({ author: data.name, url: data.url }),
  ]) {
    fs.writeFileSync(target, JSON.stringify(change(JSON.parse(original)), null, 2) + '\n');
    assert.equal(f.check().status, 1, 'unreviewed field values or context must fail');
  }
  fs.writeFileSync(target, JSON.stringify(JSON.parse(original)) + '\n');
  assert.equal(f.check().status, 1, 'reformatting cannot bypass full-line review');
});

test('extra fields and nested private data cannot inherit the project credit exception', t => {
  const f = fixture(t);
  const target = path.join(f.root, creditPath);
  const original = fs.readFileSync(target, 'utf8');
  const fields = [
    ['note', 'unreviewed but otherwise ordinary text'],
    ['mailbox', ['unexpected@', 'gmail.com'].join('')],
    ['file', ['/Us', 'ers/', 'private-person', '/secrets.env'].join('')],
    ['accessToken', 'synthetic-fixture-not-a-real-token'],
  ];
  for (const [key, value] of fields) {
    // Insert before the existing fields, preserving BOTH approved lines exactly.
    const changed = original.replace('{\n', `{\n  ${JSON.stringify(key)}: ${JSON.stringify(value)},\n`);
    assert.equal(JSON.parse(changed)[key], value);
    fs.writeFileSync(target, changed);
    assert.equal(f.check().status, 1, `extra ${key} field invalidates the credit exceptions`);
  }
  const nested = '{\n  "private": ' + original.trim() + '\n}\n';
  assert.ok(JSON.parse(nested).private);
  fs.writeFileSync(target, nested);
  assert.equal(f.check().status, 1, 'unchanged field lines inside another object remain unapproved');
});

test('copying or moving project credit to another file does not grant an exception', t => {
  const f = fixture(t);
  const target = path.join(f.root, creditPath);
  const original = fs.readFileSync(target, 'utf8');
  for (const file of ['app/private-credit.json', 'project-credit.json']) {
    fs.writeFileSync(path.join(f.root, file), original);
    assert.equal(run(f.root, 'git', ['add', file]).status, 0);
    assert.equal(f.check().status, 1, 'identical credit in another path fails');
    fs.rmSync(path.join(f.root, file));
  }
  const moved = 'app/moved-credit.json';
  fs.renameSync(target, path.join(f.root, moved));
  assert.equal(run(f.root, 'git', ['add', moved]).status, 0);
  assert.equal(f.check().status, 1, 'moving the approved file does not move its exception');
});
