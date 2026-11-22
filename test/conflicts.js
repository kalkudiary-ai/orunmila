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
