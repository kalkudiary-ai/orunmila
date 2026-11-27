// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/verify-odu.js — V1 (Phase 7; brief v4 lines 714-715; test 29): `verify` checks the odù log whenever a session
 * folder holds one, not only when a footer names it: its hash chain, its header tied to this session's raw log, every
 * line a valid record of its kind, and every odù's `mark_seqs` naming marks the raw log holds. Hand-built session logs
 * (test/helpers-opon.js), the odù log replay's; made-up paths.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { makeLog, M } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');
const { verifySession } = require('../src/verify/session');
const { seal } = require('../src/verify/chain');
const { canonicalize } = require('../src/verify/canonical');

/** A session folder with replay's odù log and no footer: an edit both witnesses saw, a hand edit, a turn. */
function oduFolder(base) {
  const s = makeLog(base);
  s.append(M.prompted(0));
  s.append(M.started(10, 'e1', { kind: 'file', path: 'src/a.ts' }));
  s.append(M.edited(100, 'e1', 'src/a.ts'));
  s.append(M.disk(300, 'src/a.ts'));
  s.append(M.disk(400, 'src/hand.ts'));
  s.append(M.turnEnded(900));
  s.append(M.tick(10000));
  const r = replayFolder(s.dir);
  assert.ok(r.ok, r.words);
  fs.writeFileSync(path.join(s.dir, 'odu.jsonl'), r.odu);
  return s.dir;
}
const file = (dir) => path.join(dir, 'odu.jsonl');
const recordsOf = (dir) => fs.readFileSync(file(dir), 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));
/** Rewrite the odù log with `change` applied to its records, every line sealed again, so its chain holds. */
function resealed(dir, change) {
  let prev = null;
  const out = change(recordsOf(dir)).map((r) => (prev = seal({ ...r }, prev ? prev.hash : null)));
  fs.writeFileSync(file(dir), out.map((r) => canonicalize(r) + '\n').join(''));
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
  'V1: an untouched session with an odù log and no footer is intact, and the words count its odù records',
  withBase((base) => {
    const dir = oduFolder(base);
    const n = recordsOf(dir).filter((r) => r.record === 'odu').length;
    assert.ok(n >= 3, `replay gave ${n} odùs`);
    const v = verifySession(dir);
    assert.strictEqual(v.ok, true, v.words);
    assert.strictEqual(v.counts.odus, n);
    assert.ok(v.words.includes(`${n} odù records, each pointing to marks the raw log holds`), v.words);
  }),
);

it(
  'V1 test 29: an odù edited to list a mark that does not exist, its chain sealed again, fails: "odù points to evidence that does not exist"',
  withBase((base) => {
    const dir = oduFolder(base);
    const at = recordsOf(dir).findIndex((r) => r.record === 'odu');
    resealed(dir, (recs) => recs.map((r, i) => (i === at ? { ...r, mark_seqs: [...r.mark_seqs, 9999] } : r)));
    const v = verifySession(dir);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.words, `Record broken at line ${at + 1} of the odù log: this odù points to evidence that does not exist (mark 9999).`);
  }),
);

it(
  'V1: one odù line edited after it was written fails with no footer present, naming the line',
  withBase((base) => {
    const dir = oduFolder(base);
    const lines = fs.readFileSync(file(dir), 'utf8').split('\n');
    const at = lines.findIndex((l) => l.includes('"record":"odu"'));
    lines[at] = lines[at].replace('"confidence":"high"', '"confidence":"low"').replace('"confidence":"medium"', '"confidence":"low"');
    assert.notStrictEqual(lines.join('\n'), fs.readFileSync(file(dir), 'utf8'), 'the edit changed the line');
    fs.writeFileSync(file(dir), lines.join('\n'));
    const v = verifySession(dir);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.words, `Record broken at line ${at + 1} of the odù log: this line was changed after it was written.`);
  }),
);

it(
  'V1: an odù that is not a valid record of its kind, or a header tied to another raw log, fails naming the line and the field',
  withBase((base) => {
    const dir = oduFolder(base);
    const at = recordsOf(dir).findIndex((r) => r.record === 'odu');
    resealed(dir, (recs) => recs.map((r, i) => (i === at ? { ...r, confidence: 'certain' } : r)));
    assert.strictEqual(verifySession(dir).words, `Record broken at line ${at + 1} of the odù log: it is not a valid odù (/confidence enum).`);
    const dir2 = oduFolder(path.join(base, 'b'));
    resealed(dir2, (recs) => recs.map((r) => (r.record === 'odu_header' ? { ...r, raw_header: 'sha256:' + 'a'.repeat(64) } : r)));
    assert.strictEqual(verifySession(dir2).words, "Record broken at line 1 of the odù log: it names a raw log header this session's raw log does not have.");
    const dir3 = oduFolder(path.join(base, 'c'));
    resealed(dir3, (recs) => recs.slice(1).map((r, i) => ({ ...r, seq: i }))); // renumbered, so the chain holds
    assert.strictEqual(verifySession(dir3).words, 'Record broken at line 1 of the odù log: the odù log does not begin with its header.');
  }),
);

it(
  'V1: with no footer, an odù log whose last line a crash cut short is intact, and the cut is named',
  withBase((base) => {
    const dir = oduFolder(base);
    const text = fs.readFileSync(file(dir), 'utf8');
    const lines = text.split('\n').slice(0, -1);
    fs.writeFileSync(file(dir), text.slice(0, text.length - 1 - Math.floor(lines[lines.length - 1].length / 2)));
    const v = verifySession(dir);
    assert.strictEqual(v.ok, true, v.words);
    assert.ok(v.words.includes(`line ${lines.length} of the odù log was cut short, as a crash leaves it`), v.words);
    assert.strictEqual(v.counts.odus, lines.length - 2);
  }),
);

it(
  'V1: a session whose odù log is broken still reopens for capture, and the next mark is written (an odù problem never stops capture, L1d)',
  withBase((base) => {
    const { openSessionLog } = require('../src/opon/ledger/session-log');
    const dir = oduFolder(base);
    resealed(dir, (recs) => recs.map((r) => (r.record === 'odu' ? { ...r, mark_seqs: [9999] } : r)));
    assert.strictEqual(verifySession(dir).ok, false, 'the odù log is broken');
    const log = openSessionLog(dir);
    assert.strictEqual(log.append(M.tick(20000)).ok, true);
    assert.strictEqual(log.counts().marks, 8);
  }),
);

it(
  "SP1b: every line of the quarantine log is checked against its schema: a quarantined record with no reason, its chain sealed again, fails naming the line",
  withBase((base) => {
    const { openSessionLog } = require('../src/opon/ledger/session-log');
    const s = makeLog(base);
    assert.strictEqual(openSessionLog(s.dir).append({ says: 'shouted' }).ok, false); // not a mark: quarantined with its reasons
    const q = path.join(s.dir, 'quarantine.jsonl');
    const recs = fs.readFileSync(q, 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));
    assert.deepStrictEqual(recs.map((r) => r.record), ['quarantine_header', 'quarantined']);
    assert.strictEqual(verifySession(s.dir).ok, true, verifySession(s.dir).words);
    let prev = null;
    const out = recs.map((r) => (prev = seal(r.record === 'quarantined' ? { ...r, reasons: [] } : { ...r }, prev ? prev.hash : null)));
    fs.writeFileSync(q, out.map((r) => canonicalize(r) + '\n').join(''));
    assert.strictEqual(verifySession(s.dir).words, 'Record broken at line 2 of the quarantine log: it is not a valid quarantined record (/reasons minItems).');
  }),
);

runAll('verify-odu');
