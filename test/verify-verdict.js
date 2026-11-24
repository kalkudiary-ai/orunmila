'use strict';

/**
 * test/verify-verdict.js — `verify` reads the verdict log (Phase 6 slice BB7; brief v4 lines 714-715; tests 25 and 29's
 * form for verdicts). A session folder with a verdict log is intact only when that log's chain holds, every line is a
 * valid record of its kind, every verdict points to an odù the odù log holds with the hash it names, and the footer's
 * verdict line is in it. Hand-built session logs (test/helpers-opon.js), judged by replay; made-up paths.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { makeLog, M } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');
const { verifySession } = require('../src/verify/session');
const { seal } = require('../src/verify/chain');
const { canonicalize } = require('../src/verify/canonical');

/** A session folder whose odù and verdict logs are replay's: an edit both witnesses saw, a hand edit, a turn. */
function judgedFolder(base) {
  const s = makeLog(base);
  s.append(M.prompted(0));
  s.append(M.started(10, 'e1', { kind: 'file', path: 'src/a.ts' }));
  s.append(M.edited(100, 'e1', 'src/a.ts'));
  s.append(M.disk(300, 'src/a.ts'));
  s.append(M.disk(400, 'src/hand.ts'));
  s.append(M.turnEnded(900));
  s.append(M.tick(10000));
  const r = replayFolder(s.dir);
  assert.ok(r.ok && typeof r.verdict === 'string', r.words + ' ' + r.verdict_words);
  fs.writeFileSync(path.join(s.dir, 'odu.jsonl'), r.odu);
  fs.writeFileSync(path.join(s.dir, 'verdict.jsonl'), r.verdict);
  return s.dir;
}
const recordsOf = (file) => fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));
/** Rewrite the verdict log with `change` applied to its records, every line sealed again, so its chain holds. */
function resealed(dir, change) {
  const file = path.join(dir, 'verdict.jsonl');
  const recs = change(recordsOf(file));
  let prev = null;
  const out = recs.map((r) => (prev = seal({ ...r }, prev ? prev.hash : null)));
  fs.writeFileSync(file, out.map((r) => canonicalize(r) + '\n').join(''));
}
const withBase = (fn) => () => {
  const base = tmpDir();
  try {
    fn(base);
  } finally {
    rmrf(base);
  }
};

it(
  'BB7 test 24: an untouched session with a verdict log is intact, and the words count its verdicts',
  withBase((base) => {
    const dir = judgedFolder(base);
    const v = verifySession(dir);
    const n = recordsOf(path.join(dir, 'verdict.jsonl')).filter((r) => r.record === 'verdict').length;
    assert.strictEqual(v.ok, true, v.words);
    assert.ok(v.words.includes(`${n} verdicts`) && v.words.includes('the verdict log'), v.words);
    assert.strictEqual(v.counts.verdicts, n);
  }),
);

it(
  'BB7 test 25: one verdict line edited after it was written fails, naming the line in plain words',
  withBase((base) => {
    const dir = judgedFolder(base);
    const file = path.join(dir, 'verdict.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const at = lines.findIndex((l) => l.includes('"record":"verdict"'));
    lines[at] = lines[at].replace(/"verdict":"(clean|look_at_this|violation)"/, (m, v) => `"verdict":"${v === 'clean' ? 'violation' : 'clean'}"`);
    fs.writeFileSync(file, lines.join('\n'));
    const v = verifySession(dir);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.words, `Record broken at line ${at + 1} of the verdict log: this line was changed after it was written.`);
  }),
);

it(
  "BB7 test 29's form: a verdict that points to an odù that does not exist, or names another hash, fails",
  withBase((base) => {
    const dir = judgedFolder(base);
    resealed(dir, (recs) => recs.map((r) => (r.record === 'verdict' && r.verdict_id === 'v_0001' ? { ...r, odu_id: 'odu_9999' } : r)));
    const v = verifySession(dir);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.words, 'Record broken at line 2 of the verdict log: this verdict points to an odù that does not exist (odu_9999).');
    const dir2 = judgedFolder(path.join(base, 'b'));
    resealed(dir2, (recs) => recs.map((r) => (r.verdict_id === 'v_0001' ? { ...r, odu_hash: 'sha256:' + 'f'.repeat(64) } : r)));
    assert.ok(/this verdict names its odù with a hash the odù log does not hold/.test(verifySession(dir2).words), verifySession(dir2).words);
  }),
);

it(
  'BB7: a verdict line that is not a valid record of its kind fails, naming the line and the field',
  withBase((base) => {
    const dir = judgedFolder(base);
    resealed(dir, (recs) => recs.map((r) => (r.record === 'session_verdict' ? { ...r, verdict: 'fine' } : r)));
    const v = verifySession(dir);
    const last = recordsOf(path.join(dir, 'verdict.jsonl')).length;
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.words, `Record broken at line ${last} of the verdict log: it is not a valid session verdict (/verdict enum).`);
  }),
);

it(
  "BB7: the footer's verdict line must be in the verdict log with its hash; verdicts appended after it are named, intact",
  withBase((base) => {
    const dir = judgedFolder(base);
    const recs = recordsOf(path.join(dir, 'verdict.jsonl'));
    const raw = recordsOf(path.join(dir, 'raw.jsonl'));
    const odus = recordsOf(path.join(dir, 'odu.jsonl'));
    // A closeout's end, so the footer can name it (K4b), then the footer naming the last lines.
    const footerOf = (verdict) => ({ schema_version: 1, record: 'session_footer', session_id: raw[0].session_id, raw: { seq: end.seq, hash: end.hash }, odu: { seq: odus[odus.length - 1].seq, hash: odus[odus.length - 1].hash }, verdict });
    const closeout = seal({ schema_version: 1, session_id: raw[0].session_id, seq: raw[raw.length - 1].seq + 1, source: 'process', agent: null, turn: null, sub_agent: null, observed_at: '2026-11-22T12:00:20.000Z', mono_ns: '1020000000000', target: { kind: 'process', name: 'closeout' }, says: 'exited', detail: { exit_status: 'pass' }, cause_hint: null }, raw[raw.length - 1].hash);
    fs.appendFileSync(path.join(dir, 'raw.jsonl'), canonicalize(closeout) + '\n');
    const end = closeout;
    const last = recs[recs.length - 1];
    fs.writeFileSync(path.join(dir, 'footer.json'), JSON.stringify(footerOf({ seq: last.seq, hash: last.hash })));
    let v = verifySession(dir);
    assert.strictEqual(v.ok, true, v.words);
    assert.ok(v.words.includes('the session footer matches the raw log, the odù log and the verdict log'), v.words);
    fs.writeFileSync(path.join(dir, 'footer.json'), JSON.stringify(footerOf({ seq: last.seq, hash: 'sha256:' + 'e'.repeat(64) })));
    v = verifySession(dir);
    assert.strictEqual(v.words, `Record broken: the session footer names line ${last.seq + 1} of the verdict log with a hash that line does not have.`);
    const mid = recs[recs.length - 2];
    fs.writeFileSync(path.join(dir, 'footer.json'), JSON.stringify(footerOf({ seq: mid.seq, hash: mid.hash })));
    v = verifySession(dir);
    assert.strictEqual(v.ok, true, v.words);
    assert.ok(v.words.includes("1 record after the footer's line in the verdict log"), v.words);
    fs.unlinkSync(path.join(dir, 'verdict.jsonl'));
    v = verifySession(dir);
    assert.strictEqual(v.ok, false, 'a footer naming a verdict log that is gone');
    assert.ok(/verdict log/.test(v.words), v.words);
  }),
);

runAll('verify-verdict');
