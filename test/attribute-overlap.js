'use strict';

/**
 * test/attribute-overlap.js — station 5 while sessions overlap in a folder
 * (Phase 3 slice A2, LD179-LD181; brief v4 lines 402-407; test 37, and test
 * 38's attribution half: the phantom claim itself is C3). Two session folders
 * side by side, each replayed. Hand-built logs, labelled so (brief line 761):
 * made-up paths and ids. Quiet window 1,500 ms, lag grace 3,000 ms.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { makeLog, M, SID, as } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');
const { compile } = require('../src/verify/schema');

const checkOdu = compile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'odu.schema.json'), 'utf8')));
const B = 'ses_b';
const cmd = (text) => ({ kind: 'command', text });

/** Replay session A (SID), with session B's log beside it when `buildB` is given. Returns A's and B's odùs and A's replay head. */
function replayPair(buildA, buildB, { bRoot = (root) => root, byproducts = null, breakB = false } = {}) {
  const base = tmpDir();
  try {
    const a = makeLog(base, {}, { byproducts });
    buildA(a.append);
    let b = null;
    if (buildB) {
      b = makeLog(base, {}, { sessionId: B, root: bRoot(a.root), startMs: 500 });
      buildB((m) => b.append(as(B, m)));
      if (breakB) fs.writeFileSync(path.join(b.dir, 'raw.jsonl'), fs.readFileSync(path.join(b.dir, 'raw.jsonl'), 'utf8').replace('"says":"tick"', '"says":"tock"'));
    }
    const read = (dir) => {
      const r = replayFolder(dir);
      assert.strictEqual(r.ok, true, r.words);
      const odus = r.odu.split('\n').slice(1, -1).map((l) => JSON.parse(l));
      for (const o of odus) assert.deepStrictEqual(checkOdu(o), [], JSON.stringify(o));
      return { odus, head: JSON.parse(r.lines[0]) };
    };
    const ra = read(a.dir);
    return { a: ra.odus, head: ra.head, b: b && !breakB ? read(b.dir).odus : null };
  } finally {
    rmrf(base);
  }
}
const of = (odus, p) => {
  const hit = odus.filter((o) => o.target && o.target.kind === 'file' && o.target.path === p);
  assert.strictEqual(hit.length, 1, JSON.stringify(odus.map((o) => [o.action, o.target])));
  return hit[0];
};
const blame = (o) => [o.attribution, o.cause];
const both = [B, SID].sort();
// C3a (LD188): the conflict names the sources behind the change and what each said, beside the sessions.
const overlap = { kind: 'concurrent_sessions', sources: ['sentinel'], said: { sentinel: ['modified'] }, sessions: both };

// Session A runs a long command while session B edits a file in the same folder (test 37).
const longCommand = (append) => {
  append(M.started(1000, 'b1', cmd('npm run long'), 'Bash'));
  append(M.disk(2000, 'src/b.ts'));
  append(M.exited(5000, 'b1', 'npm run long'));
  append(M.turnEnded(5000)); // C3d2: the agent's changes wait for their turn's end
  append(M.tick(15000));
};
const bEdits = (append) => {
  append(M.edited(1990, 'e9', 'src/b.ts'));
  append(M.disk(2000, 'src/b.ts'));
  append(M.turnEnded(2000));
  append(M.tick(15000));
};

it('A2 test 37: B\'s edit while A runs a long command is not credited to A: unexplained, with a concurrent_sessions conflict naming both; in B\'s own record its tool call explains it', () => {
  const { a, b } = replayPair(longCommand, bEdits);
  const inA = of(a, 'src/b.ts');
  assert.deepStrictEqual(blame(inA), ['unexplained', null]);
  assert.deepStrictEqual(inA.conflicts, [overlap]);
  assert.deepStrictEqual(inA.not_credited, [{ kind: 'agent_command', ref: 'b1', seen: 'while_running' }], 'A\'s running command is named, never credited');
  // Glove and Sentinel joined on each record: in A's, the Sentinel saw the change and A's Glove has nothing for it.
  assert.deepStrictEqual([inA.witness_status.glove.status, inA.witness_status.sentinel.status], ['saw_nothing', 'saw']);
  assert.strictEqual(inA.confidence, 'high', 'C1: the change is certain, and its label says it cannot be pinned (line 423)');
  const inB = of(b, 'src/b.ts');
  assert.deepStrictEqual(blame(inB), ['explained', { kind: 'agent_tool_call', ref: 'e9' }], 'a direct cause pins it to one session');
  assert.deepStrictEqual(inB.conflicts, [], 'C3a: no conflict, and the list still written');
  // In B's, both witnesses saw it: B's Glove edit and the Sentinel's change, one odù.
  assert.deepStrictEqual([inB.witness_status.glove.status, inB.witness_status.sentinel.status], ['saw', 'saw']);
  assert.strictEqual(inB.confidence, 'high', 'C1: a direct cause');
});

it('A2 control: the same log of A alone credits the change to A\'s command (step 3), with no conflict', () => {
  const { a } = replayPair(longCommand, null);
  const o = of(a, 'src/b.ts');
  assert.deepStrictEqual(blame(o), ['explained', { kind: 'agent_command', ref: 'b1' }]);
  assert.deepStrictEqual(o.conflicts, []);
  assert.ok(!('not_credited' in o));
});

it('A2 test 38 (attribution half): A claims the change B made; A\'s record does not credit it to A and names both sessions', () => {
  const { a } = replayPair((append) => {
    append(M.prompted(0));
    append(M.disk(2000, 'src/b.ts'));
    append(M.claimed(3000));
    append(M.turnEnded(3100));
    append(M.tick(15000));
  }, bEdits);
  const o = of(a, 'src/b.ts');
  assert.deepStrictEqual(blame(o), ['unexplained', null]);
  assert.deepStrictEqual(o.conflicts, [overlap]);
});

it('C3d1 test 38: A claims the change B made: a phantom file claim for A at medium confidence, plus a concurrent_sessions note naming both sessions', () => {
  const { a } = replayPair((append) => {
    append(M.prompted(0));
    append(M.disk(2000, 'src/b.ts'));
    append({ ...M.claimed(3000), detail: { text: 'I updated src/b.ts.' } });
    append(M.turnEnded(3100));
    append(M.tick(15000));
  }, bEdits);
  const claims = a.filter((o) => o.target && o.target.kind === 'claim' && o.target.turn === 't1');
  assert.strictEqual(claims.length, 1);
  const [o] = claims;
  const said = { agent_claim: ['claimed'], sentinel: ['modified'] };
  assert.deepStrictEqual([o.witness_status.glove.status, o.witness_status.sentinel.status], ['saw', 'saw'], 'the Glove\'s claim, the Sentinel\'s change on its target');
  assert.strictEqual(o.confidence, 'medium');
  assert.deepStrictEqual(o.conflicts, [
    { kind: 'phantom_claim', sources: ['agent_claim', 'sentinel'], said, claim: 'file', path: 'src/b.ts', hedged: false, why: 'not_credited', targets: ['src/b.ts'] },
    { kind: 'concurrent_sessions', sources: ['agent_claim', 'sentinel'], said, sessions: both },
  ]);
});

it('A2 line 404: during overlap a time match (step 2) does not credit, the call is named in not_credited as inside; a direct cause (step 1) still does', () => {
  const { a } = replayPair((append) => {
    append(M.started(3000, 'e2', { kind: 'file', path: 'src/c.ts' }));
    append(M.disk(3100, 'src/c.ts'));
    append(M.failed(3200, 'e2', { kind: 'file', path: 'src/c.ts' }));
    append(M.edited(3300, 'e3', 'src/d.ts'));
    append(M.disk(3400, 'src/d.ts'));
    append(M.turnEnded(3400));
    append(M.tick(15000));
  }, bEdits);
  const c = of(a, 'src/c.ts');
  assert.deepStrictEqual(blame(c), ['unexplained', null]);
  assert.deepStrictEqual(c.conflicts, [{ ...overlap, sources: ['hook', 'sentinel'], said: { hook: ['started', 'ended'], sentinel: ['modified'] } }], 'C3a: the Glove\'s call is in the odù too, so it names what that source said');
  assert.deepStrictEqual(c.not_credited, [{ kind: 'agent_tool_call', ref: 'e2', says: ['started', 'ended'], seen: 'inside' }]);
  assert.deepStrictEqual([c.witness_status.glove.status, c.witness_status.sentinel.status], ['saw', 'saw'], 'both witnesses, joined: the Glove\'s call, the Sentinel\'s change');
  const d = of(a, 'src/d.ts');
  assert.deepStrictEqual(blame(d), ['explained', { kind: 'agent_tool_call', ref: 'e3' }]);
  assert.deepStrictEqual(d.conflicts, []);
  assert.deepStrictEqual([d.witness_status.glove.status, d.witness_status.sentinel.status], ['saw', 'saw']);
});

it('A2 line 407: the byproducts list (step 4) still applies during overlap, with no conflict', () => {
  const { a } = replayPair(
    (append) => {
      append(M.disk(2500, 'dist/x.js', 'created'));
      append(M.tick(15000));
    },
    bEdits,
    { byproducts: { text: 'dist/\n', inHeader: true } },
  );
  const o = of(a, 'dist/x.js');
  assert.deepStrictEqual(blame(o), ['byproduct', { kind: 'byproduct', ref: 'dist/' }]);
  assert.deepStrictEqual(o.conflicts, []);
});

it('A2: which sessions overlap: one in another folder does not, one in a folder inside this one does, one that ended before the change does not', () => {
  const change = (append) => {
    append(M.started(1000, 'b1', cmd('npm run long'), 'Bash'));
    append(M.disk(8000, 'src/b.ts'));
    append(M.exited(9000, 'b1', 'npm run long'));
    append(M.turnEnded(9000));
    append(M.tick(20000));
  };
  const bBrief = (append) => {
    append(M.tick(1000));
    append(M.sessionEnded(2000));
  };
  const elsewhere = replayPair(change, (append) => append(M.tick(8000)), {
    bRoot: (root) => {
      fs.mkdirSync(`${root}-elsewhere`);
      return `${root}-elsewhere`;
    },
  });
  assert.deepStrictEqual(blame(of(elsewhere.a, 'src/b.ts')), ['explained', { kind: 'agent_command', ref: 'b1' }], 'another folder: no overlap');
  const inside = replayPair(change, (append) => append(M.tick(8000)), {
    bRoot: (root) => {
      fs.mkdirSync(path.join(root, 'sub'));
      return path.join(root, 'sub');
    },
  });
  assert.deepStrictEqual(of(inside.a, 'src/b.ts').conflicts, [overlap], 'a folder inside this one shares its files');
  const ended = replayPair(change, bBrief);
  assert.deepStrictEqual(blame(of(ended.a, 'src/b.ts')), ['explained', { kind: 'agent_command', ref: 'b1' }], 'B ended at 2 s, the change was at 8 s');
});

it('A2 LD179: a session folder beside this one whose log does not verify is lost evidence, and counts as active: no credit by steps 2 or 3', () => {
  const { a, head } = replayPair(longCommand, (append) => append(M.tick(3000)), { breakB: true });
  assert.deepStrictEqual(head.lost_evidence, [{ seq: null, ref: B, problem: 'other_session_unverified' }]);
  const o = of(a, 'src/b.ts');
  assert.deepStrictEqual(blame(o), ['unexplained', null]);
  assert.deepStrictEqual(o.conflicts, [overlap]);
});

it('A2 test 13: two sessions replayed twice give byte-identical odù logs', () => {
  const base = tmpDir();
  try {
    const a = makeLog(base, {});
    longCommand(a.append);
    const b = makeLog(base, {}, { sessionId: B, root: a.root, startMs: 500 });
    bEdits((m) => b.append(as(B, m)));
    const x = replayFolder(a.dir);
    const y = replayFolder(a.dir);
    assert.ok(x.odu.includes('"concurrent_sessions"'));
    assert.strictEqual(x.odu, y.odu);
    assert.strictEqual(x.text, y.text);
  } finally {
    rmrf(base);
  }
});

runAll('attribute-overlap');
