'use strict';

/**
 * test/test-command.js — the project's test command, frozen at session start
 * (slice B8; brief v4 lines 283, 349 and 245's `frozen_config`; decision LD70).
 * Projects are built here in throwaway folders; no real data. The tokens below
 * are made-up strings of a secret's shape, not real keys.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const crypto = require('crypto');
const { testCommandFrom, testCommandChange } = require('../src/opon/intake/test-command');
const { canonicalize } = require('../src/verify/canonical');

const FAKE_GH = 'ghp_' + 'a1B2c3D4e5'.repeat(4).slice(0, 36);
const sha = (s) => 'sha256:' + crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

const withRoot = (fn) => () => {
  const root = fs.realpathSync(tmpDir());
  try {
    fn(root);
  } finally {
    rmrf(root);
  }
};
const writePkg = (root, pkg) => fs.writeFileSync(path.join(root, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg, null, 2));
const PKG = { name: 'p', version: '1.0.0', scripts: { test: 'node test/all.js', unit: 'node test/unit.js' }, dependencies: {} };

it(
  "the test command is package.json's scripts.test, with where it came from and a fingerprint of the scripts block",
  withRoot((root) => {
    writePkg(root, PKG);
    assert.deepStrictEqual(testCommandFrom(root), {
      text: 'node test/all.js',
      source: { path: 'package.json', key: 'scripts.test' },
      scripts_fingerprint: sha(canonicalize(PKG.scripts)),
    });
  }),
);

it(
  'no package.json, one that is not JSON, or one whose scripts is not an object: every value is null (unknown)',
  withRoot((root) => {
    const none = { text: null, source: null, scripts_fingerprint: null };
    assert.deepStrictEqual(testCommandFrom(root), none, 'no file');
    writePkg(root, '{ not json');
    assert.deepStrictEqual(testCommandFrom(root), none, 'not JSON');
    writePkg(root, { scripts: ['node x'] });
    assert.deepStrictEqual(testCommandFrom(root), none, 'scripts is an array');
    writePkg(root, 'null');
    assert.deepStrictEqual(testCommandFrom(root), none, 'the file is JSON null');
    writePkg(root, '{"scripts":{"test":"node t.js","x":"\\ud800"}}');
    assert.deepStrictEqual(testCommandFrom(root), none, 'a block the canonical form cannot hold (a lone surrogate) is unknown, so it cannot break the header');
  }),
);

it(
  'a scripts block with no test script: no command, but the block is still frozen',
  withRoot((root) => {
    writePkg(root, { scripts: { build: 'tsc' } });
    assert.deepStrictEqual(testCommandFrom(root), { text: null, source: null, scripts_fingerprint: sha(canonicalize({ build: 'tsc' })) });
    writePkg(root, { scripts: { test: 7 } });
    assert.strictEqual(testCommandFrom(root).text, null, 'a test script that is not a string is no command');
  }),
);

it(
  'a secret in a script never reaches the header, in the text or behind the fingerprint',
  withRoot((root) => {
    writePkg(root, { scripts: { test: `GH=${FAKE_GH} node test/all.js` } });
    const t = testCommandFrom(root);
    assert.ok(!JSON.stringify(t).includes(FAKE_GH), 'the token is gone');
    assert.strictEqual(t.text, 'GH=[REDACTED:github_token] node test/all.js');
    assert.strictEqual(t.scripts_fingerprint, sha(canonicalize({ test: 'GH=[REDACTED:github_token] node test/all.js' })), 'the fingerprint is of the redacted block');
    const env = 'a-long-env-value-1234';
    writePkg(root, { scripts: { test: `TOKEN=${env} jest` } });
    assert.strictEqual(testCommandFrom(root, [env]).text, 'TOKEN=[REDACTED:env_value] jest', '.env values are redacted too');
  }),
);

it(
  "a change outside the scripts block (an npm install, a version bump) is not tampering",
  withRoot((root) => {
    writePkg(root, PKG);
    const frozen = testCommandFrom(root);
    writePkg(root, { ...PKG, version: '1.0.1', dependencies: { lodash: '^4.17.21' } });
    assert.strictEqual(testCommandChange(frozen, root), null);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(PKG)); // the same block, written differently
    assert.strictEqual(testCommandChange(frozen, root), null, 'formatting is not a change');
    writePkg(root, { ...PKG, scripts: { unit: PKG.scripts.unit, test: PKG.scripts.test } });
    assert.strictEqual(testCommandChange(frozen, root), null, 'the same scripts in another key order are not a change');
  }),
);

it(
  'a change to the test script is tampering with frozen configuration, with the evidence',
  withRoot((root) => {
    writePkg(root, PKG);
    const frozen = testCommandFrom(root);
    writePkg(root, { ...PKG, scripts: { ...PKG.scripts, test: 'exit 0' } });
    const now = testCommandFrom(root);
    assert.deepStrictEqual(testCommandChange(frozen, root), {
      what: 'frozen_config',
      frozen: 'test_command',
      fingerprint_before: frozen.scripts_fingerprint,
      fingerprint: now.scripts_fingerprint,
      test_changed: true,
      text_before: 'node test/all.js',
      text: 'exit 0',
    });
  }),
);

it(
  'a change to another script is tampering too, since the test script can run it; test_changed says the test text itself held',
  withRoot((root) => {
    writePkg(root, { ...PKG, scripts: { test: 'npm run unit', unit: 'node test/unit.js' } });
    const frozen = testCommandFrom(root);
    writePkg(root, { ...PKG, scripts: { test: 'npm run unit', unit: 'true' } });
    const c = testCommandChange(frozen, root);
    assert.strictEqual(c.what, 'frozen_config');
    assert.strictEqual(c.test_changed, false);
    assert.notStrictEqual(c.fingerprint, c.fingerprint_before);
  }),
);

it(
  'package.json removed, or a scripts block added where there was none: tampering',
  withRoot((root) => {
    writePkg(root, PKG);
    const frozen = testCommandFrom(root);
    fs.rmSync(path.join(root, 'package.json'));
    const gone = testCommandChange(frozen, root);
    assert.strictEqual(gone.fingerprint, null);
    assert.strictEqual(gone.test_changed, true);
    const empty = testCommandFrom(root);
    writePkg(root, PKG);
    assert.strictEqual(testCommandChange(empty, root).fingerprint_before, null);
    assert.strictEqual(testCommandChange(empty, root).fingerprint, frozen.scripts_fingerprint);
  }),
);

it(
  'only a regular file of at most 1 MiB is read: a FIFO cannot stall the session start, and a huge file cannot fill the header (LD71)',
  withRoot((root) => {
    const none = { text: null, source: null, scripts_fingerprint: null };
    writePkg(root, JSON.stringify({ scripts: { test: 'x'.repeat(1024 * 1024) } }));
    assert.deepStrictEqual(testCommandFrom(root), none, 'over 1 MiB');
    fs.rmSync(path.join(root, 'package.json'));
    fs.mkdirSync(path.join(root, 'package.json'));
    assert.deepStrictEqual(testCommandFrom(root), none, 'a folder');
    fs.rmdirSync(path.join(root, 'package.json'));
    if (process.platform === 'win32') return; // no mkfifo on Windows; the folder case above covers "not a regular file" there
    require('child_process').execFileSync('mkfifo', [path.join(root, 'package.json')]);
    assert.deepStrictEqual(testCommandFrom(root), none, 'a FIFO');
  }),
);

it(
  'a script named __proto__ is a script like any other: its change is seen',
  withRoot((root) => {
    writePkg(root, '{"scripts":{"test":"node t.js","__proto__":"a"}}');
    const frozen = testCommandFrom(root);
    writePkg(root, '{"scripts":{"test":"node t.js","__proto__":"b"}}');
    assert.notStrictEqual(testCommandChange(frozen, root), null);
  }),
);

runAll('test-command');
