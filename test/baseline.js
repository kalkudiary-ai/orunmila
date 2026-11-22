'use strict';

/**
 * test/baseline.js — the baseline snapshot, station 4 (Phase 3 slice N1a,
 * LD169; brief v4 lines 385, 387, 390, 250). Made-up files in a temp folder.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const crypto = require('crypto');
const { snapshot } = require('../src/opon/net/baseline');
const { fingerprint } = require('../src/opon/intake/redact');

const KEY = Buffer.alloc(32, 7);
const sha = (b) => 'sha256:' + crypto.createHash('sha256').update(b).digest('hex');

function tree() {
  const root = fs.realpathSync(tmpDir());
  const put = (p, c) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), c);
  };
  put('src/a.js', 'one\n');
  put('src/deep/b.txt', 'two\n');
  put('node_modules/x/index.js', 'dep\n');
  put('.env', 'TOKEN=abcdefgh12345678\n');
  fs.symlinkSync('/etc/hosts', path.join(root, 'outside-link'));
  return root;
}

it('N1a: every file under the root but the exclusions, sorted, each with its size and fingerprint; a link is listed, never followed', () => {
  const root = tree();
  try {
    const b = snapshot(root, { exclusions: ['node_modules/'], key: KEY });
    assert.deepStrictEqual(b.entries.map((e) => e.path), ['.env', 'outside-link', 'src/a.js', 'src/deep/b.txt']);
    const a = b.entries.find((e) => e.path === 'src/a.js');
    assert.deepStrictEqual(a, { path: 'src/a.js', size: 4, fingerprint: sha('one\n') });
    assert.deepStrictEqual(b.entries.find((e) => e.path === 'outside-link'), { path: 'outside-link', kind: 'link' });
    assert.strictEqual(b.files, 3);
    assert.strictEqual(b.bytes, 4 + 4 + 'TOKEN=abcdefgh12345678\n'.length);
    // Sorted by path, not by walk order: `src.txt` sorts before `src/` ('.' before '/').
    fs.writeFileSync(path.join(root, 'src.txt'), 'x');
    fs.writeFileSync(path.join(root, 'src', 'Upper.JS'), 'u');
    const c = snapshot(root, { exclusions: ['node_modules/'], key: KEY, caseInsensitive: true });
    assert.deepStrictEqual(c.entries.map((e) => e.path), ['.env', 'outside-link', 'src.txt', 'src/a.js', 'src/deep/b.txt', 'src/upper.js']);
    assert.ok(snapshot(root, { exclusions: ['node_modules/'], key: KEY, caseInsensitive: false }).entries.some((e) => e.path === 'src/Upper.JS'), 'a case-sensitive disk keeps the case');
  } finally {
    rmrf(root);
  }
});

it('N1a: a file on the redaction list is fingerprinted with the install key (line 250); without the key the snapshot refuses', () => {
  const root = tree();
  try {
    const env = fs.readFileSync(path.join(root, '.env'));
    const b = snapshot(root, { exclusions: ['node_modules/'], key: KEY });
    assert.strictEqual(b.entries.find((e) => e.path === '.env').fingerprint, fingerprint('.env', env, KEY));
    assert.throws(() => snapshot(root, { exclusions: ['node_modules/'] }), /install key/);
  } finally {
    rmrf(root);
  }
});

it('N1a: a large file is hashed in chunks, to the same fingerprint as the whole bytes (line 390)', () => {
  const root = fs.realpathSync(tmpDir());
  try {
    const big = crypto.randomBytes(5000);
    fs.writeFileSync(path.join(root, 'big.bin'), big);
    const b = snapshot(root, { exclusions: [], key: KEY, chunkBytes: 1024 });
    assert.deepStrictEqual(b.entries, [{ path: 'big.bin', size: 5000, fingerprint: sha(big) }]);
  } finally {
    rmrf(root);
  }
});

it('N1a: the snapshot file is canonical JSON lines, the same text twice, and its fingerprint is of those bytes (line 387)', () => {
  const root = tree();
  try {
    const one = snapshot(root, { exclusions: ['node_modules/'], key: KEY });
    const two = snapshot(root, { exclusions: ['node_modules/'], key: KEY });
    assert.strictEqual(one.text, two.text);
    assert.strictEqual(one.text.split('\n').length, one.entries.length + 1);
    assert.deepStrictEqual(one.text.split('\n').slice(0, -1).map((l) => JSON.parse(l)), one.entries);
    assert.strictEqual(one.fingerprint, sha(Buffer.from(one.text, 'utf8')));
  } finally {
    rmrf(root);
  }
});

runAll('baseline');
