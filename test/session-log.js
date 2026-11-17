'use strict';

/**
 * test/session-log.js — src/opon/ledger/session-log.js: one session's folder,
 * its append-only raw log, the quarantine log, and the files kept beside the
 * log (Phase 1 slice A4; brief v3 lines 213, 237, 266, 338, 340; tests 28 and
 * 62's "kept whole" half). Not wired to capture. Fixtures are synthetic.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const crypto = require('crypto');
const { createSessionLog, openSessionLog, verifySessionLog } = require('../src/opon/ledger/session-log');
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

// --- B1c: reopening a session log after the intake restarts (test 84's first half) ---

it(
  'a reopened session log continues both chains where they stopped, and its counts include what was already there',
  withLog((log, dir) => {
    log.append(mark('hook_started'));
    log.append('{not json');
    const again = openSessionLog(dir);
    assert.deepStrictEqual(again.counts(), { marks: 1, quarantined: 1 });
    assert.deepStrictEqual(again.append(mark('hook_read_range')), { ok: true, seq: 2 });
    assert.strictEqual(again.append('[1]').quarantined, 2);
    assert.deepStrictEqual(readLines(path.join(dir, 'raw.jsonl')).map((l) => l.seq), [0, 1, 2]);
    assert.deepStrictEqual(readLines(path.join(dir, 'quarantine.jsonl')).map((l) => l.seq), [0, 1, 2]);
    assert.deepStrictEqual(again.counts(), { marks: 2, quarantined: 2 });
    const v = verifySessionLog(dir);
    assert.strictEqual(v.ok, true, v.words);
  }),
);

it(
  'a reopened log still checks marks and redacts with the .env values it is given',
  withLog((log, dir) => {
    const again = openSessionLog(dir, { envValues: ['hunter2-not-a-real-value'] });
    const m = mark('claim');
    m.detail.text = 'set the token to hunter2-not-a-real-value';
    assert.strictEqual(again.append(m).ok, true);
    assert.strictEqual(again.append({ ...mark('hook_started'), seq: 9 }).ok, false, 'a source that sets seq is still quarantined');
    assert.ok(!fs.readFileSync(path.join(dir, 'raw.jsonl'), 'utf8').includes('hunter2-not-a-real-value'));
    assert.strictEqual(verifySessionLog(dir).ok, true);
  }),
);

it(
  'last() names the raw log\'s last record (seq, mono_ns, observed_at): the header before any mark, then the latest mark, and the same after a reopen',
  withLog((log, dir) => {
    const h = readLines(path.join(dir, 'raw.jsonl'))[0];
    assert.deepStrictEqual(log.last(), { seq: 0, mono_ns: h.mono_ns, observed_at: h.observed_at });
    const m = mark('hook_read_range');
    log.append(m);
    const want = { seq: 1, mono_ns: m.mono_ns, observed_at: m.observed_at };
    assert.deepStrictEqual(log.last(), want);
    log.append('{not json');
    assert.deepStrictEqual(log.last(), want, 'a quarantined input does not move the raw log\'s last record');
    assert.deepStrictEqual(openSessionLog(dir).last(), want);
  }),
);

it(
  'LD55: ended() is false until the session\'s end mark is written, then true; a quarantined end does not count; the same after a reopen',
  withLog((log, dir) => {
    log.append(mark('hook_started'));
    assert.strictEqual(log.ended(), false);
    assert.strictEqual(log.append({ ...mark('hook_session_ended'), turn: 't3' }).ok, false, 'malformed: quarantined');
    assert.strictEqual(log.ended(), false);
    assert.strictEqual(openSessionLog(dir).ended(), false);
    assert.strictEqual(log.append(mark('hook_session_ended')).ok, true);
    assert.strictEqual(log.ended(), true);
    assert.strictEqual(openSessionLog(dir).ended(), true);
  }),
);

it(
  'LD58: pin() is the sender_pid of the first HTTP Glove mark that carries one, null before; a command-channel mark\'s is no pin; the same after a reopen',
  withLog((log, dir) => {
    const withPid = (channel, pid) => ({ ...mark('hook_started'), detail: { tool: 'Bash', channel, sender_pid: pid } });
    assert.strictEqual(log.pin(), null);
    log.append(withPid('command', 7));
    assert.strictEqual(log.pin(), null);
    assert.strictEqual(openSessionLog(dir).pin(), null);
    log.append(withPid('http', 100));
    log.append(withPid('http', 200));
    assert.strictEqual(log.pin(), 100);
    assert.strictEqual(openSessionLog(dir).pin(), 100);
  }),
);

it(
  'a log that does not verify is never reopened, and nothing is written: an edited line, a broken quarantine log, a changed kept file beside a cut line, no log at all',
  () => {
    const base = tmpDir();
    try {
      const made = (name) => {
        const dir = path.join(base, name);
        createSessionLog(dir, header()).append(mark('hook_started'));
        return dir;
      };
      const edit = (file, from, to) => {
        const text = fs.readFileSync(file, 'utf8');
        assert.ok(text.includes(from), `${from} in ${file}`);
        fs.writeFileSync(file, text.replace(from, to));
      };
      const cases = [];
      let dir = made('edited');
      edit(path.join(dir, 'raw.jsonl'), '"says":"started"', '"says":"exited"');
      cases.push([dir, /line 2 of the raw log/]);
      dir = made('cut-and-changed');
      const log = openSessionLog(dir);
      const m = mark('sentinel_modified');
      m.detail.diff_ref = log.keep('-a\n+b\n');
      log.append(m);
      fs.writeFileSync(path.join(dir, 'files', m.detail.diff_ref.slice(7)), 'changed');
      fs.appendFileSync(path.join(dir, 'raw.jsonl'), '{"schema_version":1,"sess');
      cases.push([dir, /was changed after it was written/]);
      dir = made('quarantine');
      edit(path.join(dir, 'quarantine.jsonl'), 'quarantine_header', 'quarantine_headex');
      cases.push([dir, /quarantine log/]);
      cases.push([path.join(base, 'none'), /missing/]);
      for (const [d, why] of cases) {
        const files = ['raw.jsonl', 'quarantine.jsonl', 'raw.2.jsonl', 'quarantine.2.jsonl'].map((f) => path.join(d, f));
        const before = files.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null));
        assert.throws(() => openSessionLog(d), (e) => /cannot be reopened/.test(e.message) && why.test(e.message), d);
        assert.deepStrictEqual(files.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null)), before, `${d} unchanged`);
      }
      assert.ok(!fs.existsSync(path.join(base, 'none')), 'no folder made for a log that is not there');
    } finally {
      rmrf(base);
    }
  },
);

// --- C1c: a crash-cut log continued in a new part on reopen (LD57) ------------------

const CUT = '{"schema_version":1,"sess';

it(
  'LD57: a log whose last line a crash cut is reopened by continuing it in part 2: part 1 is never touched, last() names the last whole mark, the next mark lands in part 2, and the log verifies naming the cut',
  withLog((log, dir) => {
    log.append(mark('hook_started'));
    const m2 = mark('hook_read_range');
    log.append(m2);
    fs.appendFileSync(path.join(dir, 'raw.jsonl'), CUT);
    const before = fs.readFileSync(path.join(dir, 'raw.jsonl'));
    const again = openSessionLog(dir);
    assert.deepStrictEqual(again.last(), { seq: 2, mono_ns: m2.mono_ns, observed_at: m2.observed_at });
    assert.deepStrictEqual(again.counts(), { marks: 2, quarantined: 0 });
    assert.deepStrictEqual(again.append(mark('hook_started')), { ok: true, seq: 4 });
    assert.ok(fs.readFileSync(path.join(dir, 'raw.jsonl')).equals(before), 'part 1 unchanged, its cut line kept');
    const p2 = readLines(path.join(dir, 'raw.2.jsonl'));
    assert.deepStrictEqual(
      [p2[0].record, p2[0].log, p2[0].part, p2[0].seq, p2[0].cut.line, p2[0].cut.bytes],
      ['continuation', 'raw', 2, 3, 4, Buffer.byteLength(CUT)],
    );
    assert.deepStrictEqual(p2.map((r) => r.seq), [3, 4]);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(dir, 'raw.2.jsonl')).mode & 0o777, 0o600);
    const v = verifySessionLog(dir);
    assert.strictEqual(v.ok, true, v.words);
    assert.ok(v.words.endsWith('unbroken; line 4 of the raw log was cut by a crash and continues in part 2.'), v.words);
  }),
);

it(
  'LD57: both logs cut at once are both continued; a quarantined input lands in quarantine part 2',
  withLog((log, dir) => {
    log.append(mark('hook_started'));
    log.append('{not json');
    fs.appendFileSync(path.join(dir, 'raw.jsonl'), CUT);
    fs.appendFileSync(path.join(dir, 'quarantine.jsonl'), '{"cut');
    const again = openSessionLog(dir);
    assert.strictEqual(again.append('[1]').ok, false);
    assert.deepStrictEqual(readLines(path.join(dir, 'quarantine.2.jsonl')).map((r) => r.record), ['continuation', 'quarantined']);
    assert.strictEqual(again.append(mark('hook_started')).ok, true);
    const v = verifySessionLog(dir);
    assert.strictEqual(v.ok, true, v.words);
    assert.deepStrictEqual(v.counts, { marks: 2, quarantined: 2, kept_files: 0 });
  }),
);

it(
  'LD57: a continued log reopens into its last part; a second crash there makes part 3; ended() and pin() read every part',
  withLog((log, dir) => {
    log.append({ ...mark('hook_started'), detail: { tool: 'Bash', channel: 'http', sender_pid: 100 } });
    fs.appendFileSync(path.join(dir, 'raw.jsonl'), CUT);
    const second = openSessionLog(dir);
    second.append(mark('hook_session_ended'));
    fs.appendFileSync(path.join(dir, 'raw.2.jsonl'), CUT);
    const third = openSessionLog(dir);
    assert.deepStrictEqual([third.ended(), third.pin()], [true, 100]);
    assert.strictEqual(third.append(mark('hook_started')).ok, true);
    assert.deepStrictEqual(readLines(path.join(dir, 'raw.3.jsonl')).map((r) => r.seq), [4, 5], 'the continuation follows the last whole line, seq 3');
    const v = verifySessionLog(dir);
    assert.strictEqual(v.ok, true, v.words);
    assert.ok(v.words.includes('line 3 of part 2 of the raw log was cut by a crash and continues in part 3'), v.words);
  }),
);

runAll('session-log');
