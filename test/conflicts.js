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
const { makeLog, M, ns, wall } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');
const { compile } = require('../src/verify/schema');

const checkOdu = compile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'odu.schema.json'), 'utf8')));

function replay(build) {
  const base = tmpDir();
  try {
    const log = makeLog(base);
    build(log.append);
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

it('C3c: the schema asks a phantom_claim for its claim kind, phrases, hedged, why and runs; its why is no_command, failed or unknown', () => {
  const odus = replay((append) => {
    append(claimed(0, 't1', 'All tests pass.'));
    append(M.turnEnded(0));
    append(M.tick(20000));
  });
  const [o] = claimOdus(odus, 't1');
  const keys = (r) => checkOdu(r).map((e) => `${e.path} ${e.keyword}`);
  assert.deepStrictEqual(keys(o), []);
  const c = o.conflicts[0];
  for (const k of ['claim', 'phrases', 'hedged', 'why', 'runs']) {
    const { [k]: _gone, ...less } = c;
    assert.ok(keys({ ...o, conflicts: [less] }).length > 0, `a phantom_claim with no ${k}`);
  }
  assert.ok(keys({ ...o, conflicts: [{ ...c, why: 'gap' }] }).length > 0, 'gap is outcome_missing\'s, not a phantom claim\'s');
  assert.ok(keys({ ...o, conflicts: [missing('e1', 'failed')] }).length > 0, 'failed is a phantom claim\'s, not outcome_missing\'s');
});

it('C3a: the odù schema requires conflicts, and each conflict its kind, sources and what each said', () => {
  const [o] = replay((append) => {
    append(M.edited(0, 'e1', 'src/a.ts'));
    append(M.tick(9000));
  });
  const keys = (r) => checkOdu(r).map((e) => `${e.path} ${e.keyword}`);
  const { conflicts: _c, ...none } = o;
  assert.ok(keys(none).includes('/conflicts required'));
  assert.ok(keys({ ...o, conflicts: [{ kind: 'unconfirmed_by_filesystem' }] }).length > 0, 'a conflict that names no sources');
  assert.ok(keys({ ...o, conflicts: [{ kind: 'unconfirmed_by_filesystem', sources: ['hook'] }] }).length > 0, 'a conflict that says nothing of what they said');
});

runAll('conflicts');
