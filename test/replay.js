'use strict';

/**
 * test/replay.js — the replay harness and the event-time engine (Phase 2 slice
 * R1, LD142, LD152; brief v4 lines 355-370, 607-608; tests 13, 34, 35;
 * settling rules 1 and 7; open question 4). Hand-built session logs
 * (test/helpers-opon.js); made-up paths.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll, run } = require('./helpers');
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
const groups = (out) => out.lines.slice(1).map((l) => JSON.parse(l));

it(
  'rules 1 and 7: one edit seen by both witnesses is one group, settled a quiet window after its last mark and sealed a lag grace after that, in event time',
  withBase((base) => {
    const s = makeLog(base);
    const seqs = [
      s.append(M.started(0, 'e1', { kind: 'file', path: 'src/a.ts' })),
      s.append(M.edited(100, 'e1', 'src/a.ts')),
      s.append(M.disk(300, 'src/a.ts')),
    ];
    s.append(M.tick(1000));
    s.append(M.tick(1799)); // 1,499 ms after the last mark: still open
    s.append(M.tick(4799)); // settled at 1,800; the grace ends at 4,800
    s.append(M.tick(4800));
    const out = replayFolder(s.dir);
    assert.strictEqual(out.ok, true, out.words);
    const g = groups(out);
    assert.strictEqual(g.length, 1);
    assert.strictEqual(g[0].state, 'sealed');
    assert.deepStrictEqual(g[0].target, { kind: 'file', path: 'src/a.ts' });
    assert.strictEqual(g[0].action, 'modified');
    assert.deepStrictEqual(g[0].mark_seqs, seqs);
    assert.deepStrictEqual(g[0].window, { first_seq: seqs[0], last_seq: seqs[2] });
    assert.strictEqual(g[0].settled_at_ns, ns(1800));
    assert.strictEqual(g[0].sealed_at_ns, ns(4800));
    // A log that ends inside the grace: settled, not yet sealed (rule 7).
    const s2 = makeLog(path.join(base, 'two'));
    s2.append(M.disk(0, 'src/a.ts'));
    s2.append(M.tick(4799)); // a: settled at 1,500, sealed at 4,500
    s2.append(M.disk(5000, 'src/b.ts'));
    s2.append(M.tick(7000)); // b settled at 6,500, grace to 9,500
    const g2 = groups(replayFolder(s2.dir));
    assert.deepStrictEqual(g2.map((x) => [x.target.path, x.state, x.sealed_at_ns]), [
      ['src/a.ts', 'sealed', ns(4500)],
      ['src/b.ts', 'settled', null],
    ]);
  }),
);

it(
  'rule 1: a mark that arrives before the window closes resets the timer; one that arrives during the grace joins and reopens the group',
  withBase((base) => {
    const s = makeLog(base);
    const a = s.append(M.disk(0, 'f.txt'));
    const b = s.append(M.disk(1400, 'f.txt')); // inside the window: same group, timer reset
    s.append(M.tick(2900)); // settled at 2,900
    const c = s.append(M.disk(3500, 'f.txt')); // in the grace: joins, open again
    s.append(M.tick(5000)); // settled at 5,000
    s.append(M.tick(8000)); // sealed at 8,000
    const g = groups(replayFolder(s.dir));
    assert.strictEqual(g.length, 1);
    assert.deepStrictEqual(g[0].mark_seqs, [a, b, c]);
    assert.strictEqual(g[0].settled_at_ns, ns(5000));
    assert.strictEqual(g[0].sealed_at_ns, ns(8000));
  }),
);

it(
  'event time: two targets settle and seal independently, and the output lists sealed groups in the order they sealed, then the rest as they stand',
  withBase((base) => {
    const s = makeLog(base);
    s.append(M.disk(0, 'late.txt'));
    s.append(M.disk(500, 'early-then-busy.txt'));
    s.append(M.disk(1000, 'late.txt'));
    s.append(M.tick(5600)); // late.txt: settled 2,500, sealed 5,500; the other settled 2,000, sealed 5,000
    s.append(M.disk(5700, 'open.txt'));
    const g = groups(replayFolder(s.dir));
    assert.deepStrictEqual(
      g.map((x) => [x.target.path, x.state]),
      [
        ['early-then-busy.txt', 'sealed'],
        ['late.txt', 'sealed'],
        ['open.txt', 'open'],
      ],
    );
  }),
);

it(
  'test 35: replay uses the quiet window and grace in the session header, never the defaults',
  withBase((base) => {
    const s = makeLog(base, { quiet_window_ms: 200, lag_grace_ms: 100 });
    s.append(M.disk(0, 'f.txt'));
    s.append(M.disk(500, 'f.txt')); // past a 200 ms window: a second group
    s.append(M.tick(1000));
    const g = groups(replayFolder(s.dir));
    assert.strictEqual(g.length, 2, 'the header says 200 ms; with the 1,500 ms default this would be one group');
    assert.deepStrictEqual(g.map((x) => x.state), ['sealed', 'sealed']);
  }),
);

it(
  'tests 13 and 34: the same log replayed twice gives byte-identical output, and changing files on disk after the session changes nothing',
  withBase((base) => {
    const s = makeLog(base);
    fs.writeFileSync(path.join(s.root, 'a.txt'), 'one');
    s.append(M.started(0, 'e1', { kind: 'file', path: 'a.txt' }));
    s.append(M.edited(50, 'e1', 'a.txt'));
    s.append(M.exited(60, 'b1', 'npm test'));
    s.append(M.tick(9000));
    const first = replayFolder(s.dir).text;
    fs.writeFileSync(path.join(s.root, 'a.txt'), 'changed since');
    fs.rmSync(path.join(s.root, 'a.txt'));
    const second = replayFolder(s.dir).text;
    assert.strictEqual(first, second);
    assert.ok(first.endsWith('\n'));
  }),
);

it(
  "open question 4: a kept file missing at replay is named as lost evidence in the output's first line, never read as an empty diff",
  withBase((base) => {
    const s = makeLog(base);
    const seq = s.append(M.disk(0, 'f.txt'), [{ slot: 'diff_ref', text: '--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-a\n+b\n' }]);
    const files = path.join(s.dir, 'files');
    for (const f of fs.readdirSync(files)) fs.rmSync(path.join(files, f));
    const out = replayFolder(s.dir);
    assert.strictEqual(out.ok, true, out.words);
    const head = JSON.parse(out.lines[0]);
    assert.strictEqual(head.record, 'replay');
    assert.deepStrictEqual(head.lost_evidence.map((l) => [l.seq, l.problem]), [[seq, 'missing']]);
  }),
);

it(
  'a raw log whose chain is broken is refused with the verifier\'s words: replay never judges an altered record',
  withBase((base) => {
    const s = makeLog(base);
    s.append(M.disk(0, 'f.txt'));
    s.append(M.disk(10, 'g.txt'));
    const raw = path.join(s.dir, 'raw.jsonl');
    const lines = fs.readFileSync(raw, 'utf8').split('\n');
    lines[1] = lines[1].replace('f.txt', 'h.txt');
    fs.writeFileSync(raw, lines.join('\n'));
    const out = replayFolder(s.dir);
    assert.strictEqual(out.ok, false);
    assert.ok(/line 2/.test(out.words), out.words);
  }),
);

it(
  'CLI: orunmila replay <folder> prints the output; --expect names the first line that differs and exits 1',
  withBase((base) => {
    const s = makeLog(base);
    s.append(M.disk(0, 'f.txt'));
    s.append(M.tick(9000));
    const r = run('bin/orunmila.js', { args: ['replay', s.dir] });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, replayFolder(s.dir).text);
    const expect = path.join(base, 'expect.jsonl');
    fs.writeFileSync(expect, r.stdout);
    assert.strictEqual(run('bin/orunmila.js', { args: ['replay', s.dir, '--expect', expect] }).status, 0);
    fs.writeFileSync(expect, r.stdout.replace('"sealed"', '"settled"'));
    const d = run('bin/orunmila.js', { args: ['replay', s.dir, '--expect', expect] });
    assert.strictEqual(d.status, 1);
    assert.ok(/line 2/.test(d.stdout), d.stdout);
  }),
);

runAll('replay');
