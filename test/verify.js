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

// --- C1b: a log in parts after a crash (LD57; spec/hash-chain.md, "A log in parts") ---

const sha = (buf) => 'sha256:' + require('crypto').createHash('sha256').update(buf).digest('hex');
const TORN = '{"schema_version":1,"session_id":"ses_test_0001","sé';
const whole = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Cut a log's last line short, as a crash does, and start part 2 the way the restart will. Returns part 2's first record. */
function cutAndContinue(dir, log = 'raw', over = {}) {
  const f1 = path.join(dir, `${log}.jsonl`);
  const recs = whole(f1);
  const last = recs[recs.length - 1];
  fs.appendFileSync(f1, TORN);
  const cut = { line: recs.length + 1, bytes: Buffer.byteLength(TORN), fingerprint: sha(Buffer.from(TORN)) };
  const rec = { schema_version: 1, record: 'continuation', session_id: last.session_id, log, part: 2, seq: last.seq + 1, cut, ...over };
  for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k]; // { cut: undefined } leaves cut out
  const cont = seal(rec, over.prev_hash || last.hash);
  fs.writeFileSync(path.join(dir, `${log}.2.jsonl`), canonicalize(cont) + '\n');
  return cont;
}
const addTo = (file, rec) => {
  const recs = whole(file);
  const last = recs[recs.length - 1];
  const s = seal({ ...rec, seq: last.seq + 1 }, last.hash);
  fs.appendFileSync(file, canonicalize(s) + '\n');
  return s;
};

it(
  'LD57: a raw log cut by a crash and continued in part 2 verifies; the answer names the cut, and marks in part 2 count',
  withSession(({ dir }) => {
    cutAndContinue(dir);
    addTo(path.join(dir, 'raw.2.jsonl'), strip(SPEC.good.hook_read_range));
    const r = verify(dir);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.stdout.trim(), 'Record intact: 3 marks, 1 quarantined input, 1 kept file, unbroken; line 4 of the raw log was cut by a crash and continues in part 2.');
  }),
);

it(
  'LD57: the quarantine log continues the same way, and a part may itself be cut and continued',
  withSession(({ dir }) => {
    cutAndContinue(dir, 'quarantine');
    const q2 = path.join(dir, 'quarantine.2.jsonl');
    const last = addTo(q2, { schema_version: 1, record: 'quarantined', session_id: 'ses_test_0001', received_at: '2026-11-17T08:00:00.000Z', reasons: ['not JSON'], received: '{x' });
    fs.appendFileSync(q2, '{"cut');
    const cont = seal({ schema_version: 1, record: 'continuation', session_id: 'ses_test_0001', log: 'quarantine', part: 3, seq: last.seq + 1, cut: { line: 3, bytes: 5, fingerprint: sha(Buffer.from('{"cut')) } }, last.hash);
    fs.writeFileSync(path.join(dir, 'quarantine.3.jsonl'), canonicalize(cont) + '\n');
    const r = verify(dir);
    assert.strictEqual(r.status, 0, r.stdout);
    assert.strictEqual(
      r.stdout.trim(),
      'Record intact: 2 marks, 2 quarantined inputs, 1 kept file, unbroken; line 3 of the quarantine log was cut by a crash and continues in part 2; line 3 of part 2 of the quarantine log was cut by a crash and continues in part 3.',
    );
  }),
);

it(
  'LD57: a cut last line that no part continues is broken, and named as a cut',
  withSession(({ dir }) => {
    fs.appendFileSync(path.join(dir, 'raw.jsonl'), TORN);
    const r = verify(dir);
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.stdout.trim(), 'Record broken at line 4 of the raw log: this line was cut short, as a crash leaves it, and no later part continues the log.');
  }),
);

it(
  'LD57: a part 2 whose first line does not name the cut exactly (its length, its fingerprint, its line, its part) is broken',
  () => {
    for (const over of [{ cut: { line: 4, bytes: 3, fingerprint: sha(Buffer.from(TORN)) } }, { cut: { line: 4, bytes: Buffer.byteLength(TORN), fingerprint: sha(Buffer.from('other')) } }, { cut: { line: 3, bytes: Buffer.byteLength(TORN), fingerprint: sha(Buffer.from(TORN)) } }, { part: 3 }, { log: 'quarantine' }]) {
      const s = buildSession();
      try {
        cutAndContinue(s.dir, 'raw', over);
        const r = verify(s.dir);
        assert.strictEqual(r.status, 1, JSON.stringify(over));
        assert.strictEqual(r.stdout.trim(), 'Record broken at line 1 of part 2 of the raw log: it does not match the cut at the end of part 1.', JSON.stringify(over));
      } finally {
        rmrf(s.base);
      }
    }
  },
);

it(
  'LD57: a part 2 that does not follow the last whole line, or is not a valid continuation, or comes after a part that was not cut, is broken',
  () => {
    const cases = [
      [(dir) => cutAndContinue(dir, 'raw', { prev_hash: 'sha256:' + 'f'.repeat(64) }), 'Record broken at line 1 of part 2 of the raw log: this line does not follow the last whole line of part 1.'],
      [(dir) => cutAndContinue(dir, 'raw', { cut: undefined }), 'Record broken at line 1 of part 2 of the raw log: it is not a valid continuation (/cut required).'],
      [
        (dir) => {
          const recs = whole(path.join(dir, 'raw.jsonl'));
          const last = recs[recs.length - 1];
          const c = seal({ schema_version: 1, record: 'continuation', session_id: 'ses_test_0001', log: 'raw', part: 2, seq: last.seq + 1, cut: { line: 4, bytes: 1, fingerprint: sha(Buffer.from('x')) } }, last.hash);
          fs.writeFileSync(path.join(dir, 'raw.2.jsonl'), canonicalize(c) + '\n');
        },
        'Record broken: part 2 of the raw log follows part 1, which was not cut.',
      ],
    ];
    for (const [make, want] of cases) {
      const s = buildSession();
      try {
        make(s.dir);
        const r = verify(s.dir);
        assert.strictEqual(r.status, 1, want);
        assert.strictEqual(r.stdout.trim(), want);
      } finally {
        rmrf(s.base);
      }
    }
  },
);

it(
  'LD57: a mark in part 2 changed after it was written is named by its part; a part 2 mark that is not a valid mark is named too',
  withSession(({ dir }) => {
    cutAndContinue(dir);
    const f2 = path.join(dir, 'raw.2.jsonl');
    addTo(f2, strip(SPEC.good.hook_read_range));
    const ls = fs.readFileSync(f2, 'utf8').split('\n');
    fs.writeFileSync(f2, ls.join('\n').replace('"says":"read"', '"says":"redd"'));
    assert.strictEqual(verify(dir).stdout.trim(), 'Record broken at line 2 of part 2 of the raw log: this line was changed after it was written.');
    fs.writeFileSync(f2, ls[0] + '\n');
    addTo(f2, { ...strip(SPEC.good.hook_read_range), says: 'redd' });
    assert.strictEqual(verify(dir).stdout.trim(), 'Record broken at line 2 of part 2 of the raw log: it is not a valid mark (/says enum).');
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
