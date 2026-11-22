'use strict';

/**
 * test/confidence.js — station 6's confidence, in the event-time engine
 * (Phase 3 slice C1, LD185; brief v4 lines 419-427, 409, 411, 413; tests 44, 67
 * and 68, the confidence half: their conflicts are C3). Built and read through
 * replay. Glove and Sentinel joined on every odù asserted (LD182): confidence
 * is read from the cause and the marks behind the odù, never lowered because
 * one witness recorded nothing (line 427). Hand-built logs, labelled so (brief
 * line 761): made-up paths. Quiet window 1,500 ms, lag grace 3,000 ms.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { makeLog, M, SID, ns, wall } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');
const { compile } = require('../src/verify/schema');

const checkOdu = compile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'odu.schema.json'), 'utf8')));

function replay(build, { byproducts = null } = {}) {
  const base = tmpDir();
  try {
    const log = makeLog(base, {}, { byproducts });
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
/** Both witnesses' statuses, the label, the cause's kind and the confidence: the facts C1 reads and writes. */
const facts = (o) => [o.witness_status.glove.status, o.witness_status.sentinel.status, o.attribution, o.cause && o.cause.kind, o.confidence];

it('C1 test 44: an agent edit the hook reported and the Sentinel never saw: Glove saw, Sentinel saw nothing, high (a direct cause)', () => {
  const odus = replay((append) => {
    append(M.started(0, 'e1', { kind: 'file', path: 'src/unseen.ts' }));
    append(M.edited(100, 'e1', 'src/unseen.ts'));
    append(M.turnEnded(100)); // C3d2: the agent's change waits for its turn's end
    append(M.tick(9000));
  });
  assert.deepStrictEqual(facts(of(odus, file('src/unseen.ts'))), ['saw', 'saw_nothing', 'explained', 'agent_tool_call', 'high']);
});

it('C1 line 427: confidence is never lowered because one witness recorded nothing: a direct cause while the Sentinel was down stays high', () => {
  const odus = replay((append) => {
    // A Sentinel watch gap (G1: `root` names it the Sentinel's) covering the edit.
    append({ ...M.gap(0, 'watch dropped'), detail: { lost: 'watch dropped', root: '/r', until: { observed_at: wall(500), mono_ns: ns(500) } } });
    append(M.edited(100, 'e1', 'src/down.ts'));
    append(M.turnEnded(100));
    append(M.tick(9000));
  });
  assert.deepStrictEqual(facts(of(odus, file('src/down.ts'))), ['saw', 'down', 'explained', 'agent_tool_call', 'high']);
});

it('C1 test 67: a human edit, the Glove healthy and with nothing for it: Sentinel saw, Glove saw nothing, unexplained, high (the change is certain)', () => {
  const odus = replay((append) => {
    append(M.prompted(0));
    append(M.disk(2000, 'src/hand.ts'));
    append(M.claimed(3000));
    append(M.turnEnded(3100));
    append(M.tick(12000));
  });
  assert.deepStrictEqual(facts(of(odus, file('src/hand.ts'))), ['saw_nothing', 'saw', 'unexplained', null, 'high']);
});

it('C1 test 68: the same change seen by both witnesses: 1 odù, both saw, each with its own mark_seqs, high', () => {
  let glove;
  let sentinel;
  const odus = replay((append) => {
    glove = [append(M.started(0, 'e1', { kind: 'file', path: 'src/both.ts' })), append(M.edited(100, 'e1', 'src/both.ts'))];
    sentinel = [append(M.disk(150, 'src/both.ts'))];
    append(M.turnEnded(150));
    append(M.tick(9000));
  });
  const o = of(odus, file('src/both.ts'));
  assert.deepStrictEqual(facts(o), ['saw', 'saw', 'explained', 'agent_tool_call', 'high']);
  assert.deepStrictEqual([o.witness_status.glove.mark_seqs, o.witness_status.sentinel.mark_seqs], [glove, sentinel]);
});

it('C1 line 423: a byproduct the Sentinel saw is high; a time match and a running command are medium (line 409: never high)', () => {
  const odus = replay(
    (append) => {
      append(M.disk(0, 'dist/app.js', 'created'));
      append(M.started(100, 'e1', { kind: 'file', path: 'src/in.ts' }));
      append(M.disk(200, 'src/in.ts'));
      append(M.failed(300, 'e1', { kind: 'file', path: 'src/in.ts' }));
      append(M.turnEnded(300));
      append(M.tick(9000));
      append(M.started(10000, 'b1', { kind: 'command', text: 'npm run gen' }, 'Bash', 't2'));
      append(M.disk(10100, 'src/gen.ts', 'created'));
      append(M.exited(10200, 'b1', 'npm run gen', 'pass', 't2'));
      append(M.turnEnded(10200, 't2'));
      append(M.tick(20000));
    },
    { byproducts: { text: 'dist/\n', inHeader: true } },
  );
  assert.deepStrictEqual(facts(of(odus, file('dist/app.js'))), ['saw_nothing', 'saw', 'byproduct', 'byproduct', 'high']);
  assert.deepStrictEqual(facts(of(odus, file('src/in.ts'))), ['saw', 'saw', 'explained', 'time_match', 'medium']);
  assert.deepStrictEqual(facts(of(odus, file('src/gen.ts'))), ['saw_nothing', 'saw', 'explained', 'agent_command', 'medium']);
});

it('C1 line 413: marks that change nothing: a tool call explained by its outcome, a turn and the session\'s end are high; a call with only `started` is medium; a gap is high', () => {
  const odus = replay((append) => {
    append(M.prompted(0));
    append(M.read(100, 'r1', 'src/a.ts'));
    append(M.started(200, 'b1', { kind: 'command', text: 'npm test' }, 'Bash'));
    append(M.exited(300, 'b1', 'npm test'));
    append(M.called(400, 'm1', 'mcp__x__y'));
    append(M.started(500, 'n1', { kind: 'tool', name: 'Task' }, 'Task'));
    append(M.gap(600));
    append(M.claimed(700));
    append(M.turnEnded(800));
    append(M.sessionEnded(900));
    append(M.tick(12000));
  });
  const scope = (o) => o.witness_status.sentinel.scope;
  const read = of(odus, file('src/a.ts'));
  assert.deepStrictEqual([...facts(read), scope(read)], ['saw', 'out_of_scope', 'explained', 'agent_tool_call', 'high', 'not_a_disk_event']);
  assert.deepStrictEqual(facts(of(odus, (o) => o.target && o.target.kind === 'command')), ['saw', 'out_of_scope', 'explained', 'agent_tool_call', 'high']);
  assert.deepStrictEqual(facts(of(odus, (o) => o.target && o.target.name === 'mcp__x__y')), ['saw', 'out_of_scope', 'explained', 'agent_tool_call', 'high']);
  assert.deepStrictEqual(facts(of(odus, (o) => o.target && o.target.kind === 'turn')), ['saw', 'out_of_scope', 'explained', 'turn', 'high']);
  assert.deepStrictEqual(facts(of(odus, (o) => o.target && o.target.kind === 'session')), ['saw', 'out_of_scope', 'explained', 'session', 'high']);
  assert.deepStrictEqual(facts(of(odus, (o) => o.target && o.target.name === 'Task')), ['saw', 'out_of_scope', 'unexplained', null, 'medium'], 'a started mark with no outcome: medium at most (line 423)');
  assert.deepStrictEqual(facts(of(odus, (o) => o.action === 'gap')).slice(2), ['unexplained', null, 'high'], 'Orunmila\'s own record of a gap is certain (LD185 (4))');
});

it('C1 line 425: only a claim, with no witness observation, is low', () => {
  const odus = replay((append) => {
    append(M.claimed(0, 't9'));
    append(M.tick(40000));
  });
  const o = of(odus, (x) => x.target && x.target.kind === 'claim');
  assert.deepStrictEqual([o.witness_status.glove.says, o.witness_status.sentinel.status, o.confidence], [['claimed'], 'out_of_scope', 'low']);
});

it('C1 LD185 (5): a change on disk that only a Glove mark step 1 does not credit reports (a `renamed`), neither the Sentinel nor git seeing it, is medium', () => {
  const odus = replay((append) => {
    append({ ...M.edited(0, 'e1', 'src/moved.ts', 'renamed'), detail: { tool: 'Edit', exit_status: 'pass', from: 'src/old.ts' } });
    append(M.tick(9000));
  });
  assert.deepStrictEqual(facts(of(odus, file('src/moved.ts'))), ['saw', 'saw_nothing', 'unexplained', null, 'medium']);
});

it('C1: the odù schema requires confidence, high, medium or low', () => {
  const o = of(
    replay((append) => {
      append(M.edited(0, 'e1', 'src/a.ts'));
      append(M.turnEnded(0));
      append(M.tick(9000));
    }),
    file('src/a.ts'),
  );
  assert.strictEqual(o.session_id, SID);
  const keys = (r) => checkOdu(r).map((e) => `${e.path} ${e.keyword}`);
  const { confidence: _c, ...none } = o;
  assert.ok(keys(none).includes('/confidence required'));
  assert.ok(keys({ ...o, confidence: 'certain' }).length > 0, 'a value the brief does not name');
});

runAll('confidence');
