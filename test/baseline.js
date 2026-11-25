// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
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

it('N1c: a file or folder that cannot be read is listed as unreadable, with its error code, and the walk goes on (cold pass of N1b)', () => {
  const root = tree();
  try {
    fs.writeFileSync(path.join(root, 'src', 'locked.txt'), 'x');
    fs.chmodSync(path.join(root, 'src', 'locked.txt'), 0o000);
    fs.mkdirSync(path.join(root, 'shut'));
    fs.writeFileSync(path.join(root, 'shut', 'in.txt'), 'y');
    fs.chmodSync(path.join(root, 'shut'), 0o000);
    const b = snapshot(root, { exclusions: ['node_modules/'], key: KEY });
    assert.deepStrictEqual(b.entries.find((e) => e.path === 'src/locked.txt'), { path: 'src/locked.txt', kind: 'unreadable', error: 'EACCES' });
    assert.deepStrictEqual(b.entries.find((e) => e.path === 'shut'), { path: 'shut', kind: 'unreadable', error: 'EACCES' });
    assert.ok(b.entries.some((e) => e.path === 'src/a.js'), 'the rest is still walked');
    assert.strictEqual(b.files, 3, 'an unreadable file is not counted as a file read');
  } finally {
    fs.chmodSync(path.join(root, 'shut'), 0o700);
    rmrf(root);
  }
});

// ---- N1b: the snapshot written beside the log, its fingerprint in the header (LD170)

const net = require('net');
const { spawn } = require('child_process');
const { createRouter } = require('../src/opon/intake/router');
const { createSessionLog, openSessionLog, verifySessionLog } = require('../src/opon/ledger/session-log');
const { buildHeader } = require('../src/opon/intake/header');
const { oponLive } = require('../src/opon/intake/server');
const { nowMono } = require('../src/opon/intake/mono');
const { compile } = require('../src/verify/schema');

const SRC = path.join(__dirname, '..', 'src');
const ENV_VALUE = 'abcdefgh12345678';
const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));

/** A throwaway home and project with a router; `opts` are the router's. */
function withProject(fn, opts = {}) {
  return async () => {
    const base = fs.realpathSync(tmpDir());
    const home = path.join(base, 'h');
    const project = path.join(base, 'p');
    const put = (p, c) => {
      fs.mkdirSync(path.dirname(path.join(project, p)), { recursive: true });
      fs.writeFileSync(path.join(project, p), c);
    };
    put('src/a.js', 'one\n');
    put('node_modules/x/index.js', 'dep\n');
    put('.env', `TOKEN=${ENV_VALUE}\n`);
    put(`notes-${ENV_VALUE}.txt`, 'a file whose name holds a .env value\n');
    const clock = () => ({ mono: nowMono(), wall: new Date().toISOString() });
    const router = createRouter({ home, clock, checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], config: { exclusions: ['node_modules/'] }, ...opts });
    const start = { session_id: 'ses_b1', transcript_path: '/tmp/t.jsonl', cwd: project, hook_event_name: 'SessionStart', source: 'startup' };
    try {
      await fn({ router, start, home, project, dir: path.join(home, 'sessions', 'ses_b1') });
    } finally {
      rmrf(base);
    }
  };
}

it(
  'N1b: with the baseline on, the session log is made with baseline.jsonl beside it and its fingerprint in the header; the walk skips the header\'s config.exclusions; a path holding a .env value is redacted, as a mark\'s is',
  withProject(
    ({ router, start, dir }) => {
      assert.strictEqual(router.payload(start, { channel: 'command' }).ok, true);
      const header = readLines(path.join(dir, 'raw.jsonl'))[0];
      const bytes = fs.readFileSync(path.join(dir, 'baseline.jsonl'));
      assert.deepStrictEqual(header.baseline, { fingerprint: sha(bytes) });
      assert.deepStrictEqual(header.config.exclusions, ['node_modules/']);
      const entries = readLines(path.join(dir, 'baseline.jsonl'));
      assert.deepStrictEqual(entries.map((e) => e.path), ['.env', 'notes-[REDACTED:env_value].txt', 'src/a.js']);
      assert.deepStrictEqual(entries[1].redactions, ['env_value']);
      const checkEntry = compile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'baseline.schema.json'), 'utf8')));
      for (const e of entries) assert.deepStrictEqual(checkEntry(e), [], JSON.stringify(e));
      assert.ok(!bytes.toString('utf8').includes(ENV_VALUE), 'the value is never written');
      assert.ok(entries[0].fingerprint.startsWith('hmac-sha256:'), 'the .env is keyed');
      assert.strictEqual((fs.statSync(path.join(dir, 'baseline.jsonl')).mode & 0o777).toString(8), '600');
      const v = verifySessionLog(dir);
      assert.strictEqual(v.ok, true, v.words);
      assert.match(v.words, /; the baseline snapshot of 3 entries matches the header\.$/);
    },
    { baseline: true },
  ),
);

it(
  'N1c: with the baseline on, a file that cannot be read never stops the session log being made',
  withProject(
    ({ router, start, project, dir }) => {
      fs.writeFileSync(path.join(project, 'src', 'locked.txt'), 'x');
      fs.chmodSync(path.join(project, 'src', 'locked.txt'), 0o000);
      const r = router.payload(start, { channel: 'command' });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.ok(readLines(path.join(dir, 'baseline.jsonl')).some((e) => e.path === 'src/locked.txt' && e.kind === 'unreadable'));
      assert.strictEqual(verifySessionLog(dir).ok, true);
    },
    { baseline: true },
  ),
);

it(
  'N1b: with the baseline off (the default), no baseline file is written and the header has no baseline field: nothing changes',
  withProject(({ router, start, dir }) => {
    assert.strictEqual(router.payload(start, { channel: 'command' }).ok, true);
    assert.strictEqual(fs.existsSync(path.join(dir, 'baseline.jsonl')), false);
    assert.strictEqual('baseline' in readLines(path.join(dir, 'raw.jsonl'))[0], false);
    assert.doesNotMatch(verifySessionLog(dir).words, /baseline/);
  }),
);

it(
  'A1a: with the live path on, the header carries the byproducts list (config.byproducts); off, the header has none',
  async () => {
    for (const on of [true, false]) {
      await withProject(
        ({ router, start, project, dir }) => {
          fs.mkdirSync(path.join(project, '.orunmila'));
          fs.writeFileSync(path.join(project, '.orunmila', 'byproducts'), 'dist/\n');
          assert.strictEqual(router.payload(start, { channel: 'command' }).ok, true);
          const header = readLines(path.join(dir, 'raw.jsonl'))[0];
          assert.deepStrictEqual(header.config.byproducts, on ? ['dist/'] : undefined, `live path ${on ? 'on' : 'off'}`);
          assert.strictEqual(header.frozen.byproducts, sha('dist/\n'));
        },
        on ? { baseline: true } : {},
      )();
    }
  },
);

it(
  'N1b: verify says so when the baseline snapshot beside the log was changed or is missing, and a log so broken is never reopened',
  withProject(
    ({ router, start, dir }) => {
      router.payload(start, { channel: 'command' });
      const file = path.join(dir, 'baseline.jsonl');
      fs.appendFileSync(file, '{"path":"planted"}\n');
      let v = verifySessionLog(dir);
      assert.strictEqual(v.ok, false);
      assert.match(v.words, /^Record broken: the baseline snapshot kept beside the log \(sha256:[0-9a-f]{64}\) was changed after it was written\.$/);
      assert.throws(() => openSessionLog(dir), /cannot be reopened: Record broken: the baseline snapshot/);
      fs.rmSync(file);
      v = verifySessionLog(dir);
      assert.strictEqual(v.ok, false);
      assert.match(v.words, /the baseline snapshot kept beside the log \(sha256:[0-9a-f]{64}\) is missing\.$/);
    },
    { baseline: true },
  ),
);

it('N1b: the session log refuses a header baseline that does not match the snapshot given, and either one without the other', () => {
  const base = fs.realpathSync(tmpDir());
  try {
    fs.mkdirSync(path.join(base, 'p'));
    const header = buildHeader({ sessionId: 'ses_b2', root: path.join(base, 'p'), agent: { name: 'claude-code' }, orunmilaVersion: '0.0.0-test', codeRoot: SRC });
    const text = '{"path":"a","size":0,"fingerprint":"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}\n';
    const dir = (n) => path.join(base, `s${n}`);
    assert.throws(() => createSessionLog(dir(1), { ...header, baseline: { fingerprint: sha('other') } }, { baseline: text }), /does not match/);
    assert.throws(() => createSessionLog(dir(2), { ...header, baseline: { fingerprint: sha(text) } }), /baseline/);
    assert.throws(() => createSessionLog(dir(3), header, { baseline: text }), /baseline/);
    for (const n of [1, 2, 3]) assert.strictEqual(fs.existsSync(path.join(dir(n), 'raw.jsonl')), false, 'nothing is written when refused');
    createSessionLog(dir(4), { ...header, baseline: { fingerprint: sha(text) } }, { baseline: text });
    assert.strictEqual(fs.readFileSync(path.join(dir(4), 'baseline.jsonl'), 'utf8'), text);
    assert.strictEqual(verifySessionLog(dir(4)).ok, true);
    // The leak check (LD101) searches the snapshot as it does every kept file: a value that got past redaction is reported by name.
    const leaky = `{"path":"notes-${ENV_VALUE}.txt","size":0,"fingerprint":"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}\n`;
    const log = createSessionLog(dir(5), { ...header, baseline: { fingerprint: sha(leaky) } }, { baseline: leaky, envEntries: [{ names: ['TOKEN'], value: ENV_VALUE }] });
    assert.deepStrictEqual(log.leaks().map((h) => [h.log, h.names]), [['baseline', ['TOKEN']]]);
  } finally {
    rmrf(base);
  }
});

it('N1b: ORUNMILA_OPON_LIVE=1, and nothing else, turns the live path on (LD166)', () => {
  assert.strictEqual(oponLive({}), false);
  assert.strictEqual(oponLive({ ORUNMILA_OPON_LIVE: '1' }), true);
  for (const v of ['', '0', 'true', 'yes', ' 1']) assert.strictEqual(oponLive({ ORUNMILA_OPON_LIVE: v }), false, JSON.stringify(v));
});

/** `orunmila intake run` on a throwaway home; one SessionStart over its socket; the session folder's files. */
async function intakeRunFiles(env, last = 'raw.jsonl') {
  const base = fs.realpathSync(tmpDir());
  const home = path.join(base, 'h');
  const project = path.join(base, 'p');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'a.js'), 'one\n');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'orunmila.js'), 'intake', 'run'], {
    env: { ...process.env, ORUNMILA_HOME: home, ORUNMILA_INTAKE_PORT: '0', ORUNMILA_OPON_LIVE: '', ...env },
    stdio: 'ignore',
  });
  const sock = path.join(home, 'intake', 'intake.sock');
  const dir = path.join(home, 'sessions', 'ses_b3');
  const until = async (cond) => {
    for (let end = Date.now() + 8000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (cond()) return true;
    return cond();
  };
  try {
    assert.ok(await until(() => fs.existsSync(sock)), 'the intake did not start');
    await new Promise((resolve, reject) => {
      const c = net.createConnection(sock, () => c.end(JSON.stringify({ op: 'payload', payload: { session_id: 'ses_b3', cwd: project, hook_event_name: 'SessionStart', source: 'startup' } }) + '\n'));
      c.on('error', reject);
      c.on('close', resolve);
    });
    assert.ok(await until(() => fs.existsSync(path.join(dir, last))), `no ${last}`);
    return fs.readdirSync(dir).sort();
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode === null ? child.on('exit', r) : r()));
    rmrf(base);
  }
}

it('N1b: `orunmila intake run` writes the baseline only with ORUNMILA_OPON_LIVE=1, and with it the odù log (L1c)', async () => {
  assert.deepStrictEqual(await intakeRunFiles({}), ['files', 'quarantine.jsonl', 'raw.jsonl']);
  assert.deepStrictEqual(await intakeRunFiles({ ORUNMILA_OPON_LIVE: '1' }, 'odu.jsonl'), ['baseline.jsonl', 'files', 'odu.jsonl', 'quarantine.jsonl', 'raw.jsonl']); // odu.jsonl is written last
});

runAll('baseline');
