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

runAll('settle');
