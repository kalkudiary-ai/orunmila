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

it('K2r3 (LD211 (3), LD214): a missed change\'s action reads its latest rescan, as its net change does; one back to its before is kept with changed false and no missed_live', () => {
  const base = tmpDir();
  try {
    const log = makeLog(base, {}, { baseline: [{ path: 'src/b.ts', size: 4, fingerprint: FP('b') }, { path: 'src/d.ts', size: 4, fingerprint: FP('d') }] });
    log.append(sweep(1000, 'started'));
    const b1 = log.append(rescan(1010, 'src/b.ts', FP('9')));
    const b2 = log.append(rescan(1020, 'src/b.ts', FP('b'))); // back to the baseline
    log.append({ ...rescan(1030, 'src/d.ts', FP('d')), detail: { exists: false, rescan: true } }); // first read gone
    log.append(rescan(1040, 'src/d.ts', FP('e'))); // then there, changed
    log.append(sweep(1100, 'exited'));
    const r = replayFolder(log.dir);
    assert.strictEqual(r.ok, true, r.words);
    const odus = r.odu.split('\n').slice(1, -1).map((l) => JSON.parse(l));
    for (const o of odus) assert.deepStrictEqual(checkOdu(o), [], JSON.stringify(o));
    const b = at(odus, 'src/b.ts');
    assert.deepStrictEqual([witnesses(b), b.net_change, b.conflicts, b.mark_seqs], [['saw_nothing', 'saw_nothing'], { before: FP('b'), after: FP('b'), changed: false }, [], [b1, b2]], 'kept, changed false, nothing missed');
    const d = at(odus, 'src/d.ts');
    assert.deepStrictEqual([witnesses(d), d.action, d.net_change, d.conflicts.map((c) => c.kind)], [['saw_nothing', 'saw_nothing'], 'modified', { before: FP('d'), after: FP('e'), changed: true }, ['missed_live']], 'its action from the latest rescan, not the first (deleted)');
  } finally {
    rmrf(base);
  }
});

it('Q22 A7 (LD213; checklist row alias-renamed-rescan-oldpath): a file put back by hand at a path renamed away during the session is a missed change, created from absent, though its bytes are the baseline\'s', () => {
  const base = tmpDir();
  try {
    const log = makeLog(base, {}, { baseline: [{ path: 'src/a.ts', size: 4, fingerprint: FP('a') }] });
    log.append(M.disk(0, 'src/b.ts', 'renamed', { from: 'src/a.ts' }));
    log.append(M.fingerprinted(1600, 'src/b.ts', FP('a')));
    log.append(M.tick(9000)); // the rename sealed: a.ts left absent
    log.append(sweep(10000, 'started'));
    const s = log.append(rescan(10010, 'src/a.ts', FP('a'))); // a copy put back by hand, the baseline's bytes
    log.append(sweep(10100, 'exited'));
    const r = replayFolder(log.dir);
    assert.strictEqual(r.ok, true, r.words);
    const odus = r.odu.split('\n').slice(1, -1).map((l) => JSON.parse(l));
    const a = at(odus, 'src/a.ts');
    assert.deepStrictEqual([witnesses(a), a.action, a.net_change, a.mark_seqs, a.conflicts.map((c) => c.kind)], [['saw_nothing', 'saw_nothing'], 'created', { before: 'absent', after: FP('a'), changed: true }, [s], ['missed_live']]);
  } finally {
    rmrf(base);
  }
});

// K3 (LD217; step 3, lines 331, 423): git as the closeout's last witness, corroborating the rescan.
const gitSaw = (ms, file, says = 'modified') => ({ schema_version: 1, session_id: 'ses_replay_test', source: 'git', agent: null, turn: null, sub_agent: null, observed_at: wall(ms), mono_ns: ns(ms), cause_hint: null, target: { kind: 'file', path: file }, says, detail: {} });

it('K3 step 3 (LD217): a missed change git also saw is high and names git in its witness_status; a git mark with no group of its path, or of a temp file, is the sweep\'s receipt and never an odù of its own', () => {
  const base = tmpDir();
  try {
    const log = makeLog(base, {}, { baseline: [{ path: 'src/a.ts', size: 4, fingerprint: FP('a') }, { path: 'src/b.ts', size: 4, fingerprint: FP('b') }, { path: 'src/c.ts', size: 4, fingerprint: FP('c') }] });
    const s = {};
    log.append(sweep(1000, 'started'));
    s.b = log.append(rescan(1010, 'src/b.ts', FP('9'))); // missed, and git saw it
    s.c = log.append(rescan(1020, 'src/c.ts', FP('8'))); // missed, git did not list it
    s.gb = log.append(gitSaw(1030, 'src/b.ts'));
    s.ga = log.append(gitSaw(1040, 'src/a.ts')); // dirty against HEAD, unchanged in the session: no rescan mark, no odù
    s.gt = log.append(gitSaw(1050, 'src/b.ts~', 'created')); // a temp file git lists: its own path, a receipt
    log.append(sweep(1100, 'exited'));
    const r = replayFolder(log.dir);
    assert.strictEqual(r.ok, true, r.words);
    const odus = r.odu.split('\n').slice(1, -1).map((l) => JSON.parse(l));
    for (const o of odus) assert.deepStrictEqual(checkOdu(o), [], JSON.stringify(o));
    const b = at(odus, 'src/b.ts');
    assert.deepStrictEqual([witnesses(b), b.witness_status.git, b.confidence, b.conflicts.map((c) => [c.kind, c.marks]), b.mark_seqs], [['saw_nothing', 'saw_nothing'], { status: 'saw', mark_seqs: [s.gb], says: ['modified'], slots: [{ seq: s.gb }] }, 'high', [['missed_live', [s.b]]], [s.b, s.gb]]);
    const c = at(odus, 'src/c.ts');
    assert.deepStrictEqual([witnesses(c), 'git' in c.witness_status, c.confidence], [['saw_nothing', 'saw_nothing'], false, 'medium']);
    assert.deepStrictEqual(odus.filter((o) => o.target && ['src/a.ts', 'src/b.ts~'].includes(o.target.path)), [], 'no odù of their own');
    const sweepOdu = odus.find((o) => o.target && o.target.kind === 'process' && o.action === 'started');
    assert.deepStrictEqual([s.ga, s.gt].map((q) => sweepOdu.mark_seqs.includes(q)), [true, true], 'receipts');
  } finally {
    rmrf(base);
  }
});

it("F3 (LD225; Q24 checklist rows S-git-before, S-git-after): a git mark outside a sweep that is taking marks joins nothing, before the sweep began or after it ended: never an odù of its own; one whose path's group is still taking marks joins that group", () => {
  const base = tmpDir();
  try {
    const log = makeLog(base, {}, { baseline: [{ path: 'src/a.ts', size: 4, fingerprint: FP('a') }] });
    const s = {};
    s.before = log.append(gitSaw(500, 'src/a.ts')); // before any sweep
    s.disk = log.append(M.disk(900, 'src/o.ts')); // a hand edit, its group still taking marks
    s.join = log.append(gitSaw(1000, 'src/o.ts'));
    log.append(sweep(10000, 'started'));
    log.append(sweep(10100, 'exited'));
    s.after = log.append(gitSaw(10200, 'src/a.ts', 'deleted')); // after the sweep's end
    log.append(M.tick(30000));
    const r = replayFolder(log.dir);
    assert.strictEqual(r.ok, true, r.words);
    const groups = r.lines.slice(1).map((l) => JSON.parse(l));
    const odus = r.odu.split('\n').slice(1, -1).map((l) => JSON.parse(l));
    for (const o of odus) assert.deepStrictEqual(checkOdu(o), [], JSON.stringify(o));
    assert.deepStrictEqual(groups.filter((g) => g.mark_seqs.includes(s.before) || g.mark_seqs.includes(s.after)).map((g) => g.target), [], 'in no group, sealed or not');
    assert.deepStrictEqual(odus.filter((o) => o.target && o.target.path === 'src/a.ts'), []);
    const o = at(odus, 'src/o.ts');
    assert.deepStrictEqual([witnesses(o), o.witness_status.git.mark_seqs, o.mark_seqs], [['saw_nothing', 'saw'], [s.join], [s.disk, s.join]]);
  } finally {
    rmrf(base);
  }
});

// K7 (Q21 (a), LD216; line 441; tests 4 and 73): a phantom file claim waits for the closeout's rescan.
const said = (ms, text, turn = 't1') => ({ ...M.claimed(ms, turn), detail: { text } });

it('K7 tests 4 and 73 (LD216): a phantom file claim is sealed at the closeout, high when the rescan walked its path and found it unchanged, low for an excluded path, a path the rescan found changed, or a walk that failed; with no closeout it is never sealed and reads low', () => {
  for (const end of ['pass', 'fail', 'none']) {
    const base = tmpDir();
    try {
      const log = makeLog(base, { exclusions: ['vendor'] }, { baseline: [['config', 'c'], ['u', 'd'], ['h', 'e']].map(([n, f]) => ({ path: `src/${n}.ts`, size: 4, fingerprint: FP(f) })) });
      log.append(M.edited(0, 'e1', 'src/u.ts')); // edited, then back to its bytes: net change false
      log.append(M.disk(50, 'src/u.ts'));
      log.append(M.fingerprinted(1600, 'src/u.ts', FP('d')));
      log.append(said(2000, 'I updated src/config.ts. I updated vendor/lib.ts. I updated src/u.ts. I updated src/h.ts.'));
      log.append(M.turnEnded(2000));
      log.append(M.tick(9000));
      if (end !== 'none') {
        log.append(sweep(10000, 'started'));
        log.append(rescan(10010, 'src/h.ts', FP('9'))); // h.ts changed by a hand no witness saw
        log.append({ ...sweep(10100, 'exited'), detail: { exit_status: end } });
      }
      const r = replayFolder(log.dir);
      assert.strictEqual(r.ok, true, r.words);
      const odus = r.odu.split('\n').slice(1, -1).map((l) => JSON.parse(l));
      for (const o of odus) assert.deepStrictEqual(checkOdu(o), [], JSON.stringify(o));
      const claimsIn = (list) => Object.fromEntries(list.filter((o) => o.target && o.target.kind === 'claim' && o.conflicts && o.conflicts.some((c) => c.kind === 'phantom_claim')).map((o) => [o.conflicts[0].path, o]));
      const sealed = claimsIn(odus);
      if (end === 'none') {
        assert.deepStrictEqual(Object.keys(sealed), [], 'no closeout: no phantom file claim sealed');
        const rest = claimsIn(r.lines.slice(1).map((l) => JSON.parse(l)).filter((g) => g.state !== 'sealed'));
        assert.deepStrictEqual(Object.keys(rest).sort(), ['src/config.ts', 'src/h.ts', 'src/u.ts', 'vendor/lib.ts']);
        for (const o of Object.values(rest)) assert.deepStrictEqual([o.state, o.confidence, o.sealed_at_ns], ['settled', 'low', null]);
        continue;
      }
      const want = { 'src/config.ts': ['no_event', 'high', 'out_of_scope'], 'vendor/lib.ts': ['no_event', 'low', 'out_of_scope'], 'src/u.ts': ['unchanged', 'high', 'saw'], 'src/h.ts': ['no_event', 'low', 'out_of_scope'] };
      const exited = odus.find((o) => o.target && o.target.kind === 'process' && o.action === 'exited');
      for (const [p, [why, conf, sentinel]] of Object.entries(want)) {
        const o = sealed[p];
        assert.ok(o, `${end}: ${p} sealed`);
        assert.deepStrictEqual([witnesses(o), o.conflicts[0].kind, o.conflicts[0].why, o.confidence, o.seq > exited.seq], [['saw', sentinel], 'phantom_claim', why, end === 'pass' ? conf : 'low', true], `${end}: ${p}, sealed after the closeout's end`);
      }
      const h = at(odus, 'src/h.ts');
      assert.deepStrictEqual(h.conflicts.map((c) => c.kind), ['missed_live']);
    } finally {
      rmrf(base);
    }
  }
});

/** The phantom file claims sealed in an odù list, by the path as the claim wrote it (K7, F1). */
const fileClaims = (list) => Object.fromEntries(list.filter((o) => o.target && o.target.kind === 'claim' && o.conflicts && o.conflicts.some((c) => c.kind === 'phantom_claim' && c.claim === 'file')).map((o) => [o.conflicts[0].path, o]));

it("F1 (LD226; Q24 checklist rows P-k7-*, W-*-baseline): a phantom file claim is high only for a path the walk could fingerprint: low for a path the baseline lists as a link, other or unreadable entry, or under one, and for a bare name while any such entry or any exclusion exists; high for a regular file or a path absent with nothing above it hiding it, however the path is written", () => {
  const cases = [
    { label: 'entries without a fingerprint', exclusions: [], extra: [{ path: 'src/l.ts', kind: 'link' }, { path: 'src/linkdir', kind: 'link' }, { path: 'src/locked', kind: 'unreadable', error: 'EACCES' }, { path: 'src/o.ts', kind: 'other' }, { path: 'src/u.ts', kind: 'unreadable', error: 'EACCES' }] },
    { label: 'all regular, nothing excluded', exclusions: [], extra: [] },
    { label: 'all regular, an exclusion', exclusions: ['vendor'], extra: [] },
  ];
  for (const k of cases) {
    const base = tmpDir();
    try {
      const log = makeLog(base, { exclusions: k.exclusions }, { baseline: [...[['r', '1'], ['h', '2'], ['a', '3']].map(([n, f]) => ({ path: `src/${n}.ts`, size: 4, fingerprint: FP(f) })), ...k.extra] });
      const root = log.header.project_root;
      const written = ['src/r.ts', './src/r.ts', `${root}/src/r.ts`, './src/h.ts', `${root}/src/h.ts`, 'h.ts', 'src/a.ts', 'src/l.ts', 'src/o.ts', 'src/u.ts', 'src/locked/new.ts', 'src/linkdir/new.ts', 'src/absent.ts', '/elsewhere/x.ts', '../x.ts', 'r.ts'];
      log.append(said(2000, written.map((w) => `I updated ${w}.`).join(' ')));
      log.append(M.turnEnded(2000));
      log.append(M.tick(9000));
      log.append(sweep(10000, 'started'));
      log.append(rescan(10010, 'src/h.ts', FP('9'))); // h.ts changed by a hand no witness saw
      log.append(rescan(10020, 'src/a.ts~', FP('7'))); // a leftover backup of a.ts; a.ts itself unchanged
      log.append(sweep(10100, 'exited'));
      const r = replayFolder(log.dir);
      assert.strictEqual(r.ok, true, r.words);
      const odus = r.odu.split('\n').slice(1, -1).map((l) => JSON.parse(l));
      for (const o of odus) assert.deepStrictEqual(checkOdu(o), [], JSON.stringify(o));
      const sealed = fileClaims(odus);
      assert.deepStrictEqual(Object.keys(sealed).sort(), [...written].sort(), `${k.label}: every claim sealed`);
      const hiddenEntries = k.extra.length > 0;
      const want = {
        'src/r.ts': 'high', './src/r.ts': 'high', [`${root}/src/r.ts`]: 'high', // a regular file, walked, unchanged
        './src/h.ts': 'low', [`${root}/src/h.ts`]: 'low', 'h.ts': 'low', // the rescan found it changed
        'src/a.ts': 'high', // only its temp file was rescanned
        'src/l.ts': hiddenEntries ? 'low' : 'high', 'src/o.ts': hiddenEntries ? 'low' : 'high', 'src/u.ts': hiddenEntries ? 'low' : 'high',
        'src/locked/new.ts': hiddenEntries ? 'low' : 'high', 'src/linkdir/new.ts': hiddenEntries ? 'low' : 'high',
        'src/absent.ts': 'high', '/elsewhere/x.ts': 'low', '../x.ts': 'low',
        'r.ts': hiddenEntries || k.exclusions.length ? 'low' : 'high', // a bare name could sit anywhere the walk did not see
      };
      for (const [w, conf] of Object.entries(want)) {
        const o = sealed[w];
        assert.deepStrictEqual([o.witness_status.glove.status, o.witness_status.sentinel.status, o.conflicts[0].why, o.confidence], ['saw', 'out_of_scope', 'no_event', conf], `${k.label}: ${w}`);
      }
    } finally {
      rmrf(base);
    }
  }
});

// K6 (LD218; lines 614, 644, 691): the agent's closeout feedback read from the odù log, side by side with the old path.
it('K6 line 614 (LD218): the agent\'s JSON feedback from the odù log: phantom claims by turn, silent changes as undisclosed, the other conflicts as findings; side by side with the old path; the CLI reads it only with ORUNMILA_FEEDBACK_FROM_ODU=1', () => {
  const { feedbackFromOdu, sideBySide } = require('../src/opon/feedback/from-odu');
  const { spawnSync } = require('child_process');
  const base = tmpDir();
  try {
    const log = makeLog(base, {}, { baseline: [{ path: 'src/config.ts', size: 4, fingerprint: FP('c') }, { path: 'src/h.ts', size: 4, fingerprint: FP('e') }] });
    log.append(M.prompted(0));
    log.append(M.edited(10, 'e1', 'src/s.ts')); // an agent change its claims never mention: silent
    log.append(M.disk(60, 'src/s.ts'));
    log.append(said(2000, 'I updated src/config.ts. All tests pass.')); // a phantom file claim and a phantom command claim
    log.append(M.turnEnded(2000));
    log.append(M.tick(9000));
    log.append(sweep(10000, 'started'));
    log.append(rescan(10010, 'src/h.ts', FP('9'))); // a hand change no live witness saw
    log.append(sweep(10100, 'exited'));
    const r = replayFolder(log.dir);
    assert.strictEqual(r.ok, true, r.words);
    const odus = r.odu.split('\n').slice(1, -1).map((l) => JSON.parse(l));
    const s = at(odus, 'src/s.ts');
    assert.deepStrictEqual([witnesses(s), s.conflicts.map((c) => c.kind)], [['saw', 'saw'], ['silent_change']]);
    const fb = feedbackFromOdu({ sessionId: 'ses_replay_test', agent: 'claude-code', oduText: r.odu });
    assert.deepStrictEqual(fb, feedbackFromOdu({ sessionId: 'ses_replay_test', agent: 'claude-code', oduText: r.odu }), 'deterministic');
    assert.deepStrictEqual([fb.schema_version, fb.source, fb.turns.map((t) => t.turn)], ['1.0', 'odu_log', ['t1']]);
    const t1 = fb.turns[0];
    assert.deepStrictEqual(t1.claims.map((c) => [c.outcome, c.evidence.why, c.verdict_confidence]).sort(), [['phantom', 'no_event', 'high'], ['phantom_verification', 'no_command', 'high']]);
    for (const c of t1.claims) assert.ok(odus.some((o) => o.odu_id === c.evidence.odu_id && o.mark_seqs.join() === c.evidence.mark_seqs.join()), 'each claim cites its odù and marks');
    assert.deepStrictEqual([t1.undisclosed_changes.map((u) => u.ref), t1.summary.phantom, t1.summary.phantom_verification, t1.summary.undisclosed, fb.summary.phantom], [['src/s.ts'], 1, 1, 1, 1]);
    assert.deepStrictEqual(fb.findings.map((f) => [f.kind, f.target, f.confidence]), [['missed_live', 'src/h.ts', 'medium']]);
    const old = { turns: [{ turn: 't1', claims: [{ outcome: 'phantom' }, { outcome: 'phantom' }, { outcome: 'phantom_verification' }, { outcome: 'verified' }], undisclosed_changes: [{ ref: 'src/s.ts' }, { ref: 'src/z.ts' }] }] };
    assert.deepStrictEqual(sideBySide(old, fb), [
      { turn: 't1', kind: 'phantom', old: 2, odu: 1, in: 'old' },
      { turn: 't1', kind: 'phantom_verification', old: 1, odu: 1, in: 'both' },
      { turn: 't1', kind: 'undisclosed', ref: 'src/s.ts', in: 'both' },
      { turn: 't1', kind: 'undisclosed', ref: 'src/z.ts', in: 'old' },
    ]);
    // The CLI: the old path unless the flag is on.
    const home = path.join(base, 'home');
    fs.mkdirSync(path.join(home, 'sessions', 'ses_replay_test'), { recursive: true });
    fs.writeFileSync(path.join(home, 'sessions', 'ses_replay_test', 'odu.jsonl'), r.odu);
    const cli = (on) => spawnSync('node', [path.join(__dirname, '..', 'bin', 'orunmila.js'), 'json', '--session', 'ses_replay_test'], { encoding: 'utf8', env: { ...process.env, ORUNMILA_HOME: home, ORUNMILA_FEEDBACK_FROM_ODU: on ? '1' : '' } });
    const on = cli(true);
    assert.strictEqual(on.status, 0, on.stderr);
    assert.deepStrictEqual(JSON.parse(on.stdout).source, 'odu_log');
    const off = cli(false);
    assert.strictEqual(off.status, 0, off.stderr);
    assert.deepStrictEqual(['source' in JSON.parse(off.stdout), 'findings' in JSON.parse(off.stdout)], [false, false], 'flag off: the old path, unchanged');
  } finally {
    rmrf(base);
  }
});

runAll('closeout');
