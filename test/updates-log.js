// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/updates-log.js — the update log (Phase 6 slice PM2a; Q44 (a), approved by O 2026-11-25, LD299; LD329). Orunmila
 * will switch itself to a newer version only while no session is held (PM2c); every switch, and every update it
 * refused, is a record in `updates.jsonl` in Orunmila's home, hash-chained like the other logs (a header at seq 0,
 * then update records), each record checked against its schema, and checked by `orunmila verify --updates`. A
 * throwaway home; made-up versions and hashes.
 */

const { assert, fs, path, ROOT, tmpDir, rmrf, run, it, runAll } = require('./helpers');
const { readUpdatesLog, recordUpdate, updatesFile } = require('../src/opon/ledger/updates');
const { seal, verifyText } = require('../src/verify/chain');
const { canonicalize } = require('../src/verify/canonical');

const AT = '2026-11-26T09:00:00.000Z';
const first = { from: null, to: '0.2.5', integrity: 'sha512-' + 'A'.repeat(86) + '==', self_check: 'pass', switched: true };
const second = { from: '0.2.5', to: '0.2.6', integrity: 'sha512-' + 'B'.repeat(86) + '==', self_check: 'fail', switched: false };
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));

it('PM2a: the first update makes the log in Orunmila\'s home, its header first; the next is appended; the chain verifies and each record says what Q44 asks', () => {
  const home = tmpDir();
  try {
    const file = updatesFile(home);
    assert.strictEqual(file, path.join(home, 'updates.jsonl'));
    assert.deepStrictEqual(readUpdatesLog(home), { ok: true, exists: false, records: [], updates: [], words: 'no update log yet' });
    assert.deepStrictEqual(recordUpdate(home, first, AT), { ok: true, seq: 1 });
    assert.deepStrictEqual(recordUpdate(home, second, '2026-11-27T09:00:00.000Z'), { ok: true, seq: 2 });
    const text = fs.readFileSync(file, 'utf8');
    assert.strictEqual(verifyText(text).ok, true, 'hash-chained');
    const [head, a, b] = lines(file);
    assert.deepStrictEqual([head.record, head.seq, head.created_at, head.prev_hash], ['updates_header', 0, AT, null]);
    assert.deepStrictEqual([a.record, a.seq, a.at, a.from, a.to, a.integrity, a.self_check, a.switched, a.prev_hash], ['update', 1, AT, null, '0.2.5', first.integrity, 'pass', true, head.hash]);
    assert.deepStrictEqual([b.seq, b.from, b.to, b.self_check, b.switched, b.prev_hash], [2, '0.2.5', '0.2.6', 'fail', false, a.hash]);
    const log = readUpdatesLog(home);
    assert.deepStrictEqual([log.ok, log.exists, log.updates.length, log.words], [true, true, 2, '2 update(s), unbroken']);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'owner-only (file modes do not apply on Windows)');
  } finally {
    rmrf(home);
  }
});

it('PM2a: an update that does not fit its schema is refused before anything is written, naming the field', () => {
  const home = tmpDir();
  try {
    const r = recordUpdate(home, { ...first, to: 'latest' }, AT);
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes('/to'), r.reason);
    assert.strictEqual(fs.existsSync(updatesFile(home)), false, 'no log made for a record that was refused');
  } finally {
    rmrf(home);
  }
});

it('PM2a: an edited line breaks the chain and is named; a chained record that breaks its schema is named; a broken log is never extended', () => {
  const home = tmpDir();
  try {
    recordUpdate(home, first, AT);
    recordUpdate(home, second, AT);
    const file = updatesFile(home);
    const good = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, good.replace('"0.2.6"', '"0.2.7"'));
    const edited = readUpdatesLog(home);
    assert.strictEqual(edited.ok, false);
    assert.ok(edited.words.includes('line 3'), edited.words);
    assert.throws(() => recordUpdate(home, second, AT), /broken/, 'never extended past a break');
    // A record sealed into the chain whose fields break the schema: the chain alone would pass it.
    const [head, a] = good.split('\n').slice(0, 2).map((l) => JSON.parse(l));
    const odd = seal({ schema_version: 1, record: 'update', seq: 2, at: AT, from: '0.2.5', to: '0.2.6', integrity: second.integrity, self_check: 'maybe', switched: false }, a.hash);
    fs.writeFileSync(file, [head, a, odd].map((r) => canonicalize(r) + '\n').join(''));
    assert.strictEqual(verifyText(fs.readFileSync(file, 'utf8')).ok, true, 'the chain itself is whole');
    const bad = readUpdatesLog(home);
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.words.includes('line 3') && bad.words.includes('/self_check'), bad.words);
  } finally {
    rmrf(home);
  }
});

it('PM2a: orunmila verify --updates checks the log in Orunmila\'s home: exit 0 with none yet or unbroken, exit 1 broken, in plain words', () => {
  const home = tmpDir();
  try {
    const env = { ORUNMILA_HOME: home };
    const none = run('bin/orunmila.js', { args: ['verify', '--updates'], env });
    assert.strictEqual(none.status, 0, none.stdout + none.stderr);
    assert.ok(none.stdout.includes('no update log yet'), none.stdout);
    recordUpdate(home, first, AT);
    const ok = run('bin/orunmila.js', { args: ['verify', '--updates'], env });
    assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
    assert.ok(ok.stdout.includes('1 update(s), unbroken'), ok.stdout);
    fs.writeFileSync(updatesFile(home), fs.readFileSync(updatesFile(home), 'utf8').replace('"0.2.5"', '"0.2.9"'));
    const broken = run('bin/orunmila.js', { args: ['verify', '--updates'], env });
    assert.strictEqual(broken.status, 1, broken.stdout + broken.stderr);
    assert.ok(broken.stdout.includes('line 2'), broken.stdout);
  } finally {
    rmrf(home);
  }
});

it('F18 (LD329): the files npm ships hold the schemas verify and the update log read: from a copy of exactly those files, verify checks a session folder and the update log', () => {
  const { execFileSync, spawnSync } = require('child_process');
  const { makeLog, M } = require('./helpers-opon');
  const shipped = tmpDir();
  const home = tmpDir();
  const base = tmpDir();
  try {
    const win = process.platform === 'win32';
    const packed = JSON.parse(execFileSync(win ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', shell: win, stdio: ['ignore', 'pipe', 'ignore'] }));
    for (const f of packed[0].files) {
      const to = path.join(shipped, f.path);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(ROOT, f.path), to);
    }
    const s = makeLog(base, {});
    s.append(M.tick(100));
    recordUpdate(home, first, AT);
    const cli = (args) => spawnSync(process.execPath, [path.join(shipped, 'bin', 'orunmila.js'), ...args], { encoding: 'utf8', env: { ...process.env, ORUNMILA_HOME: home } });
    const session = cli(['verify', s.dir]);
    assert.strictEqual(session.status, 0, session.stdout + session.stderr);
    const updates = cli(['verify', '--updates']);
    assert.strictEqual(updates.status, 0, updates.stdout + updates.stderr);
    assert.ok(updates.stdout.includes('1 update(s), unbroken'), updates.stdout);
  } finally {
    rmrf(shipped);
    rmrf(home);
    rmrf(base);
  }
});

runAll('updates-log');
