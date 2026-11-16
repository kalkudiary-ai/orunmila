'use strict';

/**
 * test/verify.js — `orunmila verify <session-folder>` and src/verify/session.js
 * (Phase 1 slice A5; brief v3 lines 592, 694-700; tests 11, 24's answer, 65).
 * Session folders are built with the A4 library from synthetic fixtures.
 */

const { assert, fs, path, ROOT, tmpDir, rmrf, run, it, runAll } = require('./helpers');
const { createSessionLog } = require('../src/opon/ledger/session-log');
const { seal } = require('../src/verify/chain');
const { canonicalize } = require('../src/verify/canonical');

const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'spec', 'marks.json'), 'utf8'));
const HEADERS = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'spec', 'session-headers.json'), 'utf8'));
const strip = (r) => {
  const o = JSON.parse(JSON.stringify(r));
  delete o.seq;
  delete o.prev_hash;
  delete o.hash;
  return o;
};

/** A session with 2 marks (one naming a kept diff), 1 quarantined input. */
function buildSession() {
  const base = tmpDir();
  const dir = path.join(base, 'ses');
  const log = createSessionLog(dir, strip(HEADERS.good.header));
  log.append(strip(SPEC.good.hook_started));
  const ref = log.keep('-a\n+b\n');
  const m = strip(SPEC.good.sentinel_modified);
  m.detail.diff_ref = ref;
  log.append(m);
  log.append('{broken');
  return { base, dir, ref };
}

function withSession(fn) {
  return () => {
    const s = buildSession();
    try {
      fn(s);
    } finally {
      rmrf(s.base);
    }
  };
}

const verify = (dir, extra = []) => run('bin/orunmila.js', { args: ['verify', dir, ...extra] });
const rawLines = (dir) => fs.readFileSync(path.join(dir, 'raw.jsonl'), 'utf8').split('\n');

it(
  'an untouched session: "Record intact" with counts, exit 0 (test 24\'s answer)',
  withSession(({ dir }) => {
    const r = verify(dir);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.stdout.trim(), 'Record intact: 2 marks, 1 quarantined input, 1 kept file, unbroken.');
  }),
);

it(
  'test 11: one line of the raw log edited after the session: verify fails and names the first broken line',
  withSession(({ dir }) => {
    const ls = rawLines(dir);
    const rec = JSON.parse(ls[1]);
    rec.detail.tool = 'Edit';
    ls[1] = canonicalize(rec);
    fs.chmodSync(path.join(dir, 'raw.jsonl'), 0o600);
    fs.writeFileSync(path.join(dir, 'raw.jsonl'), ls.join('\n'));
    const r = verify(dir);
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.stdout.trim(), 'Record broken at line 2 of the raw log: this line was changed after it was written.');
  }),
);

it(
  'a deleted line is named as the line that no longer follows',
  withSession(({ dir }) => {
    const ls = rawLines(dir);
    ls.splice(1, 1);
    fs.writeFileSync(path.join(dir, 'raw.jsonl'), ls.join('\n'));
    const r = verify(dir);
    assert.strictEqual(r.status, 1);
    assert.ok(r.stdout.startsWith('Record broken at line 2 of the raw log: this line does not follow line 1'), r.stdout);
  }),
);

it(
  'test 65: a file kept beside the log changed after the session: verify fails, naming the file and the mark',
  withSession(({ dir, ref }) => {
    const file = path.join(dir, 'files', ref.slice(7));
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, '-a\n+c\n');
    const r = verify(dir);
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.stdout.trim(), `Record broken: the file kept beside the log for mark 2 (${ref}) was changed after it was written.`);
    fs.rmSync(file);
    assert.strictEqual(verify(dir).stdout.trim(), `Record broken: the file kept beside the log for mark 2 (${ref}) is missing.`);
  }),
);

it(
  'a line that chains correctly but is not a valid mark is named, with the schema reason',
  withSession(({ dir }) => {
    const ls = rawLines(dir).filter(Boolean);
    const last = JSON.parse(ls[ls.length - 1]);
    const bad = seal({ ...strip(SPEC.good.hook_started), seq: last.seq + 1, says: 'edited' }, last.hash);
    fs.appendFileSync(path.join(dir, 'raw.jsonl'), canonicalize(bad) + '\n');
    const r = verify(dir);
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.stdout.trim(), 'Record broken at line 4 of the raw log: it is not a valid mark (/says enum).');
  }),
);

it(
  'the quarantine log is checked too',
  withSession(({ dir }) => {
    const q = path.join(dir, 'quarantine.jsonl');
    fs.writeFileSync(q, fs.readFileSync(q, 'utf8').replace('{broken', '{brokem'));
    const r = verify(dir);
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.stdout.trim(), 'Record broken at line 2 of the quarantine log: this line was changed after it was written.');
  }),
);

it('usage: no folder is exit 2; a folder with no raw log is broken, exit 1', () => {
  const r = run('bin/orunmila.js', { args: ['verify'] });
  assert.strictEqual(r.status, 2);
  assert.ok(r.stderr.includes('Usage: orunmila verify <session-folder>'), r.stderr);
  const empty = tmpDir();
  try {
    const e = verify(empty);
    assert.strictEqual(e.status, 1);
    assert.strictEqual(e.stdout.trim(), 'Record broken at line 1 of the raw log: the raw log is missing or empty.');
  } finally {
    rmrf(empty);
  }
});

it(
  '--json prints the full result',
  withSession(({ dir }) => {
    const r = verify(dir, ['--json']);
    assert.strictEqual(r.status, 0);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.ok, true);
    assert.deepStrictEqual(j.counts, { marks: 2, quarantined: 1, kept_files: 1 });
  }),
);

it('the verifier stays small and separate: src/verify/session.js loads nothing outside src/verify (brief line 699)', () => {
  const { spawnSync } = require('child_process');
  const probe = "require('./src/verify/session'); process.stdout.write(JSON.stringify(Object.keys(require.cache)))";
  const r = spawnSync('node', ['-e', probe], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const loaded = JSON.parse(r.stdout).filter((f) => f.startsWith(ROOT + path.sep));
  assert.ok(loaded.includes(path.join(ROOT, 'src', 'verify', 'session.js')), 'the probe loaded the verifier');
  const outside = loaded.filter((f) => !f.startsWith(path.join(ROOT, 'src', 'verify') + path.sep) && !f.startsWith(path.join(ROOT, 'spec') + path.sep));
  assert.deepStrictEqual(outside, []);
});

runAll('verify');
