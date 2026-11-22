'use strict';

/**
 * test/conflicts.js — station 6's conflicts, in the event-time engine (Phase 3
 * slice C3a, LD188; brief v4 lines 314, 328, 411, 429-441; tests 44 and 69, the
 * conflict half). Every conflict names the sources and what each said; the
 * list is on every odù, empty when there is none. Glove and Sentinel joined on
 * every odù asserted (LD182). Hand-built logs, labelled so (brief line 761):
 * made-up paths. Quiet window 1,500 ms, lag grace 3,000 ms.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { makeLog, M, ns, wall, FP } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');
const { compile } = require('../src/verify/schema');

const checkOdu = compile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'odu.schema.json'), 'utf8')));

function replay(build) {
  const base = tmpDir();
  try {
    const log = makeLog(base);
    build(log.append, log);
    const r = replayFolder(log.dir);
    assert.strictEqual(r.ok, true, r.words);
    const odus = r.odu.split('\n').slice(1, -1).map((l) => JSON.parse(l));
    for (const o of odus) assert.deepStrictEqual(checkOdu(o), [], JSON.stringify(o));
    return odus;
  } finally {
    rmrf(base);
  }
}
const of = (odus, pred) => {
  const hit = odus.filter(pred);
  assert.strictEqual(hit.length, 1, JSON.stringify(odus.map((o) => [o.action, o.target])));
  return hit[0];
};
const file = (p) => (o) => o.target && o.target.kind === 'file' && o.target.path === p;
const witnesses = (o) => [o.witness_status.glove.status, o.witness_status.sentinel.status];

it('C3a test 44: an agent edit the hook reported inside the root, which the Sentinel never saw while it had no gap, has an unconfirmed_by_filesystem conflict naming both sources and what each said; confidence follows the cause', () => {
  const odus = replay((append) => {
    append(M.started(0, 'e1', { kind: 'file', path: 'src/unseen.ts' }));
    append(M.edited(100, 'e1', 'src/unseen.ts'));
    append(M.turnEnded(100)); // C3d2: the agent's change waits for its turn's end
    append(M.tick(9000));
  });
  const o = of(odus, file('src/unseen.ts'));
  assert.deepStrictEqual(witnesses(o), ['saw', 'saw_nothing']);
  assert.deepStrictEqual(o.conflicts, [{ kind: 'unconfirmed_by_filesystem', sources: ['hook', 'sentinel'], said: { hook: ['started', 'modified'], sentinel: [] } }]);
  assert.strictEqual(o.confidence, 'high', 'line 411: confidence follows the cause');
});

it('C3a test 69 and line 411: a Glove write outside the root, or while the Sentinel was down, has no conflict: the Sentinel\'s status already says why it has nothing', () => {
  const odus = replay((append) => {
    append({ ...M.edited(0, 'e1', '/elsewhere/x.ts'), target: { kind: 'file', path: '/elsewhere/x.ts', outside: true } });
    append({ ...M.gap(3000, 'watch dropped'), detail: { lost: 'watch dropped', root: '/r', until: { observed_at: wall(3500), mono_ns: ns(3500) } } });
    append(M.edited(3100, 'e2', 'src/down.ts'));
    append(M.turnEnded(3100));
    append(M.tick(12000));
  });
  const out = of(odus, file('/elsewhere/x.ts'));
  assert.deepStrictEqual([...witnesses(out), out.witness_status.sentinel.scope, out.conflicts], ['saw', 'out_of_scope', 'outside_root', []]);
  const down = of(odus, file('src/down.ts'));
  assert.deepStrictEqual([...witnesses(down), down.conflicts], ['saw', 'down', []]);
});

it('C3a: the same change seen by both witnesses, a human edit, and marks that change nothing carry an empty conflicts list, never none', () => {
  const odus = replay((append) => {
    append(M.edited(0, 'e1', 'src/both.ts'));
    append(M.disk(50, 'src/both.ts'));
    append(M.disk(100, 'src/hand.ts'));
    append(M.read(200, 'r1', 'src/a.ts'));
    append(M.turnEnded(200));
    append(M.tick(9000));
  });
  for (const [p, w] of [['src/both.ts', ['saw', 'saw']], ['src/hand.ts', ['saw_nothing', 'saw']], ['src/a.ts', ['saw', 'out_of_scope']]]) {
    const o = of(odus, file(p));
    assert.deepStrictEqual([witnesses(o), o.conflicts], [w, []], p);
  }
});

it('C3a2 (line 438): a late Glove edit amending an odù of its own call whose Sentinel saw the change is not unconfirmed_by_filesystem; one amending an odù no witness saw change still is', () => {
  const odus = replay((append) => {
    append(M.started(0, 'e1', { kind: 'file', path: 'src/seen.ts' }));
    append(M.disk(100, 'src/seen.ts'));
    append(M.started(0, 'e2', { kind: 'file', path: 'src/unseen.ts' }));
    append(M.disk(200, 'src/other.ts')); // a hand edit only the Sentinel saw: settled at 1,700, sealed at 4,700
    append(M.turnEnded(200));
    append(M.tick(5000));
    append(M.edited(5100, 'e1', 'src/seen.ts')); // the outcomes, after both odùs sealed: each amends its own
    append(M.edited(5200, 'e2', 'src/unseen.ts'));
    append(M.edited(4400, 'e9', 'src/other.ts')); // seen before that odù sealed (4,700), arriving after: amends it, but is not its call
    append(M.tick(20000));
  });
  const other = of(odus, (o) => file('src/other.ts')(o) && o.amends !== null);
  assert.deepStrictEqual(other.conflicts.map((c) => c.kind), ['unconfirmed_by_filesystem'], 'the Sentinel saw a change there, but not this call\'s');
  const amending = (p) => of(odus, (o) => file(p)(o) && o.amends !== null);
  const seen = amending('src/seen.ts');
  assert.deepStrictEqual([witnesses(seen), seen.conflicts], [['saw', 'saw_nothing'], []], 'the Sentinel saw it, in the odù this one amends');
  const unseen = amending('src/unseen.ts');
  assert.deepStrictEqual([witnesses(unseen), unseen.conflicts.map((c) => c.kind)], [['saw', 'saw_nothing'], ['unconfirmed_by_filesystem']]);
});

const DOWN = (fromMs, toMs) => ({ ...M.gap(toMs, 'every mark sent to intake while it was not running'), detail: { lost: 'every mark sent to intake while it was not running', since: { mono_ns: ns(fromMs), observed_at: wall(fromMs) }, until: { mono_ns: ns(toMs), observed_at: wall(toMs) }, sessions: ['ses_replay_test'] } });
const missing = (ref, why, said = { hook: ['started'] }) => ({ kind: 'outcome_missing', sources: Object.keys(said).sort(), said, ref, why });

it('C3b test 71: a tool call whose after-hook is lost, one interrupted (the payload says so) and one denied (no payload says why): each odù has outcome_missing, judged at the end of its turn; "interrupted" only where the payload says so, no "gap" with no gap recorded', () => {
  const odus = replay((append) => {
    append(M.prompted(0));
    append(M.started(100, 'e1', { kind: 'file', path: 'src/lost.ts' }));
    append(M.started(200, 'c1', { kind: 'command', text: 'npm test' }, 'Bash'));
    append({ ...M.exited(900, 'c1', 'npm test', 'unknown'), detail: { tool: 'Bash', exit_status: 'unknown', output_excerpt: '', interrupted: true } });
    append(M.started(1000, 'c2', { kind: 'command', text: 'rm -rf build' }, 'Bash'));
    append(M.claimed(20000));
    append(M.turnEnded(20000));
    append(M.tick(40000));
  });
  const lost = of(odus, file('src/lost.ts'));
  assert.deepStrictEqual([witnesses(lost), lost.conflicts], [['saw', 'out_of_scope'], [missing('e1', null)]], 'no change on disk recorded: not a disk event');
  const cmd = (text) => of(odus, (o) => o.target && o.target.kind === 'command' && o.target.text === text);
  const interrupted = cmd('npm test');
  assert.deepStrictEqual([witnesses(interrupted), interrupted.conflicts], [['saw', 'out_of_scope'], [missing('c1', 'interrupted', { hook: ['started', 'exited'] })]]);
  const denied = cmd('rm -rf build');
  assert.deepStrictEqual([witnesses(denied), denied.conflicts], [['saw', 'out_of_scope'], [missing('c2', null)]], 'held by rule 3 until its turn ended, then judged');
});

it('C3b: no verdict before the end of its turn: a call with only `started` keeps its odù open while its turn runs, however long it is quiet', () => {
  const odus = replay((append) => {
    append(M.started(0, 'e1', { kind: 'file', path: 'src/waiting.ts' }));
    append(M.tick(60000));
  });
  assert.strictEqual(odus.filter(file('src/waiting.ts')).length, 0, 'not sealed with a verdict its turn has not reached');
});

it('C3b, the late report: an outcome that arrives long after the call started (a permission prompt) joins the call\'s own odù, with the Sentinel\'s sighting: one odù, a direct cause, no conflict', () => {
  const odus = replay((append) => {
    append(M.started(0, 'e1', { kind: 'file', path: 'src/slow.ts' }));
    append(M.edited(45000, 'e1', 'src/slow.ts'));
    append(M.disk(45050, 'src/slow.ts'));
    append(M.turnEnded(46000));
    append(M.tick(90000));
  });
  const o = of(odus, file('src/slow.ts'));
  assert.deepStrictEqual([witnesses(o), o.witness_status.glove.says, o.attribution, o.cause, o.confidence, o.conflicts, o.ceiling], [['saw', 'saw'], ['started', 'modified'], 'explained', { kind: 'agent_tool_call', ref: 'e1' }, 'high', [], false]);
});

it('C3b: "gap" only when a capture gap covers the call: the intake down after the call started ends its wait, and the record says gap', () => {
  const odus = replay((append) => {
    append(M.started(0, 'e2', { kind: 'file', path: 'src/gapped.ts' }));
    append(DOWN(1000, 8000));
    append(M.tick(40000));
  });
  const o = of(odus, file('src/gapped.ts'));
  assert.deepStrictEqual([witnesses(o), o.conflicts], [['saw', 'out_of_scope'], [missing('e2', 'gap')]]);
});

it('C3b: the session\'s end also ends a call\'s wait when its turn never ended (the Stop hook lost)', () => {
  const odus = replay((append) => {
    append(M.started(0, 'e3', { kind: 'file', path: 'src/cut.ts' }));
    append(M.sessionEnded(5000));
    append(M.tick(30000));
  });
  const o = of(odus, file('src/cut.ts'));
  assert.deepStrictEqual([witnesses(o), o.conflicts], [['saw', 'out_of_scope'], [missing('e3', null)]]);
});

it('C3b: a call with its outcome has no outcome_missing, and the schema names the conflict\'s call and why', () => {
  const odus = replay((append) => {
    append(M.started(0, 'e1', { kind: 'file', path: 'src/done.ts' }));
    append(M.edited(100, 'e1', 'src/done.ts'));
    append(M.disk(150, 'src/done.ts'));
    append(M.turnEnded(1000));
    append(M.tick(20000));
  });
  const o = of(odus, file('src/done.ts'));
  assert.deepStrictEqual([witnesses(o), o.conflicts], [['saw', 'saw'], []]);
  const keys = (r) => checkOdu(r).map((e) => `${e.path} ${e.keyword}`);
  assert.ok(keys({ ...o, conflicts: [{ ...missing('e1', 'guessed') }] }).length > 0, 'why is interrupted, denied, gap or null');
  assert.ok(keys({ ...o, conflicts: [{ kind: 'outcome_missing', sources: ['hook'], said: { hook: ['started'] }, why: null }] }).length > 0, 'an outcome_missing names its call');
});

// C3c (LD191; lines 431, 433, 441; tests 4b, 39): a command claim with no run behind it is its own odù.
const claimed = (ms, turn, text) => ({ ...M.claimed(ms, turn), detail: { text } });
const ran = (ms, call, text, status, turn, extra = {}) => [M.started(ms, call, { kind: 'command', text }, 'Bash', turn), { ...M.exited(ms + 100, call, text, status, turn), detail: { tool: 'Bash', exit_status: status, output_excerpt: '', ...extra } }];
const claimOdus = (odus, turn) => odus.filter((o) => o.target && o.target.kind === 'claim' && o.target.turn === turn);
const phantom = (why, runs, said, phrases = ['tests pass']) => ({ kind: 'phantom_claim', sources: Object.keys(said).sort(), said, claim: 'command', phrases, hedged: false, why, runs });
/** A backed claim has no odù of its own: assert its turn's odù sealed with it, so "none" is not a turn that never sealed. */
const backed = (odus, turn, seq) => {
  assert.strictEqual(claimOdus(odus, turn).length, 0, `${turn}: backed`);
  assert.ok(odus.some((o) => !(o.target && o.target.turn) && o.mark_seqs.includes(seq)), `${turn}: its claim's group sealed`);
};

it('C3c test 4b: "tests pass" with no test run in its turn, the Glove healthy: one phantom-claim odù of its own, citing the absence, confidence high; the turn\'s own odù and the command\'s are unchanged', () => {
  const odus = replay((append) => {
    append(M.prompted(0));
    for (const m of ran(100, 'c1', 'ls src', 'pass', 't1')) append(m); // a command, but no test run
    append(claimed(2000, 't1', 'All tests pass.'));
    append(M.turnEnded(2000));
    append(M.tick(20000));
  });
  const [o] = claimOdus(odus, 't1');
  assert.strictEqual(claimOdus(odus, 't1').length, 1);
  assert.deepStrictEqual(
    [o.target, o.action, witnesses(o), o.witness_status.sentinel.scope, o.witness_status.glove.says, o.mark_seqs, o.attribution, o.cause, o.confidence, o.conflicts],
    [{ kind: 'claim', turn: 't1', text: 'All tests pass.' }, 'claimed', ['saw', 'out_of_scope'], 'not_a_disk_event', ['claimed'], [4], 'explained', { kind: 'turn', ref: 't1' }, 'high', [phantom('no_command', [], { agent_claim: ['claimed'] })]]
  );
  const turn = of(odus, (x) => x.target && x.target.kind === 'turn');
  assert.deepStrictEqual([witnesses(turn), turn.witness_status.glove.says, turn.conflicts], [['saw', 'out_of_scope'], ['prompted', 'claimed', 'ended'], []]);
  const cmd = of(odus, (x) => x.target && x.target.kind === 'command');
  assert.deepStrictEqual([witnesses(cmd), cmd.conflicts], [['saw', 'out_of_scope'], []]);
});

it('C3c test 4b: "tests pass" after the tests ran and failed cites the run and its exit code, confidence high; a failed run after a passing one undoes it; a passing run after a failed one backs the claim', () => {
  const s = {};
  const odus = replay((append) => {
    for (const m of ran(0, 'c1', 'npm test', 'fail', 't1', { exit_code: 1 })) append(m);
    append(claimed(1000, 't1', 'All tests pass.'));
    append(M.turnEnded(1000));
    for (const m of [...ran(10000, 'c2', 'npm test', 'pass', 't2'), ...ran(10500, 'c3', 'npm test', 'fail', 't2')]) append(m);
    append(claimed(11000, 't2', 'All tests pass.'));
    append(M.turnEnded(11000, 't2'));
    for (const m of [...ran(20000, 'c4', 'npm test', 'fail', 't3'), ...ran(20500, 'c5', 'npm test', 'pass', 't3')]) append(m);
    s.t3 = append(claimed(21000, 't3', 'All tests pass.'));
    append(M.turnEnded(21000, 't3'));
    append(M.tick(40000));
  });
  const [one] = claimOdus(odus, 't1');
  assert.deepStrictEqual([witnesses(one), one.mark_seqs, one.confidence, one.conflicts], [['saw', 'out_of_scope'], [1, 2, 3], 'high', [phantom('failed', [{ ref: 'c1', text: 'npm test', status: 'fail', exit_code: 1 }], { agent_claim: ['claimed'], hook: ['started', 'exited'] })]]);
  const [two] = claimOdus(odus, 't2');
  assert.deepStrictEqual([witnesses(two), two.confidence, two.conflicts.map((c) => [c.why, c.runs])], [['saw', 'out_of_scope'], 'high', [['failed', [{ ref: 'c2', text: 'npm test', status: 'pass' }, { ref: 'c3', text: 'npm test', status: 'fail' }]]]], 'a failure with no stated code has no exit_code');
  backed(odus, 't3', s.t3); // the last run that settled passed
});

it('C3c test 39: "tests pass" backed only by `npm test | tail` without pipefail is not proven: status unknown, confidence low, and the gate from marks takes it as no receipt; with pipefail set first it backs the claim', () => {
  const piped = ran(0, 'c1', 'npm test | tail -5', 'pass', 't1');
  const s = {};
  const odus = replay((append) => {
    for (const m of piped) append(m);
    append(claimed(1000, 't1', 'All tests pass.'));
    append(M.turnEnded(1000));
    for (const m of ran(10000, 'c2', 'set -o pipefail; npm test | tail -5', 'pass', 't2')) append(m);
    s.t2 = append(claimed(11000, 't2', 'All tests pass.'));
    append(M.turnEnded(11000, 't2'));
    append(M.tick(30000));
  });
  const [o] = claimOdus(odus, 't1');
  assert.deepStrictEqual([witnesses(o), o.confidence, o.conflicts], [['saw', 'out_of_scope'], 'low', [phantom('unknown', [{ ref: 'c1', text: 'npm test | tail -5', status: 'unknown', piped: true }], { agent_claim: ['claimed'], hook: ['started', 'exited'] })]]);
  backed(odus, 't2', s.t2);
  const { buildReceiptsFromMarks } = require('../src/opon/gate/receipts');
  const r = buildReceiptsFromMarks(piped);
  assert.deepStrictEqual([r.passingCommands.length, r.unreliableCommands.map((c) => c.command)], [0, ['npm test | tail -5']], 'line 433: the law gate treats it as no receipt');
});

it('C3c: a command claim not about tests is matched by any command of its turn; with no command at all it is phantom; a Glove gap before the claim lowers a phantom to low', () => {
  const s = {};
  const odus = replay((append) => {
    for (const m of ran(0, 'c1', 'npm run build', 'pass', 't1')) append(m);
    s.t1 = append(claimed(1000, 't1', 'The build succeeds.'));
    append(M.turnEnded(1000));
    append(claimed(10000, 't2', 'The build succeeds.'));
    append(M.turnEnded(10000, 't2'));
    append(M.gap(20000, 'hook payloads dropped'));
    append(claimed(21000, 't3', 'All tests pass.'));
    append(M.turnEnded(21000, 't3'));
    append(M.tick(40000));
  });
  backed(odus, 't1', s.t1);
  const [two] = claimOdus(odus, 't2');
  assert.deepStrictEqual([witnesses(two), two.confidence, two.conflicts], [['saw', 'out_of_scope'], 'high', [phantom('no_command', [], { agent_claim: ['claimed'] }, ['build succeeds'])]]);
  const [three] = claimOdus(odus, 't3');
  assert.deepStrictEqual([witnesses(three), three.confidence, three.conflicts.map((c) => c.why)], [['saw', 'out_of_scope'], 'low', ['no_command']], 'line 441: high only when the Glove was healthy for the whole session');
});

it('C3c line 352: a turn of the agent\'s that never ended, or a change to its hook settings, leaves the Glove not shown healthy: a phantom claim after it is low', () => {
  const unended = replay((append) => {
    append(M.prompted(0, 't1')); // its Stop never came
    append(claimed(40000, 't2', 'All tests pass.'));
    append(M.turnEnded(40000, 't2'));
    append(M.tick(60000));
  });
  const [a] = claimOdus(unended, 't2');
  assert.deepStrictEqual([witnesses(a), a.confidence, a.conflicts.map((c) => c.why)], [['saw', 'out_of_scope'], 'low', ['no_command']]);
  const changed = replay((append) => {
    append({ ...M.gap(0), says: 'tampered', target: { kind: 'process', name: 'intake' }, detail: { what: 'hook_settings' } });
    append(claimed(1000, 't1', 'All tests pass.'));
    append(M.turnEnded(1000));
    append(M.tick(20000));
  });
  const [b] = claimOdus(changed, 't1');
  assert.deepStrictEqual([witnesses(b), b.confidence], [['saw', 'out_of_scope'], 'low']);
});

it('C3c2: the next turn starting before a turn\'s group seals (a quick prompt, a continuation) does not lower that turn\'s phantom claim: only turns begun by its end count', () => {
  const odus = replay((append) => {
    append(claimed(1000, 't1', 'All tests pass.'));
    append(M.turnEnded(1000));
    append(M.prompted(2000, 't2')); // t1's group seals at 5,500 ms, t2 is still running then
    append(M.tick(9000));
  });
  const [o] = claimOdus(odus, 't1');
  assert.deepStrictEqual([witnesses(o), o.confidence, o.conflicts.map((c) => c.why)], [['saw', 'out_of_scope'], 'high', ['no_command']]);
});

it('C3c: the schema asks a phantom_claim for its claim kind, phrases, hedged, why and runs; its why is no_command, failed or unknown', () => {
  const odus = replay((append) => {
    append(claimed(0, 't1', 'All tests pass.'));
    append(M.turnEnded(0));
    append(M.tick(20000));
  });
  const [o] = claimOdus(odus, 't1');
  const keys = (r) => checkOdu(r).map((e) => `${e.path} ${e.keyword}`);
  assert.deepStrictEqual([witnesses(o), keys(o)], [['saw', 'out_of_scope'], []]);
  const c = o.conflicts[0];
  for (const k of ['claim', 'phrases', 'hedged', 'why', 'runs']) {
    const { [k]: _gone, ...less } = c;
    assert.ok(keys({ ...o, conflicts: [less] }).length > 0, `a phantom_claim with no ${k}`);
  }
  assert.ok(keys({ ...o, conflicts: [{ ...c, why: 'gap' }] }).length > 0, 'gap is outcome_missing\'s, not a phantom claim\'s');
  assert.ok(keys({ ...o, conflicts: [missing('e1', 'failed')] }).length > 0, 'failed is a phantom claim\'s, not outcome_missing\'s');
});

// C3d1 (LD192; lines 406, 432, 441; test 4's replay half): a file claim with no change of this session behind it.
const filePhantom = (path, why, targets, said) => ({ kind: 'phantom_claim', sources: Object.keys(said).sort(), said, claim: 'file', path, hedged: false, why, targets });

it('C3d1 test 4 (replay half): "I updated src/config.ts" with no event on it is a phantom file claim, its own odù; low until git or the closeout rescan can see the target (Phase 4), as line 441 says the Sentinel\'s silence alone never makes it high', () => {
  const odus = replay((append) => {
    append(M.prompted(0));
    append(claimed(1000, 't1', 'I updated src/config.ts.'));
    append(M.turnEnded(1000));
    append(M.tick(20000));
  });
  const [o] = claimOdus(odus, 't1');
  assert.strictEqual(claimOdus(odus, 't1').length, 1);
  assert.deepStrictEqual(
    [o.target, o.action, witnesses(o), o.witness_status.sentinel.scope, o.mark_seqs, o.cause, o.confidence, o.conflicts],
    [{ kind: 'claim', turn: 't1', text: 'I updated src/config.ts.' }, 'claimed', ['saw', 'out_of_scope'], 'not_a_disk_event', [2], { kind: 'turn', ref: 't1' }, 'low', [filePhantom('src/config.ts', 'no_event', [], { agent_claim: ['claimed'] })]]
  );
});

it('C3d1: a change this session\'s turn made backs the claim, written as the repo path, a bare name, ./path or an absolute path under the root; a change still settling at the claim backs it too', () => {
  const s = {};
  const odus = replay((append, log) => {
    append(M.edited(0, 'e1', 'src/config.ts'));
    append(M.disk(50, 'src/config.ts'));
    s.t1 = append(claimed(1000, 't1', `I updated src/config.ts. I updated config.ts. I updated ./src/config.ts. I updated ${log.root}/src/config.ts.`));
    append(M.turnEnded(1000));
    s.t2 = append(claimed(10000, 't2', 'I updated src/late.ts.'));
    append(M.edited(10000, 'e2', 'src/late.ts', 'modified', 't2'));
    append(M.turnEnded(10000, 't2')); // the turn's group opened first, and both seal at one moment: the edit's is still unsealed when the claim is judged
    append(M.tick(30000));
  });
  backed(odus, 't1', s.t1);
  backed(odus, 't2', s.t2);
  const edit = of(odus, file('src/config.ts'));
  assert.deepStrictEqual([witnesses(edit), edit.conflicts], [['saw', 'saw'], []], 'the change\'s own odù is unchanged');
});

it('C3d1 line 432: a file claim whose only change of this turn has a net change of false is phantom, unchanged, citing it; a change only the Sentinel saw is not this session\'s and gives not_credited, medium; an earlier turn\'s change does not back this turn\'s claim', () => {
  const odus = replay((append) => {
    append(M.edited(0, 'e1', 'src/a.ts'));
    append(M.fingerprinted(1600, 'src/a.ts', FP('b')));
    append(M.turnEnded(2000));
    append(M.prompted(10000, 't2'));
    append(M.edited(10100, 'e2', 'src/a.ts', 'modified', 't2'));
    append(M.fingerprinted(11700, 'src/a.ts', FP('b'))); // back to what the last odù left: changed false
    append(M.disk(12000, 'src/hand.ts'));
    append(claimed(20000, 't2', 'I updated src/a.ts. I updated src/hand.ts.'));
    append(M.turnEnded(20000, 't2'));
    append(claimed(30000, 't3', 'I updated src/a.ts.'));
    append(M.turnEnded(30000, 't3'));
    append(M.tick(50000));
  });
  const [a, hand] = claimOdus(odus, 't2');
  assert.deepStrictEqual([a.target.text, witnesses(a), a.confidence, a.conflicts], ['I updated src/a.ts.', ['saw', 'out_of_scope'], 'low', [filePhantom('src/a.ts', 'unchanged', ['src/a.ts'], { agent_claim: ['claimed'], hook: ['modified'], process: ['fingerprinted'] })]]);
  assert.deepStrictEqual([hand.target.text, witnesses(hand), hand.confidence, hand.conflicts], ['I updated src/hand.ts.', ['saw', 'saw'], 'medium', [filePhantom('src/hand.ts', 'not_credited', ['src/hand.ts'], { agent_claim: ['claimed'], sentinel: ['modified'] })]]);
  const [three] = claimOdus(odus, 't3');
  assert.deepStrictEqual([witnesses(three), three.confidence, three.conflicts.map((c) => c.why)], [['saw', 'out_of_scope'], 'low', ['no_event']]);
});

it('C3d1: the schema asks a file phantom_claim for its path and targets, and its why is no_event, unchanged or not_credited', () => {
  const odus = replay((append) => {
    append(claimed(0, 't1', 'I updated src/config.ts.'));
    append(M.turnEnded(0));
    append(M.tick(20000));
  });
  const [o] = claimOdus(odus, 't1');
  const keys = (r) => checkOdu(r).map((e) => `${e.path} ${e.keyword}`);
  assert.deepStrictEqual([witnesses(o), keys(o)], [['saw', 'out_of_scope'], []]);
  const c = o.conflicts[0];
  for (const k of ['path', 'targets']) {
    const { [k]: _gone, ...less } = c;
    assert.ok(keys({ ...o, conflicts: [less] }).length > 0, `a file phantom_claim with no ${k}`);
  }
  assert.ok(keys({ ...o, conflicts: [{ ...c, why: 'no_command' }] }).length > 0, 'no_command is a command claim\'s');
});

// C3d2 (LD194; lines 324, 434; test 5): an agent-caused change its turn's claims never mention.
const silent = (said, turns, claimSeqs) => ({ kind: 'silent_change', sources: Object.keys(said).sort(), said, turns, claim_seqs: claimSeqs });
const filesIn = (odus) => odus.filter((o) => o.target && o.target.kind === 'file');

it('C3d2 test 5: an agent edit its turn\'s claims never mention is 1 odù, explained, with a silent_change conflict naming both witnesses and the claim that said nothing of it; it seals at its turn\'s end, not 4.5 s after quiet', () => {
  const s = {};
  const odus = replay((append) => {
    append(M.prompted(0));
    append(M.started(100, 'e1', { kind: 'file', path: 'src/quiet.ts' }));
    append(M.edited(200, 'e1', 'src/quiet.ts'));
    append(M.disk(250, 'src/quiet.ts'));
    append(M.disk(1000, 'src/hand.ts')); // a person's edit: sealed at 5,500; the agent's would have sealed at 4,750
    s.claim = append(claimed(20000, 't1', 'All done.'));
    append(M.turnEnded(20000));
    append(M.tick(40000));
  });
  const files = filesIn(odus);
  assert.deepStrictEqual(files.map((o) => o.target.path), ['src/hand.ts', 'src/quiet.ts'], 'the agent edit waits for its turn\'s end');
  const [hand, o] = files;
  assert.deepStrictEqual(
    [witnesses(o), o.witness_status.glove.says, o.attribution, o.cause, o.confidence, o.conflicts],
    [['saw', 'saw'], ['started', 'modified'], 'explained', { kind: 'agent_tool_call', ref: 'e1' }, 'high', [silent({ agent_claim: [], hook: ['started', 'modified'], sentinel: ['modified'] }, ['t1'], [s.claim])]]
  );
  assert.deepStrictEqual([witnesses(hand), hand.attribution, hand.conflicts], [['saw_nothing', 'saw'], 'unexplained', []], 'a change with no agent cause is never silent');
});

it('C3d2: a change its turn\'s claims mention is not silent: the repo path, a bare name, ./path, an absolute path under the root, or a path in a claim with no action verb', () => {
  const odus = replay((append, log) => {
    const texts = ['I updated src/a.ts.', 'I updated b.ts.', 'I updated ./src/c.ts.', `I updated ${log.root}/src/d.ts.`, 'All tests pass in src/e.ts.'];
    for (const [i, f] of ['src/a.ts', 'src/deep/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'].entries()) {
      const t = `t${i + 1}`;
      append(M.edited(i * 10000, `e${i + 1}`, f, 'modified', t));
      append(M.disk(i * 10000 + 50, f));
      append(claimed(i * 10000 + 1000, t, texts[i]));
      append(M.turnEnded(i * 10000 + 1000, t));
    }
    append(M.tick(80000));
  });
  const files = filesIn(odus);
  assert.strictEqual(files.length, 5);
  for (const o of files) assert.deepStrictEqual([o.target.path, witnesses(o), o.attribution, o.conflicts], [o.target.path, ['saw', 'saw'], 'explained', []]);
});

it('C3d2: no verdict without a claim to read: a claim that could not be confirmed (N10), a turn with no claim, a turn cut by the session\'s end or the intake\'s downtime; a turn still running keeps its change unsealed', () => {
  const unread = replay((append) => {
    append(M.edited(0, 'e1', 'src/f.ts'));
    append(M.disk(50, 'src/f.ts'));
    append({ ...M.claimed(1000, 't1'), detail: { text: '', claim_unconfirmed: true } });
    append(M.turnEnded(1000));
    append(M.edited(10000, 'e2', 'src/g.ts', 'modified', 't2'));
    append(M.disk(10050, 'src/g.ts'));
    append(M.turnEnded(11000, 't2'));
    append(M.edited(20000, 'e3', 'src/h.ts', 'modified', 't3'));
    append(M.disk(20050, 'src/h.ts'));
    append(M.sessionEnded(30000));
    append(M.tick(50000));
  });
  const files = filesIn(unread);
  assert.deepStrictEqual(files.map((o) => [o.target.path, witnesses(o), o.attribution, o.conflicts]), ['src/f.ts', 'src/g.ts', 'src/h.ts'].map((p) => [p, ['saw', 'saw'], 'explained', []]));
  const down = replay((append) => {
    append(M.edited(0, 'e1', 'src/i.ts'));
    append(M.disk(50, 'src/i.ts'));
    append(DOWN(10000, 20000));
    append(M.tick(40000));
  });
  assert.deepStrictEqual(filesIn(down).map((o) => [o.target.path, witnesses(o), o.conflicts]), [['src/i.ts', ['saw', 'saw'], []]]);
  const running = replay((append) => {
    append(M.edited(0, 'e1', 'src/j.ts'));
    append(M.disk(50, 'src/j.ts'));
    append(M.tick(60000));
  });
  assert.strictEqual(filesIn(running).length, 0, 'not sealed before its turn is over');
});

it('C3d2: grouping is unchanged while a change waits: a second edit of the file later in its turn is its own odù, each judged; a change with a net change of false is never silent and does not wait', () => {
  const odus = replay((append) => {
    append(M.edited(0, 'e1', 'src/twice.ts'));
    append(M.disk(50, 'src/twice.ts'));
    append(M.edited(0, 'b1', 'src/back.ts'));
    append(M.fingerprinted(1600, 'src/back.ts', FP('b')));
    append(M.edited(10000, 'e2', 'src/twice.ts'));
    append(M.disk(10050, 'src/twice.ts'));
    append(M.turnEnded(11000));
    append(M.prompted(20000, 't2'));
    append(M.edited(20100, 'b2', 'src/back.ts', 'modified', 't2'));
    append(M.disk(20150, 'src/back.ts'));
    append(M.fingerprinted(21700, 'src/back.ts', FP('b'))); // back to what its last odù left: changed false
    append(M.disk(22000, 'src/hand.ts')); // sealed at 26,500, after the reverted edit's 25,200
    append(claimed(40000, 't2', 'All done.'));
    append(M.turnEnded(40000, 't2'));
    append(M.tick(60000));
  });
  const twice = filesIn(odus).filter(file('src/twice.ts'));
  assert.deepStrictEqual(twice.map((o) => [witnesses(o), o.cause.ref, o.conflicts]), [[['saw', 'saw'], 'e1', []], [['saw', 'saw'], 'e2', []]], 'two events, as before; t1 has no claim, so no verdict');
  const paths = filesIn(odus).map((o) => [o.target.path, o.net_change && o.net_change.changed]);
  const reverted = paths.findIndex(([p, c]) => p === 'src/back.ts' && c === false);
  assert.ok(reverted >= 0 && reverted < paths.findIndex(([p]) => p === 'src/hand.ts'), JSON.stringify(paths));
  const [first, back] = filesIn(odus).filter(file('src/back.ts'));
  assert.deepStrictEqual([witnesses(first), first.conflicts.map((c) => c.kind)], [['saw', 'saw_nothing'], ['unconfirmed_by_filesystem']], 't1 had no claim: no verdict');
  assert.deepStrictEqual([witnesses(back), back.conflicts], [['saw', 'saw'], []]);
  assert.deepStrictEqual(witnesses(of(odus, file('src/hand.ts'))), ['saw_nothing', 'saw']);
});

it('C3d2: an odù that amends a waiting one comes after it, as a late Sentinel mark\'s does; a command\'s children wait for its turn, each judged, while their parent, no change on disk, does not', () => {
  const odus = replay((append) => {
    append(M.edited(100, 'e1', 'src/late.ts'));
    append(M.disk(150, 'src/late.ts'));
    append(M.tick(5000));
    append(M.disk(4600, 'src/late.ts')); // seen before that odù closed (4,650), arriving after: amends it
    append(M.started(10000, 'c1', { kind: 'command', text: 'npm install' }, 'Bash'));
    append(M.disk(10100, 'node_modules/x/a.js', 'created'));
    append(M.disk(10120, 'node_modules/x/b.js', 'created'));
    append(M.exited(10500, 'c1', 'npm install'));
    append(claimed(30000, 't1', 'All done.'));
    append(M.turnEnded(30000));
    append(M.tick(50000));
  });
  const at = (pred) => odus.findIndex(pred);
  const first = of(odus, (o) => file('src/late.ts')(o) && o.amends === null);
  const amending = of(odus, (o) => file('src/late.ts')(o) && o.amends === first.odu_id);
  assert.ok(at((o) => o === first) < at((o) => o === amending));
  assert.deepStrictEqual([witnesses(first), first.conflicts.map((c) => c.kind), witnesses(amending), amending.attribution, amending.conflicts], [['saw', 'saw'], ['silent_change'], ['saw_nothing', 'saw'], 'unexplained', []]);
  const parent = of(odus, (o) => o.target && o.target.kind === 'command');
  const kids = odus.filter((o) => o.parent_id === parent.odu_id);
  assert.strictEqual(kids.length, 2);
  for (const k of kids) assert.deepStrictEqual([witnesses(k), k.cause, k.conflicts.map((c) => c.kind)], [['saw_nothing', 'saw'], { kind: 'agent_command', ref: 'c1' }, ['silent_change']]);
  assert.deepStrictEqual([witnesses(parent), parent.children, parent.conflicts], [['saw', 'out_of_scope'], kids.map((k) => k.odu_id), []]);
});

it('C3d2: the schema asks a silent_change for its turns and the claims it read', () => {
  const odus = replay((append) => {
    append(M.edited(0, 'e1', 'src/a.ts'));
    append(M.disk(50, 'src/a.ts'));
    append(claimed(1000, 't1', 'All done.'));
    append(M.turnEnded(1000));
    append(M.tick(20000));
  });
  const o = of(odus, file('src/a.ts'));
  const keys = (r) => checkOdu(r).map((e) => `${e.path} ${e.keyword}`);
  assert.deepStrictEqual([witnesses(o), keys(o)], [['saw', 'saw'], []]);
  const c = o.conflicts[0];
  assert.strictEqual(c.kind, 'silent_change');
  for (const k of ['turns', 'claim_seqs']) {
    const { [k]: _gone, ...less } = c;
    assert.ok(keys({ ...o, conflicts: [less] }).length > 0, `a silent_change with no ${k}`);
  }
});

it('C3a: the odù schema requires conflicts, and each conflict its kind, sources and what each said', () => {
  const o = of(
    replay((append) => {
      append(M.edited(0, 'e1', 'src/a.ts'));
      append(M.turnEnded(0));
      append(M.tick(9000));
    }),
    file('src/a.ts'),
  );
  const keys = (r) => checkOdu(r).map((e) => `${e.path} ${e.keyword}`);
  const { conflicts: _c, ...none } = o;
  assert.ok(keys(none).includes('/conflicts required'));
  assert.ok(keys({ ...o, conflicts: [{ kind: 'unconfirmed_by_filesystem' }] }).length > 0, 'a conflict that names no sources');
  assert.ok(keys({ ...o, conflicts: [{ kind: 'unconfirmed_by_filesystem', sources: ['hook'] }] }).length > 0, 'a conflict that says nothing of what they said');
});

runAll('conflicts');
