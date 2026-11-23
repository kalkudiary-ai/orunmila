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

runAll('closeout');
