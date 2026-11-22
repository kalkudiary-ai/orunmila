'use strict';

/**
 * test/attribute.js — station 5, attribution, in the event-time engine (Phase 3
 * slice A1b, LD176; brief v4 lines 392-400, 413; tests 1, 5, 6, 9 and 67, the
 * attribution half; confidence is C1, conflicts C3, overlap A2). Built and read
 * through replay, as stations 2-4 were. Hand-built logs, labelled so (brief
 * line 761): made-up paths. Quiet window 1,500 ms, lag grace 3,000 ms.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { makeLog, M, SID } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');
const { compile } = require('../src/verify/schema');

const checkOdu = compile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'odu.schema.json'), 'utf8')));

/** Replay a hand-built log: `build(append)` writes the marks. Returns { odus, seqs }. */
function replay(build, { config = {}, byproducts = null } = {}) {
  const base = tmpDir();
  try {
    const log = makeLog(base, config, { byproducts });
    const seqs = build(log.append) || {};
    const r = replayFolder(log.dir);
    assert.strictEqual(r.ok, true, r.words);
    const odus = r.odu.split('\n').slice(1, -1).map((l) => JSON.parse(l));
    for (const o of odus) assert.deepStrictEqual(checkOdu(o), [], JSON.stringify(o));
    return { odus, seqs };
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
const blame = (o) => [o.attribution, o.cause];

it('A1 test 1: an agent edit, the editor saving through a temp file and a rename, a formatter 1 s later: 1 odù, modified, explained by its tool call (step 1), every mark listed', () => {
  const { odus, seqs } = replay((append) => {
    const s = [append(M.started(0, 'e1', { kind: 'file', path: 'src/a.ts' })), append(M.disk(50, 'src/a.ts.tmp', 'created')), append(M.disk(60, 'src/a.ts', 'renamed', { from: 'src/a.ts.tmp' })), append(M.edited(100, 'e1', 'src/a.ts')), append(M.disk(1100, 'src/a.ts'))];
    append(M.tick(9000));
    return { s };
  });
  const o = of(odus, file('src/a.ts'));
  assert.strictEqual(odus.filter(file('src/a.ts.tmp')).length, 0, 'the temp file is no event of its own');
  assert.strictEqual(o.action, 'modified');
  assert.deepStrictEqual(blame(o), ['explained', { kind: 'agent_tool_call', ref: 'e1' }]);
  assert.deepStrictEqual(o.mark_seqs, seqs.s);
});

it('A1 test 5 (attribution half): a change the agent made and never mentioned is explained by its tool call', () => {
  const { odus } = replay((append) => {
    append(M.prompted(0));
    append(M.edited(100, 'e1', 'src/quiet.ts'));
    append(M.disk(200, 'src/quiet.ts'));
    append(M.claimed(300));
    append(M.turnEnded(400));
    append(M.tick(9000));
  });
  assert.deepStrictEqual(blame(of(odus, file('src/quiet.ts'))), ['explained', { kind: 'agent_tool_call', ref: 'e1' }]);
});

it('A1 tests 6 and 67: a human edit mid-session, the Glove healthy and with nothing for it: unexplained, no cause; the Sentinel saw, the Glove saw nothing', () => {
  const { odus } = replay((append) => {
    append(M.prompted(0));
    append(M.read(100, 'r1', 'src/other.ts'));
    append(M.disk(2000, 'src/hand.ts'));
    // The agent read a file and a human changed it in the same window: a read never causes a change (line 423).
    append(M.read(2100, 'r2', 'src/seen.ts'));
    append(M.disk(2300, 'src/seen.ts'));
    append(M.claimed(3000));
    append(M.turnEnded(3100));
    append(M.tick(12000));
  });
  const o = of(odus, file('src/hand.ts'));
  assert.deepStrictEqual(blame(o), ['unexplained', null]);
  assert.strictEqual(o.witness_status.sentinel.status, 'saw');
  assert.strictEqual(o.witness_status.glove.status, 'saw_nothing');
  assert.deepStrictEqual(blame(of(odus, file('src/seen.ts'))), ['unexplained', null]);
});

it('A1 step 2, time match: a change inside the start and end of an agent tool call on that path is explained by it; outside it, or with no end recorded, it is not', () => {
  const { odus } = replay((append) => {
    // A failed edit (it ended, line 259) whose file still changed on disk while it ran.
    append(M.started(0, 'e1', { kind: 'file', path: 'src/in.ts' }));
    append(M.disk(100, 'src/in.ts'));
    append(M.failed(200, 'e1', { kind: 'file', path: 'src/in.ts' }));
    // The same, but the change was seen after the call ended.
    append(M.started(0, 'e2', { kind: 'file', path: 'src/late.ts' }));
    append(M.failed(100, 'e2', { kind: 'file', path: 'src/late.ts' }));
    append(M.disk(300, 'src/late.ts'));
    // A call with no outcome recorded: its end is unknown, so "inside" cannot be shown.
    append(M.started(0, 'e3', { kind: 'file', path: 'src/open.ts' }));
    append(M.disk(100, 'src/open.ts'));
    append(M.tick(12000));
  });
  assert.deepStrictEqual(blame(of(odus, file('src/in.ts'))), ['explained', { kind: 'time_match', ref: 'e1' }]);
  assert.deepStrictEqual(blame(of(odus, file('src/late.ts'))), ['unexplained', null]);
  assert.deepStrictEqual(blame(of(odus, file('src/open.ts'))), ['unexplained', null]);
});

it('A1c: an unexplained change beside agent activity says, from recorded facts, what was not credited and why; with nothing beside it, or once explained, the field is absent', () => {
  const cmd = (text) => ({ kind: 'command', text });
  const { odus } = replay((append) => {
    // A failed edit, the file changed 200 ms after the call ended (LD177's case).
    append(M.started(0, 'e2', { kind: 'file', path: 'src/late.ts' }));
    append(M.failed(100, 'e2', { kind: 'file', path: 'src/late.ts' }));
    append(M.disk(300, 'src/late.ts'));
    // A read, the file changed 200 ms after it.
    append(M.read(2100, 'r2', 'src/seen.ts'));
    append(M.disk(2300, 'src/seen.ts'));
    // A call with no outcome recorded.
    append(M.started(0, 'e3', { kind: 'file', path: 'src/open.ts' }));
    append(M.disk(100, 'src/open.ts'));
    // Seen before the call started; seen before a read with no start recorded; seen during and after a failed call.
    append(M.disk(0, 'src/early.ts'));
    append(M.started(500, 'e4', { kind: 'file', path: 'src/early.ts' }));
    append(M.failed(600, 'e4', { kind: 'file', path: 'src/early.ts' }));
    append(M.disk(300, 'src/peek.ts'));
    append(M.read(500, 'r3', 'src/peek.ts'));
    append(M.started(0, 'e5', { kind: 'file', path: 'src/both.ts' }));
    append(M.disk(100, 'src/both.ts'));
    append(M.failed(200, 'e5', { kind: 'file', path: 'src/both.ts' }));
    append(M.disk(400, 'src/both.ts'));
    // No agent activity at all.
    append(M.disk(200, 'src/hand.ts'));
    // A change inside the call: explained, nothing to add.
    append(M.started(0, 'e1', { kind: 'file', path: 'src/in.ts' }));
    append(M.disk(100, 'src/in.ts'));
    append(M.failed(200, 'e1', { kind: 'file', path: 'src/in.ts' }));
    append(M.tick(12000));
    // A command that exited 200 ms before a change, and one that exited longer than a quiet window before.
    append(M.started(20000, 'b1', cmd('npm run fmt'), 'Bash'));
    append(M.exited(20400, 'b1', 'npm run fmt'));
    append(M.disk(20600, 'src/fmt.ts'));
    append(M.tick(30000));
    append(M.started(30000, 'b2', cmd('npm run old'), 'Bash'));
    append(M.exited(30100, 'b2', 'npm run old'));
    append(M.disk(32000, 'src/far.ts'));
    append(M.tick(45000));
  });
  const nc = (p) => of(odus, file(p)).not_credited;
  assert.deepStrictEqual(blame(of(odus, file('src/late.ts'))), ['unexplained', null], 'the label stays: a failed call is never credited (LD177)');
  assert.deepStrictEqual(nc('src/late.ts'), [{ kind: 'agent_tool_call', ref: 'e2', says: ['started', 'ended'], seen: 'after_end', gap_ms: 200 }]);
  // Glove and Sentinel joined on one odù: the Glove's failed call and the Sentinel's change, each witness's own marks.
  const late = of(odus, file('src/late.ts'));
  assert.deepStrictEqual([late.witness_status.glove.says, late.witness_status.sentinel.says], [['started', 'ended'], ['modified']]);
  assert.deepStrictEqual(blame(of(odus, file('src/hand.ts'))), ['unexplained', null]);
  assert.deepStrictEqual([of(odus, file('src/hand.ts')).witness_status.glove.status, of(odus, file('src/hand.ts')).witness_status.sentinel.status], ['saw_nothing', 'saw'], 'nothing beside it: the Glove saw nothing, the Sentinel saw the change');
  assert.deepStrictEqual(nc('src/seen.ts'), [{ kind: 'agent_tool_call', ref: 'r2', says: ['read'], seen: 'after_end', gap_ms: 200 }]);
  assert.deepStrictEqual(nc('src/open.ts'), [{ kind: 'agent_tool_call', ref: 'e3', says: ['started'], seen: 'no_end' }]);
  assert.deepStrictEqual(nc('src/early.ts'), [{ kind: 'agent_tool_call', ref: 'e4', says: ['started', 'ended'], seen: 'before_start', gap_ms: 500 }]);
  assert.deepStrictEqual(nc('src/peek.ts'), [{ kind: 'agent_tool_call', ref: 'r3', says: ['read'], seen: 'no_start' }]);
  assert.deepStrictEqual(blame(of(odus, file('src/both.ts'))), ['unexplained', null]);
  assert.deepStrictEqual(nc('src/both.ts'), [{ kind: 'agent_tool_call', ref: 'e5', says: ['started', 'ended'], seen: 'partly_inside' }]);
  assert.deepStrictEqual(nc('src/fmt.ts'),[{ kind: 'agent_command', ref: 'b1', seen: 'after_exit', gap_ms: 200 }]);
  assert.ok(!('not_credited' in of(odus, file('src/far.ts'))), 'an exit longer than a quiet window before is not beside it');
  assert.ok(!('not_credited' in of(odus, file('src/hand.ts'))), 'nothing beside it: no field');
  const inside = of(odus, file('src/in.ts'));
  assert.strictEqual(inside.attribution, 'explained');
  assert.ok(!('not_credited' in inside), 'explained: no field');
  const keys = (r) => checkOdu(r).map((e) => `${e.path} ${e.keyword}`);
  assert.ok(keys({ ...inside, not_credited: nc('src/late.ts') }).length > 0, 'the schema allows it only on an unexplained odù');
});

it('A1 step 3, command child: a change while an agent command runs is explained by the command; with two running, by the first, the other named in `also`', () => {
  const cmd = (text) => ({ kind: 'command', text });
  const { odus } = replay((append) => {
    append(M.started(0, 'b1', cmd('npm run build'), 'Bash'));
    append(M.disk(200, 'out/app.js', 'created'));
    append(M.exited(400, 'b1', 'npm run build'));
    append(M.tick(9000));
    append(M.started(10000, 'b2', cmd('npm run a'), 'Bash'));
    append(M.started(10100, 'b3', cmd('npm run b'), 'Bash'));
    append(M.disk(10200, 'out/both.js', 'created'));
    append(M.exited(10300, 'b2', 'npm run a'));
    append(M.exited(10400, 'b3', 'npm run b'));
    append(M.tick(20000));
  });
  assert.deepStrictEqual(blame(of(odus, file('out/app.js'))), ['explained', { kind: 'agent_command', ref: 'b1' }]);
  assert.deepStrictEqual(blame(of(odus, file('out/both.js'))), ['explained', { kind: 'agent_command', ref: 'b2', also: ['b3'] }]);
});

it('A1 test 9: a build writing to dist/ (no agent command running) is a byproduct, by the entry the list names; outside the root it is not; inside an agent command, step 3 comes first', () => {
  const { odus } = replay(
    (append) => {
      append(M.disk(0, 'dist/app.js', 'created'));
      append(M.disk(0, 'src/keep.js'));
      append(M.tick(9000));
      append(M.started(10000, 'b1', { kind: 'command', text: 'npm run build' }, 'Bash'));
      append(M.disk(10100, 'dist/cmd.js', 'created'));
      append(M.exited(10200, 'b1', 'npm run build'));
      append({ ...M.disk(10300, '/elsewhere/dist/x.js', 'created'), target: { kind: 'file', path: '/elsewhere/dist/x.js', outside: true } });
      append(M.tick(20000));
    },
    { byproducts: { text: '# build output\ndist/\n', inHeader: true } },
  );
  assert.deepStrictEqual(blame(of(odus, file('dist/app.js'))), ['byproduct', { kind: 'byproduct', ref: 'dist/' }]);
  assert.deepStrictEqual(blame(of(odus, file('src/keep.js'))), ['unexplained', null]);
  assert.deepStrictEqual(blame(of(odus, file('dist/cmd.js'))), ['explained', { kind: 'agent_command', ref: 'b1' }], 'the steps run in the brief\'s order');
  assert.deepStrictEqual(blame(of(odus, file('/elsewhere/dist/x.js'))), ['unexplained', null], 'a path outside the root is no byproduct of this project');
});

it('A1 step 4: only a list the header carries labels a byproduct; a header without one (the live path off), whether or not it froze a byproducts file, gives none', () => {
  const build = (append) => {
    append(M.disk(0, 'dist/app.js', 'created'));
    append(M.tick(9000));
  };
  const frozenOnly = replay(build, { byproducts: { text: 'dist/\n', inHeader: false } });
  assert.deepStrictEqual(blame(of(frozenOnly.odus, file('dist/app.js'))), ['unexplained', null]);
  const none = replay(build);
  assert.deepStrictEqual(blame(of(none.odus, file('dist/app.js'))), ['unexplained', null]);
  const listed = replay(build, { byproducts: { text: 'dist/\n', inHeader: true } });
  assert.deepStrictEqual(blame(of(listed.odus, file('dist/app.js'))), ['byproduct', { kind: 'byproduct', ref: 'dist/' }]);
});

it('A1 line 413: odùs of marks that change nothing: a tool call with an outcome is explained by its own call, a turn by its turn, the session\'s end by the session; a call with no outcome and a gap are unexplained', () => {
  const { odus } = replay((append) => {
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
  assert.deepStrictEqual(blame(of(odus, file('src/a.ts'))), ['explained', { kind: 'agent_tool_call', ref: 'r1' }]);
  assert.deepStrictEqual(blame(of(odus, (o) => o.target && o.target.kind === 'command')), ['explained', { kind: 'agent_tool_call', ref: 'b1' }]);
  assert.deepStrictEqual(blame(of(odus, (o) => o.target && o.target.name === 'mcp__x__y')), ['explained', { kind: 'agent_tool_call', ref: 'm1' }]);
  assert.deepStrictEqual(blame(of(odus, (o) => o.target && o.target.name === 'Task')), ['unexplained', null], 'started, no outcome: not explained by itself (outcome missing is C3)');
  assert.deepStrictEqual(blame(of(odus, (o) => o.action === 'gap')), ['unexplained', null]);
  assert.deepStrictEqual(blame(of(odus, (o) => o.target && o.target.kind === 'turn')), ['explained', { kind: 'turn', ref: 't1' }]);
  assert.deepStrictEqual(blame(of(odus, (o) => o.target && o.target.kind === 'session')), ['explained', { kind: 'session', ref: SID }]);
});

it('A1: the odù schema requires attribution and cause, and holds them together: unexplained has no cause, every other label has one', () => {
  const { odus } = replay((append) => {
    append(M.edited(0, 'e1', 'src/a.ts'));
    append(M.tick(9000));
  });
  const [o] = odus;
  const keys = (r) => checkOdu(r).map((e) => `${e.path} ${e.keyword}`);
  const { attribution: _a, ...noLabel } = o;
  const { cause: _c, ...noCause } = o;
  assert.ok(keys(noLabel).includes('/attribution required'));
  assert.ok(keys(noCause).includes('/cause required'));
  assert.ok(keys({ ...o, cause: null }).length > 0, 'explained with no cause');
  assert.ok(keys({ ...o, attribution: 'unexplained' }).length > 0, 'unexplained with a cause');
  assert.ok(keys({ ...o, cause: { kind: 'guess', ref: 'e1' } }).length > 0, 'a kind the spec does not name');
  assert.deepStrictEqual(keys({ ...o, attribution: 'unexplained', cause: null }), []);
});

it('A1 test 13: the same log replayed twice gives byte-identical odù logs, attribution included', () => {
  const base = tmpDir();
  try {
    const log = makeLog(base, {}, { byproducts: { text: 'dist/\n', inHeader: true } });
    log.append(M.edited(0, 'e1', 'src/a.ts'));
    log.append(M.disk(0, 'dist/x.js', 'created'));
    log.append(M.disk(100, 'src/b.ts'));
    log.append(M.tick(9000));
    const a = replayFolder(log.dir);
    const b = replayFolder(log.dir);
    assert.ok(a.odu.includes('"attribution":"byproduct"') && a.odu.includes('"attribution":"unexplained"') && a.odu.includes('"attribution":"explained"'));
    assert.strictEqual(a.odu, b.odu);
    assert.strictEqual(a.text, b.text);
  } finally {
    rmrf(base);
  }
});

runAll('attribute');
