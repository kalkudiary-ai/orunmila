'use strict';

/**
 * test/closeout.js — the closeout's final sweep in the event-time engine (Phase 4, provisional
 * under TURBO until O approves the Phase 3 report, Q17; slice K1, LD204; brief v4 lines 445-455).
 * The intake records the sweep as marks (Q18's proposal), so replay seals as the live engine does:
 * on the closeout's end mark every group still open, held or waiting is force-settled through
 * stations 4-6 and sealed. Glove and Sentinel joined on every odù asserted (LD182). Hand-built logs,
 * labelled so (brief line 761): made-up paths. Quiet window 1,500 ms, lag grace 3,000 ms.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { makeLog, M, wall, ns } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');
const { compile } = require('../src/verify/schema');

const checkOdu = compile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'odu.schema.json'), 'utf8')));
const checkMark = compile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'mark.schema.json'), 'utf8')));

/** The closeout's marks (Q18's proposal): source process, target the closeout, started then exited. */
const sweep = (ms, says) => ({ schema_version: 1, session_id: 'ses_replay_test', source: 'process', agent: null, turn: null, sub_agent: null, observed_at: wall(ms), mono_ns: ns(ms), cause_hint: null, target: { kind: 'process', name: 'closeout' }, says, detail: says === 'exited' ? { exit_status: 'pass' } : {} });

function replay(build) {
  const base = tmpDir();
  try {
    const log = makeLog(base);
    build(log.append);
    const r = replayFolder(log.dir);
    assert.strictEqual(r.ok, true, r.words);
    const groups = r.lines.slice(1).map((l) => JSON.parse(l));
    const odus = r.odu.split('\n').slice(1, -1).map((l) => JSON.parse(l));
    for (const o of odus) assert.deepStrictEqual(checkOdu(o), [], JSON.stringify(o));
    return { groups, odus, odu: r.odu };
  } finally {
    rmrf(base);
  }
}
const witnesses = (o) => [o.witness_status.glove.status, o.witness_status.sentinel.status];
const at = (odus, p) => odus.find((o) => o.target && o.target.path === p);

const session = (append, withSweep) => {
  append(M.prompted(0));
  append(M.edited(0, 'e1', 'src/waits.ts')); // an agent change waiting for its turn's end (C3d2)
  append(M.disk(50, 'src/waits.ts'));
  append(M.started(100, 'e2', { kind: 'file', path: 'src/held.ts' })); // a call in flight (C3b)
  append(M.gap(300, 'hook payloads dropped')); // a Glove capture gap after the call began: its wait ends at the sweep, so the gap covers it
  append(M.tick(5000)); // waits.ts is closed by now (quiet window and lag grace), its seal waiting for the turn
  append(M.disk(5800, 'src/open.ts')); // a hand edit still open at the sweep
  if (withSweep) {
    append(sweep(6000, 'started'));
    append(sweep(6100, 'exited'));
  }
};

it('K1 lines 451-452: on the closeout\'s end mark every group still open, held or waiting is force-settled through stations 4-6 and sealed; none is left unsealed', () => {
  const { groups, odus } = replay((append) => session(append, true));
  assert.deepStrictEqual(groups.filter((g) => g.state !== 'sealed').map((g) => g.target), [], 'nothing left open');
  const turn = odus.find((o) => o.target && o.target.kind === 'turn');
  assert.deepStrictEqual([witnesses(turn), turn.attribution], [['saw', 'out_of_scope'], 'explained'], 'the turn, its Stop never come, sealed too');
  const waits = at(odus, 'src/waits.ts');
  assert.deepStrictEqual([witnesses(waits), waits.attribution, waits.confidence], [['saw', 'saw'], 'explained', 'high']);
  const held = at(odus, 'src/held.ts');
  assert.deepStrictEqual([witnesses(held), held.conflicts.map((c) => [c.kind, c.ref, c.why])], [['saw', 'out_of_scope'], [['outcome_missing', 'e2', 'gap']]], 'judged at the closeout: no outcome by the end, a capture gap covering its wait');
  const open = at(odus, 'src/open.ts');
  assert.deepStrictEqual([witnesses(open), open.attribution], [['saw_nothing', 'saw'], 'unexplained']);
  const notes = odus.filter((o) => o.target && o.target.kind === 'process' && o.target.name === 'closeout');
  assert.deepStrictEqual(notes.map((o) => o.action), ['started', 'exited'], "the sweep's own marks are odùs too");
});

it('K1: without the closeout\'s marks the same session leaves its groups unsealed, as before (the closeout is what seals them)', () => {
  const { groups } = replay((append) => session(append, false));
  assert.deepStrictEqual(groups.filter((g) => g.state !== 'sealed' && g.target).map((g) => g.target.path || g.target.kind).sort(), ['src/held.ts', 'src/open.ts', 'src/waits.ts', 'turn']);
});

it('K1 test 13: a log with its closeout replayed twice gives byte-identical odù logs; the closeout marks are valid marks', () => {
  const base = tmpDir();
  try {
    const log = makeLog(base);
    session(log.append, true);
    const one = replayFolder(log.dir);
    const two = replayFolder(log.dir);
    assert.deepStrictEqual([one.ok, two.ok, one.odu === two.odu, one.odu.split('\n').length > 3], [true, true, true, true]);
  } finally {
    rmrf(base);
  }
  for (const says of ['started', 'exited']) assert.deepStrictEqual(checkMark({ ...sweep(400, says), seq: 9, prev_hash: 'sha256:' + '1'.repeat(64), hash: 'sha256:' + '2'.repeat(64) }), [], says);
});

// K2 (LD207; line 450; test 32's replay half): the full rescan's fingerprints, read against the last sealed state or the baseline.
const { FP } = require('./helpers-opon');
const rescan = (ms, file, fp) => ({ ...M.fingerprinted(ms, file, fp), detail: { ...M.fingerprinted(ms, file, fp).detail, rescan: true } });

it('K2 line 450: a rescanned file that differs from what the session last knew, with no odù, becomes an odù of its own: unexplained, missed_live naming the rescan\'s mark, each live witness saw_nothing; one that matches joins the sweep\'s own odù; one with a group still open joins that group', () => {
  const base = tmpDir();
  try {
    const log = makeLog(base, { exclusions: ['node_modules'] }, { baseline: [{ path: 'src/a.ts', size: 4, fingerprint: FP('a') }, { path: 'src/b.ts', size: 4, fingerprint: FP('b') }, { path: 'src/e.ts', size: 4, fingerprint: FP('e') }] });
    const s = {};
    log.append(M.edited(0, 'e1', 'src/e.ts'));
    log.append(M.disk(50, 'src/e.ts'));
    log.append(M.fingerprinted(1600, 'src/e.ts', FP('f'))); // e.ts's agent edit settles with after f
    log.append(M.turnEnded(100));
    log.append(M.tick(9000)); // e.ts sealed
    log.append(M.disk(9500, 'src/o.ts', 'created')); // a hand edit still open at the sweep
    log.append(sweep(10000, 'started'));
    s.a = log.append(rescan(10010, 'src/a.ts', FP('a'))); // as the baseline: nothing missed
    s.b = log.append(rescan(10020, 'src/b.ts', FP('9'))); // changed, and no odù: missed live
    s.c = log.append(rescan(10030, 'src/c.ts', FP('c'))); // not in the baseline: created, missed live
    s.e = log.append(rescan(10040, 'src/e.ts', FP('f'))); // as its last sealed state: nothing missed
    s.o = log.append(rescan(10050, 'src/o.ts', FP('7'))); // its group still open: joins it
    s.x = log.append(rescan(10060, 'node_modules/x.js', FP('5'))); // excluded: its before is unknown, never read as a change
    s.late = log.append(rescan(15000, 'src/a.ts', FP('a'))); // past a quiet window and the lag grace: the sweep is still held open
    log.append(sweep(15100, 'exited'));
    const r = replayFolder(log.dir);
    assert.strictEqual(r.ok, true, r.words);
    const odus = r.odu.split('\n').slice(1, -1).map((l) => JSON.parse(l));
    for (const o of odus) assert.deepStrictEqual(checkOdu(o), [], JSON.stringify(o));
    const missed = (seq) => ({ kind: 'missed_live', sources: ['hook', 'process', 'sentinel'], said: { hook: [], process: ['fingerprinted'], sentinel: [] }, marks: [seq] });
    const b = at(odus, 'src/b.ts');
    assert.deepStrictEqual([witnesses(b), b.action, b.attribution, b.cause, b.net_change, b.mark_seqs, b.conflicts], [['saw_nothing', 'saw_nothing'], 'modified', 'unexplained', null, { before: FP('b'), after: FP('9'), changed: true }, [s.b], [missed(s.b)]]);
    const c = at(odus, 'src/c.ts');
    assert.deepStrictEqual([witnesses(c), c.action, c.net_change, c.conflicts], [['saw_nothing', 'saw_nothing'], 'created', { before: 'absent', after: FP('c'), changed: true }, [missed(s.c)]]);
    assert.deepStrictEqual(odus.filter((o) => o.target && o.target.path === 'src/a.ts'), [], 'a.ts: no odù of its own');
    assert.deepStrictEqual(odus.filter((o) => o.target && o.target.path === 'src/e.ts').map((o) => o.mark_seqs.includes(s.e)), [false], 'e.ts: only its edit\'s odù, the rescan not in it');
    const sweepOdu = odus.find((o) => o.target && o.target.kind === 'process' && o.target.name === 'closeout' && o.action === 'started');
    assert.deepStrictEqual([s.a, s.e, s.x, s.late].map((q) => sweepOdu.mark_seqs.includes(q)), [true, true, true, true], 'the unchanged and unknown files\' rescan marks are the sweep\'s receipts');
    assert.deepStrictEqual(odus.filter((o) => o.target && o.target.path === 'node_modules/x.js'), [], 'an unknown before is not a missed change');
    const o = at(odus, 'src/o.ts');
    assert.deepStrictEqual([witnesses(o), o.mark_seqs.includes(s.o), o.net_change.after, o.conflicts], [['saw_nothing', 'saw'], true, FP('7'), []]);
    assert.strictEqual(b.confidence, 'medium', 'seen by the rescan alone, neither the Sentinel nor git');
    const { marks: _m, ...noMarks } = b.conflicts[0];
    assert.ok(checkOdu({ ...b, conflicts: [noMarks] }).length > 0, 'a missed_live names the rescan\'s marks');
  } finally {
    rmrf(base);
  }
});

it('K2r (LD210 (6), named K2b there): two rescans of one path: the missed change reads the latest, as any fingerprint (N2)', () => {
  const base = tmpDir();
  try {
    const log = makeLog(base, {}, { baseline: [{ path: 'src/b.ts', size: 4, fingerprint: FP('b') }] });
    log.append(sweep(1000, 'started'));
    log.append(rescan(1010, 'src/b.ts', FP('9')));
    log.append(rescan(1020, 'src/b.ts', FP('8')));
    log.append(sweep(1100, 'exited'));
    const r = replayFolder(log.dir);
    const b = r.odu.split('\n').slice(1, -1).map((l) => JSON.parse(l)).find((o) => o.target && o.target.path === 'src/b.ts');
    assert.deepStrictEqual([witnesses(b), b.net_change, b.conflicts.map((c) => [c.kind, c.marks.length])], [['saw_nothing', 'saw_nothing'], { before: FP('b'), after: FP('8'), changed: true }, [['missed_live', 2]]]);
  } finally {
    rmrf(base);
  }
});

it('K2r2 (LD210/LD211 (1), (6); Q22 checklist rows alias-*-rescan): a rescan mark keeps its own path: an editor\'s leftover temp or swap file is never read as the file it stands for, before or after that file\'s own rescan', () => {
  const base = tmpDir();
  try {
    const log = makeLog(base, {}, { baseline: [{ path: 'src/a.ts', size: 4, fingerprint: FP('a') }, { path: 'src/b.ts', size: 4, fingerprint: FP('b') }, { path: 'src/c.ts', size: 4, fingerprint: FP('c') }] });
    const s = {};
    log.append(sweep(1000, 'started'));
    s.swp = log.append(rescan(1010, 'src/.a.ts.swp', FP('7'))); // sorts before src/a.ts in the walk
    s.a = log.append(rescan(1020, 'src/a.ts', FP('a'))); // a.ts as the baseline: nothing missed
    s.tilde = log.append(rescan(1030, 'src/b.ts~', FP('9'))); // a leftover backup of b.ts, b.ts itself unchanged (no rescan mark)
    s.v = log.append(rescan(1040, 'src/4913', FP('6'))); // vim's probe file, left behind
    s.tmp = log.append(rescan(1050, 'src/c.ts.tmp', FP('5'))); // and the other three temp forms of c.ts, c.ts itself unchanged
    s.lock = log.append(rescan(1060, 'src/.#c.ts', FP('4')));
    s.swp2 = log.append(rescan(1070, 'src/c.ts.swp', FP('3')));
    log.append(sweep(1100, 'exited'));
    const r = replayFolder(log.dir);
    assert.strictEqual(r.ok, true, r.words);
    const odus = r.odu.split('\n').slice(1, -1).map((l) => JSON.parse(l));
    assert.deepStrictEqual(odus.filter((o) => o.target && ['src/a.ts', 'src/b.ts', 'src/c.ts'].includes(o.target.path)), [], 'a.ts, b.ts and c.ts: no odù, the temp files are not them');
    for (const [p, seq, fp] of [['src/.a.ts.swp', s.swp, FP('7')], ['src/b.ts~', s.tilde, FP('9')], ['src/4913', s.v, FP('6')], ['src/c.ts.tmp', s.tmp, FP('5')], ['src/.#c.ts', s.lock, FP('4')], ['src/c.ts.swp', s.swp2, FP('3')]]) {
      const o = at(odus, p);
      assert.deepStrictEqual([witnesses(o), o.action, o.net_change, o.mark_seqs, o.conflicts.map((c) => c.kind)], [['saw_nothing', 'saw_nothing'], 'created', { before: 'absent', after: fp, changed: true }, [seq], ['missed_live']], p);
    }
    const sweepOdu = odus.find((o) => o.target && o.target.kind === 'process' && o.action === 'started');
    assert.ok(sweepOdu.mark_seqs.includes(s.a), "a.ts's rescan is the sweep's receipt");
  } finally {
    rmrf(base);
  }
});

runAll('closeout');
