'use strict';

/**
 * test/feedback-verdicts.js — the agent's feedback from the verdicts (Phase 6 slice BB9; brief v4 lines 614, 691; plan
 * section 8). The agent's loop reads `orunmila json` (skills/agent-review-workflow step 2); with
 * ORUNMILA_FEEDBACK_FROM_VERDICTS=1 it is built from the session's logs: K6's 1.0 shape from the odù log, each phantom
 * claim carrying its verdict, the session verdict and the report's findings beside it. Off by default: the old path is
 * kept for one release (Ship item 5). Hand-built session logs (test/helpers-opon.js); made-up paths.
 */

const { assert, fs, path, tmpDir, rmrf, run, it, runAll } = require('./helpers');
const { makeLog, M } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');

const check = (ms, result) => ({ ...M.claimed(ms), source: 'law_gate', says: 'checked', target: { kind: 'turn', id: 't1' }, detail: { result, findings: [] } });
const sweep = (ms, says, detail) => ({ ...M.tick(ms), target: { kind: 'process', name: 'closeout' }, says, detail });

/** A home with one closed session: a phantom file claim the rescan disproves (high), and a hand edit. */
function home(base, { verdictLog }) {
  const s = makeLog(path.join(base, 'sessions'), {}, { baseline: [{ path: 'config.ts', size: 4, fingerprint: 'sha256:' + 'a'.repeat(64) }] });
  s.append(M.prompted(0));
  s.append(M.disk(100, 'src/hand.ts'));
  s.append({ ...M.claimed(900), detail: { text: 'I updated config.ts.' } });
  s.append(check(901, 'passed'));
  s.append(M.turnEnded(902));
  s.append(M.sessionEnded(1000));
  s.append(sweep(4100, 'started', {}));
  s.append(sweep(4200, 'exited', { exit_status: 'pass' }));
  const r = replayFolder(s.dir);
  fs.writeFileSync(path.join(s.dir, 'odu.jsonl'), r.odu);
  if (verdictLog) fs.writeFileSync(path.join(s.dir, 'verdict.jsonl'), r.verdict);
  return { ORUNMILA_HOME: base };
}
const json = (env, extra = []) => {
  const r = run('bin/orunmila.js', { args: ['json', '--session', 'ses_replay_test', ...extra], env });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout);
};

it("BB9: with the flag, orunmila json keeps the 1.0 shape the agent's loop reads, and adds each claim's verdict, the session verdict and the findings", () => {
  const base = tmpDir();
  try {
    const out = json({ ...home(base, { verdictLog: true }), ORUNMILA_FEEDBACK_FROM_VERDICTS: '1' });
    assert.deepStrictEqual([out.schema_version, out.source, out.session_id], ['1.0', 'verdict_log', 'ses_replay_test']);
    const claim = out.turns.find((t) => t.turn === 't1').claims[0];
    assert.deepStrictEqual([claim.outcome, claim.verdict, claim.verdict_confidence], ['phantom', 'violation', 'high']);
    assert.strictEqual(out.summary.phantom, 1, 'the summary the loop reads');
    assert.deepStrictEqual([out.session_verdict, out.top_line, out.judged_now], ['violation', '1 violation', false]);
    assert.ok(out.verdicts.some((f) => f.rule === 'R6' && /src\/hand\.ts changed/.test(f.sentence)), JSON.stringify(out.verdicts));
    assert.ok(out.verdicts.every((f) => typeof f.sentence === 'string' && f.verdict), 'every finding in words, with its verdict');
  } finally {
    rmrf(base);
  }
});

it('BB9: with no verdict log the odù log is judged for this answer only, and it says so', () => {
  const base = tmpDir();
  try {
    const out = json({ ...home(base, { verdictLog: false }), ORUNMILA_FEEDBACK_FROM_VERDICTS: '1' });
    assert.deepStrictEqual([out.source, out.judged_now, out.session_verdict], ['verdict_log', true, 'violation']);
  } finally {
    rmrf(base);
  }
});

it('BB9: without the flag the old path answers, unchanged (Ship item 5)', () => {
  const base = tmpDir();
  try {
    const out = json(home(base, { verdictLog: true }));
    assert.notStrictEqual(out.source, 'verdict_log');
    assert.strictEqual(out.verdicts, undefined);
  } finally {
    rmrf(base);
  }
});

runAll('feedback-verdicts');
