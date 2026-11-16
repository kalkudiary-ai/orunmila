'use strict';

/**
 * test/session-log.js — src/opon/ledger/session-log.js: one session's folder,
 * its append-only raw log, the quarantine log, and the files kept beside the
 * log (Phase 1 slice A4; brief v3 lines 213, 237, 266, 338, 340; tests 28 and
 * 62's "kept whole" half). Not wired to capture. Fixtures are synthetic.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const crypto = require('crypto');
const { createSessionLog, verifySessionLog } = require('../src/opon/ledger/session-log');
const { verifyText } = require('../src/verify/chain');

const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'spec', 'marks.json'), 'utf8'));
const HEADERS = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'spec', 'session-headers.json'), 'utf8'));

const strip = (r) => {
  const o = JSON.parse(JSON.stringify(r));
  delete o.seq;
  delete o.prev_hash;
  delete o.hash;
  return o;
};
const header = () => strip(HEADERS.good.header);
const mark = (name) => strip(SPEC.good[name]);
const readLines = (f) => fs.readFileSync(f, 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));

function withLog(fn) {
  return () => {
    const dir = path.join(tmpDir(), 'ses');
    try {
      fn(createSessionLog(dir, header()), dir);
    } finally {
      rmrf(path.dirname(dir));
    }
  };
}

it(
  'a new session log is a folder holding the raw log, whose first line is the sealed header (seq 0); owner-only',
  withLog((log, dir) => {
    const raw = path.join(dir, 'raw.jsonl');
    const lines = readLines(raw);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].record, 'session_header');
    assert.strictEqual(lines[0].seq, 0);
    assert.strictEqual(lines[0].prev_hash, null);
    assert.deepStrictEqual(verifyText(fs.readFileSync(raw, 'utf8')), { ok: true, lines: 1 });
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(raw).mode & 0o777, 0o600);
    }
  }),
);

it('a session log is never created over an existing one, and never with a malformed header', () => {
  const base = tmpDir();
  try {
    const dir = path.join(base, 'ses');
    createSessionLog(dir, header());
    assert.throws(() => createSessionLog(dir, header()), /exists/);
    assert.throws(() => createSessionLog(path.join(base, 'other'), { ...header(), seq: 5 }), /intake/);
    const bad = header();
    delete bad.frozen;
    assert.throws(() => createSessionLog(path.join(base, 'third'), bad), /frozen/);
    assert.ok(!fs.existsSync(path.join(base, 'third', 'raw.jsonl')), 'no log left behind by a refused header');
  } finally {
    rmrf(base);
  }
});

it(
  'intake assigns seq 1, 2, 3 and chains each mark; the raw log verifies',
  withLog((log, dir) => {
    for (const n of ['hook_started', 'hook_read_range', 'sentinel_modified_before_unknown']) assert.strictEqual(log.append(mark(n)).ok, true, n);
    const lines = readLines(path.join(dir, 'raw.jsonl'));
    assert.deepStrictEqual(lines.map((l) => l.seq), [0, 1, 2, 3]);
    assert.deepStrictEqual(verifySessionLog(dir).ok, true);
    assert.deepStrictEqual(log.counts(), { marks: 3, quarantined: 0 });
  }),
);

it(
  'test 28: a badly formatted mark lands in the quarantine log with its reasons, nothing dropped, and the raw log is untouched',
  withLog((log, dir) => {
    log.append(mark('hook_started'));
    const bad = [
      ['{not json', 'not JSON'],
      ['[1,2]', 'not a JSON object'],
      [{ ...mark('hook_started'), says: 'edited' }, '/says enum'],
      [{ ...mark('hook_started'), session_id: 'ses_other' }, 'session_id'],
      [{ ...mark('hook_started'), seq: 12 }, 'intake'],
      [{ ...mark('sentinel_modified'), detail: { ...mark('sentinel_modified').detail, diff_ref: 'sha256:' + 'e'.repeat(64) } }, 'not kept'],
    ];
    for (const [input, why] of bad) {
      const r = log.append(input);
      assert.strictEqual(r.ok, false, why);
      assert.ok(r.reasons.some((x) => x.includes(why)), `${why}: ${JSON.stringify(r.reasons)}`);
    }
    const q = readLines(path.join(dir, 'quarantine.jsonl'));
    assert.strictEqual(q.length, 1 + bad.length, 'a quarantine header, then one entry per bad mark');
    assert.strictEqual(q[1].received, '{not json');
    assert.deepStrictEqual(JSON.parse(q[3].received).says, 'edited');
    assert.strictEqual(readLines(path.join(dir, 'raw.jsonl')).length, 2);
    assert.strictEqual(verifySessionLog(dir).ok, true);
    assert.deepStrictEqual(log.counts(), { marks: 1, quarantined: bad.length });
  }),
);

it(
  'test 62, kept-whole half: a 2 MB diff is kept beside the log byte for byte under its plain SHA-256, and the mark that refers to it is accepted',
  withLog((log, dir) => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 7, 'x');
    big.write('-old\n+new\n', 0);
    const ref = log.keep(big);
    assert.strictEqual(ref, 'sha256:' + crypto.createHash('sha256').update(big).digest('hex'));
    const kept = fs.readFileSync(path.join(dir, 'files', ref.slice(7)));
    assert.ok(kept.equals(big), 'kept whole, never cut short');
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(dir, 'files', ref.slice(7))).mode & 0o777, 0o600);
    assert.strictEqual(log.keep(big), ref, 'keeping the same bytes twice gives the same file');
    const m = mark('sentinel_modified');
    m.detail.diff_ref = ref;
    assert.strictEqual(log.append(m).ok, true);
    assert.strictEqual(verifySessionLog(dir).ok, true);
  }),
);

it(
  'verifySessionLog names a changed kept file, a missing kept file, and a broken raw or quarantine line',
  withLog((log, dir) => {
    const ref = log.keep('diff text');
    const m = mark('sentinel_modified');
    m.detail.diff_ref = ref;
    log.append(m);
    log.append('{not json');
    const file = path.join(dir, 'files', ref.slice(7));
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, 'diff text, changed');
    let v = verifySessionLog(dir);
    assert.strictEqual(v.ok, false);
    assert.deepStrictEqual(v.files.bad, [{ ref, seq: 1, problem: 'changed' }]);
    fs.rmSync(file);
    v = verifySessionLog(dir);
    assert.deepStrictEqual(v.files.bad, [{ ref, seq: 1, problem: 'missing' }]);
    const qf = path.join(dir, 'quarantine.jsonl');
    fs.writeFileSync(qf, fs.readFileSync(qf, 'utf8').replace('not json', 'not jsox'));
    v = verifySessionLog(dir);
    assert.strictEqual(v.quarantine.ok, false);
    assert.strictEqual(v.quarantine.line, 2);
  }),
);

it(
  'a mark with no mono_ns is stamped by intake, which records that in detail.stamped_by',
  withLog((log, dir) => {
    const m = mark('hook_started');
    delete m.mono_ns;
    assert.strictEqual(log.append(m).ok, true);
    const line = readLines(path.join(dir, 'raw.jsonl'))[1];
    assert.match(line.mono_ns, /^(0|[1-9][0-9]*)$/, 'a decimal string (brief v4 line 238)');
    assert.strictEqual(line.detail.stamped_by, 'intake');
  }),
);

it(
  'silence: over a fuzzed batch, every input lands exactly once, in the raw log or the quarantine log, and both chains verify',
  withLog((log, dir) => {
    const names = Object.keys(SPEC.good);
    let seed = 42;
    const rnd = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    const inputs = [];
    for (let i = 0; i < 400; i++) {
      const m = mark(names[rnd(names.length)]);
      m.cause_hint = m.cause_hint === null ? null : `toolu_f${i}`; // each input distinguishable
      m.observed_at = new Date(Date.UTC(2026, 10, 16, 9, 0, 0, i)).toISOString();
      const k = rnd(6);
      if (k === 0) inputs.push(`#${i} ` + JSON.stringify(m).slice(0, 20 + rnd(30)));
      else if (k === 1) inputs.push({ ...m, source: 'nope' });
      else if (k === 2) inputs.push({ ...m, hash: 'x' });
      else inputs.push(m);
    }
    for (const x of inputs) log.append(x);
    const raw = readLines(path.join(dir, 'raw.jsonl')).slice(1);
    const q = readLines(path.join(dir, 'quarantine.jsonl')).slice(1);
    assert.strictEqual(raw.length + q.length, inputs.length);
    assert.ok(raw.length > 100 && q.length > 100, `${raw.length} / ${q.length}`);
    const key = (m) => m.observed_at;
    const seen = new Set([...raw.map(key), ...q.map((e) => e.received)]);
    assert.strictEqual(seen.size, inputs.length, 'every input once');
    const v = verifySessionLog(dir);
    assert.strictEqual(v.ok, true, JSON.stringify(v));
    assert.deepStrictEqual(log.counts(), { marks: raw.length, quarantined: q.length });
  }),
);

runAll('session-log');
