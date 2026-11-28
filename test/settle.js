// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/settle.js — settling rules 2 to 8 through replay (Phase 2 slices S2-S6;
 * brief v4 lines 361-370; tests 1, 3, 7, 8). Hand-built session logs
 * (test/helpers-opon.js); made-up paths.
 */

const { assert, tmpDir, rmrf, it, runAll } = require('./helpers');
const { makeLog, M, ns } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');

const withBase = (fn) => () => {
  const base = tmpDir();
  try {
    fn(base);
  } finally {
    rmrf(base);
  }
};
const groups = (dir) => replayFolder(dir).lines.slice(1).map((l) => JSON.parse(l));

it(
  'test 7 (rule 2): a log written every 200 ms for 2 minutes is force-settled at each ceiling, the continuations linked in a chain',
  withBase((base) => {
    const s = makeLog(base);
    for (let ms = 0; ms < 120000; ms += 200) s.append(M.disk(ms, 'logs/app.log'));
    s.append(M.tick(125000));
    const g = groups(s.dir);
    assert.strictEqual(g.length, 4);
    assert.deepStrictEqual(
      g.map((x) => [x.state, x.settled_at_ns, x.continues]),
      [
        ['sealed', ns(30000), null],
        ['sealed', ns(60000), g[0].group_id],
        ['sealed', ns(90000), g[1].group_id],
        ['sealed', ns(120000), g[2].group_id],
      ],
    );
    assert.deepStrictEqual(g.map((x) => x.mark_seqs.length), [150, 150, 150, 150], 'every mark in exactly one group');
    assert.ok(g.every((x) => x.ceiling === true), 'each says it was force-settled at the ceiling');
  }),
);

it(
  'rule 2: a group quiet before its ceiling settles by the quiet window; a continuation is linked only while the target stays busy',
  withBase((base) => {
    const cfg = { ceiling_ms: 3000 };
    const a = makeLog(base + '/a', cfg);
    a.append(M.disk(0, 'a.txt'));
    a.append(M.disk(500, 'a.txt'));
    a.append(M.tick(20000));
    assert.deepStrictEqual(groups(a.dir).map((x) => [x.settled_at_ns, x.ceiling, x.continues]), [[ns(2000), false, null]]);

    const b = makeLog(base + '/b', cfg);
    for (let ms = 0; ms <= 3400; ms += 200) b.append(M.disk(ms, 'b.txt'));
    b.append(M.tick(20000));
    const gb = groups(b.dir);
    assert.deepStrictEqual(
      gb.map((x) => [x.mark_seqs.length, x.settled_at_ns, x.ceiling, x.continues]),
      [
        [15, ns(3000), true, null],
        [3, ns(4900), false, gb[0].group_id],
      ],
    );

    const c = makeLog(base + '/c', cfg);
    for (let ms = 0; ms <= 2800; ms += 200) c.append(M.disk(ms, 'c.txt'));
    c.append(M.disk(9000, 'c.txt')); // long after the force-settle: a new event, not a continuation (LD153)
    c.append(M.tick(20000));
    const gc = groups(c.dir);
    assert.deepStrictEqual(gc.map((x) => [x.ceiling, x.continues]), [
      [true, null],
      [false, null],
    ]);
  }),
);

it(
  "rule 3: a running command's group stays open until the process exits, past any quiet window and the ceiling, then waits one quiet window",
  withBase((base) => {
    const s = makeLog(base);
    const a = s.append(M.started(0, 'c1', { kind: 'command', text: 'npm install' }, 'Bash'));
    for (let ms = 10000; ms <= 50000; ms += 10000) s.append(M.tick(ms));
    const mid = groups(s.dir);
    assert.deepStrictEqual(mid.map((x) => x.state), ['open'], 'held while the command runs: 50 s, past the 30 s ceiling');
    const b = s.append(M.exited(60000, 'c1', 'npm install'));
    s.append(M.tick(70000));
    const g = groups(s.dir);
    assert.deepStrictEqual(g.map((x) => [x.mark_seqs, x.state, x.settled_at_ns, x.ceiling, x.action]), [[[a, b], 'sealed', ns(61500), false, 'exited']]);
  }),
);

it(
  "rule 3: a turn's group holds until its ended mark; checks that come after the end join it",
  withBase((base) => {
    const s = makeLog(base);
    const p = s.append(M.prompted(0));
    const c = s.append(M.claimed(1000));
    s.append(M.tick(5000)); // quiet 4 s, but the turn has not ended
    assert.deepStrictEqual(groups(s.dir).map((x) => x.state), ['open']);
    const e = s.append(M.turnEnded(6000));
    s.append(M.tick(20000));
    const g = groups(s.dir);
    assert.deepStrictEqual(g.map((x) => [x.mark_seqs, x.settled_at_ns]), [[[p, c, e], ns(7500)]]);
  }),
);

it(
  "rule 3 with rule 2: a turn longer than the ceiling is force-settled there, and its later marks continue it however long the gap (LD154)",
  withBase((base) => {
    const s = makeLog(base);
    s.append(M.prompted(0));
    s.append(M.tick(35000));
    s.append(M.turnEnded(45000)); // 15 s after the force-settle: the turn was still running
    s.append(M.tick(60000));
    const g = groups(s.dir);
    assert.deepStrictEqual(g.map((x) => [x.ceiling, x.settled_at_ns, x.continues === null]), [
      [true, ns(30000), true],
      [false, ns(46500), false],
    ]);
    assert.strictEqual(g[1].continues, g[0].group_id);
  }),
);

it(
  'test 1 (rule 4): an edit saved through a temp file and a rename, then a formatter 1 s later, is one group on the file, modified, with every mark',
  withBase((base) => {
    const s = makeLog(base);
    const seqs = [
      s.append(M.started(0, 'e1', { kind: 'file', path: 'src/a.ts' })),
      s.append(M.disk(100, 'src/a.ts.tmp', 'created')),
      s.append(M.disk(120, 'src/a.ts.tmp', 'deleted')),
      s.append(M.disk(130, 'src/a.ts')),
      s.append(M.edited(150, 'e1', 'src/a.ts')),
      s.append(M.disk(1150, 'src/a.ts')), // the formatter
    ];
    s.append(M.tick(20000));
    const g = groups(s.dir);
    assert.deepStrictEqual(g.map((x) => [x.target, x.action, x.mark_seqs]), [[{ kind: 'file', path: 'src/a.ts' }, 'modified', seqs]]);
  }),
);

it("rule 4: an editor's temp names (~, .#, .swp, vim's 4913) join their file's group; a 4913 with no file open in its folder stands alone", withBase((base) => {
  const s = makeLog(base);
  const a = s.append(M.disk(0, 'lib/foo.c'));
  const b = s.append(M.disk(10, 'lib/foo.c~', 'created'));
  const c = s.append(M.disk(20, 'lib/.#foo.c', 'created'));
  const d = s.append(M.disk(30, 'lib/.foo.c.swp', 'created'));
  const e = s.append(M.disk(40, 'lib/4913', 'created'));
  const lone = s.append(M.disk(50, 'other/4913', 'created'));
  s.append(M.tick(20000));
  const g = groups(s.dir);
  assert.deepStrictEqual(g.map((x) => [x.target.path, x.mark_seqs]), [
    ['lib/foo.c', [a, b, c, d, e]],
    ['other/4913', [lone]],
  ]);
  assert.strictEqual(g[0].action, 'modified', 'the temp files\' own creations do not make the file look created');
}));

it('rule 4: a rename moves the old path\'s group into the new one; a rename alone is renamed', withBase((base) => {
  const s = makeLog(base);
  const a1 = s.append(M.disk(0, 'old.txt'));
  const r = s.append({ ...M.disk(100, 'new.txt', 'renamed'), detail: { root: '/r', size: 4, from: 'old.txt', fingerprint_before: null, fingerprint: 'sha256:' + 'e'.repeat(64), lines_added: null, lines_removed: null } });
  const n1 = s.append(M.disk(200, 'new.txt'));
  const lone = s.append({ ...M.disk(5000, 'z.txt', 'renamed'), detail: { root: '/r', size: 4, from: 'y.txt', fingerprint_before: null, fingerprint: 'sha256:' + 'f'.repeat(64), lines_added: null, lines_removed: null } });
  s.append(M.tick(30000));
  const g = groups(s.dir);
  assert.deepStrictEqual(g.map((x) => [x.target.path, x.mark_seqs]), [
    ['new.txt', [a1, r, n1]],
    ['z.txt', [lone]],
  ]);
  assert.strictEqual(g[1].action, 'renamed');
}));

const dirMark = (ms, dir, says) => ({ ...M.disk(ms, dir, says), target: { kind: 'dir', path: dir } });

it('rule 5: a file deleted then created again inside one window is one group, modified; test 3: an edit and its revert are one group', withBase((base) => {
  const s = makeLog(base);
  s.append(M.disk(0, 'a.txt', 'deleted'));
  s.append(M.disk(500, 'a.txt', 'created'));
  s.append(M.disk(5000, 'b.txt'));
  s.append(M.disk(5400, 'b.txt')); // back to the bytes it had: net change is station 4's
  s.append(M.tick(30000));
  const g = groups(s.dir);
  assert.deepStrictEqual(g.map((x) => [x.target.path, x.action, x.mark_seqs.length]), [
    ['a.txt', 'modified', 2],
    ['b.txt', 'modified', 2],
  ]);
}));

it('rule 6: a folder\'s changes fold into the file changes beneath it, before or after them; a folder alone keeps its own group', withBase((base) => {
  const s = makeLog(base);
  const d1 = s.append(dirMark(0, 'build', 'created'));
  const f1 = s.append(M.disk(100, 'build/out.js', 'created'));
  const f2 = s.append(M.disk(200, 'src/x.js'));
  const d2 = s.append(dirMark(250, 'src', 'modified'));
  const lone = s.append(dirMark(300, 'empty', 'created'));
  const f3 = s.append(M.disk(400, 'gone/a.js'));
  const d3 = s.append(dirMark(450, 'gone', 'deleted')); // a folder's mark does not count for the action
  s.append(M.tick(30000));
  const g = groups(s.dir);
  assert.deepStrictEqual(g.map((x) => [x.target, x.action, x.mark_seqs]), [
    [{ kind: 'file', path: 'build/out.js' }, 'created', [d1, f1]],
    [{ kind: 'file', path: 'src/x.js' }, 'modified', [f2, d2]],
    [{ kind: 'dir', path: 'empty' }, 'created', [lone]],
    [{ kind: 'file', path: 'gone/a.js' }, 'modified', [f3, d3]],
  ]);
}));

it('test 8 (rule 8): a mark that arrives after its group sealed never reopens it: a new group amends it; a later unrelated change amends nothing', withBase((base) => {
  const s = makeLog(base);
  const a = s.append(M.started(0, 'e1', { kind: 'file', path: 'src/a.ts' }));
  const b = s.append(M.disk(100, 'src/a.ts'));
  s.append(M.turnEnded(200)); // the call's wait ends with its turn (C3b): settled at 1,700, sealed at 4,700
  s.append(M.tick(5000));
  const late = s.append(M.edited(5100, 'e1', 'src/a.ts')); // the hook's outcome, for the same tool call, after the seal
  const stale = s.append(M.disk(4000, 'src/b.ts')); // a slow source: seen at 4,000, arrives now
  s.append(M.tick(9000));
  const fresh = s.append(M.edited(20000, 'e2', 'src/a.ts')); // a new tool call, long after
  s.append(M.tick(40000));
  const g = groups(s.dir);
  const byPath = (p) => g.filter((x) => x.target.path === p);
  const [first, amend, again] = byPath('src/a.ts');
  assert.deepStrictEqual(first.mark_seqs, [a, b], 'the sealed record is untouched');
  assert.strictEqual(first.amends, null);
  assert.strictEqual(first.settled_at_ns, ns(1700), 'its wait ended at the turn\'s end (200): one quiet window from then (C3b)');
  assert.deepStrictEqual(first.conflicts.map((c) => [c.kind, c.ref, c.why]), [['outcome_missing', 'e1', null]], 'judged at the end of its turn, and kept: the late outcome never rewrites it');
  assert.deepStrictEqual(amend.mark_seqs, [late]);
  assert.strictEqual(amend.amends, first.group_id);
  assert.deepStrictEqual(amend.conflicts, [], 'the late report is not ignored: it is a record of its own, pointing at the one it amends, the Sentinel\'s sighting there confirming it (C3a2)');
  assert.deepStrictEqual(again.mark_seqs, [fresh]);
  assert.strictEqual(again.amends, null);
  assert.strictEqual(byPath('src/b.ts')[0].mark_seqs[0], stale);
  assert.strictEqual(byPath('src/b.ts')[0].amends, null, 'no sealed group of its own to amend');
}));

it('rule 8: a slow source\'s mark, observed before its target\'s group sealed but arriving after, amends it', withBase((base) => {
  const s = makeLog(base);
  const a = s.append(M.disk(0, 'x.txt'));
  s.append(M.tick(6000)); // sealed at 4,500
  const slow = s.append(M.disk(4400, 'x.txt')); // seen at 4,400, before the seal
  const after = s.append(M.disk(7000, 'x.txt')); // the amending group is open: it joins it (rule 1)
  s.append(M.tick(30000));
  const g = groups(s.dir);
  assert.deepStrictEqual(g.map((x) => [x.mark_seqs, x.amends === null]), [
    [[a], true],
    [[slow, after], false],
  ]);
  assert.strictEqual(g[1].amends, g[0].group_id);
}));

runAll('settle');
