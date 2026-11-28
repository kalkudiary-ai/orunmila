// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/net.js — station 4, net change in the event-time engine (Phase 3 slice
 * N2, LD171; brief v4 lines 381-390, 301-305, 333; test 3 in full). Built and
 * read through replay, as Phase 2's stations were. Hand-built logs, labelled
 * so (brief line 761): made-up paths and fingerprints. Quiet window 1,500 ms,
 * lag grace 3,000 ms (the header's defaults).
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { makeLog, M, FP } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');
const { compile } = require('../src/verify/schema');

const checkOdu = compile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'odu.schema.json'), 'utf8')));
const BASE = [
  { path: 'src/a.js', size: 4, fingerprint: FP('a') },
  { path: 'src/link', kind: 'link' },
];

/** Replay a hand-built log: `build(append)` writes the marks. Returns { groups, odus, r }. */
function replay(build, { config = {}, baseline = BASE, after } = {}) {
  const base = tmpDir();
  try {
    const log = makeLog(base, config, { baseline });
    build(log.append);
    if (after) after(log.dir);
    const r = replayFolder(log.dir);
    assert.strictEqual(r.ok, true, r.words);
    const groups = r.lines.slice(1).map((l) => JSON.parse(l));
    const odus = r.odu.split('\n').slice(1, -1).map((l) => JSON.parse(l));
    for (const o of odus) assert.deepStrictEqual(checkOdu(o), [], JSON.stringify(o));
    return { groups, odus, r };
  } finally {
    rmrf(base);
  }
}
const fileOdus = (odus, p) => odus.filter((o) => o.target && o.target.kind === 'file' && o.target.path === p);

it('N2 test 3: a file edited then reverted inside one window is one odù with changed: false, kept; the fingerprint joins the settled group, which still settles and seals when it would have', () => {
  let fpSeq;
  const { groups, odus } = replay((append) => {
    append(M.edited(0, 'c1', 'src/a.js'));
    append(M.edited(500, 'c2', 'src/a.js'));
    fpSeq = append(M.fingerprinted(2100, 'src/a.js', FP('a'))); // settled at 2,000 ms; the intake fingerprints it then
    append(M.tick(6000));
  });
  const [o] = fileOdus(odus, 'src/a.js');
  assert.strictEqual(fileOdus(odus, 'src/a.js').length, 1);
  assert.deepStrictEqual(o.net_change, { before: FP('a'), after: FP('a'), changed: false });
  assert.ok(o.mark_seqs.includes(fpSeq), 'the fingerprinted mark is in its odù');
  assert.strictEqual(o.action, 'modified', 'the fingerprint does not count for the action');
  const g = groups.find((x) => x.target && x.target.path === 'src/a.js');
  assert.strictEqual(g.settled_at_ns, String(1000n * 1000000000n + 2000n * 1000000n), 'settled at the last edit plus the quiet window: not reopened');
  assert.strictEqual(g.sealed_at_ns, String(1000n * 1000000000n + 5000n * 1000000n));
});

it('N2: a fingerprint that arrives while its group is still open neither delays its settle nor counts as a change on disk', () => {
  const { groups, odus } = replay((append) => {
    append(M.edited(0, 'c1', 'src/a.js'));
    append(M.fingerprinted(1000, 'src/a.js', FP('b')));
    append(M.turnEnded(1000)); // C3d2: the agent's change waits for its turn's end
    append(M.tick(9000));
  });
  const g = groups.find((x) => x.target && x.target.path === 'src/a.js');
  assert.strictEqual(g.settled_at_ns, String(1000n * 1000000000n + 1500n * 1000000n), 'settled at the edit plus the quiet window');
  assert.deepStrictEqual(fileOdus(odus, 'src/a.js')[0].net_change, { before: FP('a'), after: FP('b'), changed: true });
});

it('N2: a group the ceiling settled still takes its own fingerprint; no continuation is opened for it', () => {
  const { odus } = replay((append) => {
    for (let ms = 0; ms < 30000; ms += 1000) append(M.disk(ms, 'src/a.js'));
    append(M.fingerprinted(30000, 'src/a.js', FP('e'))); // the ceiling settles it at 30,000 ms
    append(M.tick(40000));
  });
  const all = fileOdus(odus, 'src/a.js');
  assert.strictEqual(all.length, 1, JSON.stringify(all.map((o) => [o.odu_id, o.continues])));
  assert.deepStrictEqual(all[0].net_change, { before: FP('a'), after: FP('e'), changed: true });
});

it("N2: before is the baseline's for the target's first group, then the last sealed group's after; same is changed false, different is changed true", () => {
  const { odus } = replay((append) => {
    append(M.edited(0, 'c1', 'src/a.js'));
    append(M.fingerprinted(1600, 'src/a.js', FP('b')));
    append(M.turnEnded(1600));
    append(M.tick(5000)); // the first group seals at 4,500 ms
    append(M.edited(10000, 'c2', 'src/a.js', 'modified', 't2'));
    append(M.fingerprinted(11600, 'src/a.js', FP('c')));
    append(M.turnEnded(11600, 't2'));
    append(M.tick(20000));
  });
  const [one, two] = fileOdus(odus, 'src/a.js');
  assert.deepStrictEqual(one.net_change, { before: FP('a'), after: FP('b'), changed: true });
  assert.deepStrictEqual(two.net_change, { before: FP('b'), after: FP('c'), changed: true });
});

it('N2: a file not in the baseline was absent before; a deleted file is absent after; created then deleted in one window is changed false', () => {
  const { odus } = replay((append) => {
    append(M.edited(0, 'c1', 'src/new.js', 'created'));
    append(M.disk(100, 'src/a.js', 'deleted'));
    append(M.edited(200, 'c2', 'src/brief.js', 'created'));
    append(M.disk(300, 'src/brief.js', 'deleted'));
    append(M.fingerprinted(1600, 'src/new.js', FP('e')));
    append(M.fingerprinted(1700, 'src/a.js', 'absent'));
    append(M.fingerprinted(1900, 'src/brief.js', 'absent'));
    append(M.turnEnded(1900));
    append(M.tick(9000));
  });
  assert.deepStrictEqual(fileOdus(odus, 'src/new.js')[0].net_change, { before: 'absent', after: FP('e'), changed: true });
  assert.deepStrictEqual(fileOdus(odus, 'src/a.js')[0].net_change, { before: FP('a'), after: 'absent', changed: true });
  assert.deepStrictEqual(fileOdus(odus, 'src/brief.js')[0].net_change, { before: 'absent', after: 'absent', changed: false });
});

it('N2: unknown is null: no fingerprint at settle, a mark after the last fingerprint, a link in the baseline, a path the baseline does not cover, and no baseline at all', () => {
  const { odus } = replay(
    (append) => {
      append(M.edited(0, 'c1', 'src/a.js')); // never fingerprinted
      append(M.edited(0, 'c2', 'src/b.js'));
      append(M.disk(0, 'src/link'));
      append(M.disk(0, 'vendor/x.js'));
      append(M.fingerprinted(1600, 'src/b.js', FP('b')));
      append(M.fingerprinted(1600, 'src/link', FP('f')));
      append(M.fingerprinted(1600, 'vendor/x.js', FP('9')));
      append(M.disk(2000, 'src/b.js')); // a slow Sentinel mark in the grace: reopens it; no fingerprint after it
      append(M.turnEnded(2000));
      append(M.tick(20000));
    },
    { config: { exclusions: ['vendor/'] } },
  );
  assert.deepStrictEqual(fileOdus(odus, 'src/a.js')[0].net_change, { before: FP('a'), after: null, changed: null });
  assert.deepStrictEqual(fileOdus(odus, 'src/b.js')[0].net_change, { before: 'absent', after: null, changed: null });
  assert.deepStrictEqual(fileOdus(odus, 'src/link')[0].net_change, { before: null, after: FP('f'), changed: null });
  assert.deepStrictEqual(fileOdus(odus, 'vendor/x.js')[0].net_change, { before: null, after: FP('9'), changed: null }, 'an excluded path is not in the baseline, and not absent');
  const none = replay(
    (append) => {
      append(M.edited(0, 'c1', 'src/a.js'));
      append(M.fingerprinted(1600, 'src/a.js', FP('a')));
      append(M.turnEnded(1600));
      append(M.tick(9000));
    },
    { baseline: null },
  );
  assert.deepStrictEqual(fileOdus(none.odus, 'src/a.js')[0].net_change, { before: null, after: FP('a'), changed: null }, 'with no baseline the first before is unknown');
});

it('N2: odùs of marks that change nothing on disk leave net_change out (line 389): a read, a command, a turn', () => {
  const { odus } = replay((append) => {
    append(M.prompted(0));
    append(M.read(10, 'r1', 'src/a.js'));
    append(M.started(20, 'b1', { kind: 'command', text: 'npm test' }, 'Bash'));
    append(M.exited(30, 'b1', 'npm test'));
    append(M.claimed(40));
    append(M.turnEnded(50));
    append(M.tick(9000));
  });
  assert.ok(odus.length >= 3, JSON.stringify(odus.map((o) => o.action)));
  for (const o of odus) assert.strictEqual('net_change' in o, false, `${o.action} ${JSON.stringify(o.target)}`);
});

it('N2: after a rename the old path is absent; the new path takes its own before', () => {
  const { odus } = replay((append) => {
    append(M.disk(0, 'src/b.js', 'renamed', { from: 'src/a.js' }));
    append(M.fingerprinted(1600, 'src/b.js', FP('a')));
    append(M.tick(9000));
    append(M.edited(10000, 'c1', 'src/a.js', 'created'));
    append(M.fingerprinted(11600, 'src/a.js', FP('7')));
    append(M.turnEnded(11600));
    append(M.tick(20000));
  });
  assert.deepStrictEqual(fileOdus(odus, 'src/b.js')[0].net_change, { before: 'absent', after: FP('a'), changed: true });
  assert.deepStrictEqual(fileOdus(odus, 'src/a.js')[0].net_change, { before: 'absent', after: FP('7'), changed: true });
});

it("N2b: a rename while the old path's group is still in its grace: that group keeps its own before, and the path is absent after it seals", () => {
  const { odus } = replay((append) => {
    append(M.edited(0, 'c1', 'src/a.js'));
    append(M.fingerprinted(1600, 'src/a.js', FP('b'))); // settled at 1,500 ms; seals at 4,500 ms
    append(M.disk(2000, 'src/b.js', 'renamed', { from: 'src/a.js' }));
    append(M.fingerprinted(3600, 'src/b.js', FP('b')));
    append(M.turnEnded(3600));
    append(M.tick(9000));
    append(M.edited(10000, 'c2', 'src/a.js', 'created', 't2'));
    append(M.fingerprinted(11600, 'src/a.js', FP('e')));
    append(M.turnEnded(11600, 't2'));
    append(M.tick(20000));
  });
  const [first, again] = fileOdus(odus, 'src/a.js');
  assert.deepStrictEqual(first.net_change, { before: FP('a'), after: FP('b'), changed: true });
  assert.deepStrictEqual(fileOdus(odus, 'src/b.js')[0].net_change, { before: 'absent', after: FP('b'), changed: true });
  assert.deepStrictEqual(again.net_change, { before: 'absent', after: FP('e'), changed: true });
});

it('N2: a baseline beside the log that was changed is named as lost evidence, and replay goes on with every first before unknown', () => {
  const { odus, r } = replay(
    (append) => {
      append(M.edited(0, 'c1', 'src/a.js'));
      append(M.fingerprinted(1600, 'src/a.js', FP('b')));
      append(M.turnEnded(1600));
      append(M.tick(9000));
    },
    { after: (dir) => fs.appendFileSync(path.join(dir, 'baseline.jsonl'), '{"path":"planted"}\n') },
  );
  const head = JSON.parse(r.lines[0]);
  assert.deepStrictEqual(head.lost_evidence.map((x) => [x.seq, x.problem]), [[0, 'changed']]);
  assert.deepStrictEqual(fileOdus(odus, 'src/a.js')[0].net_change, { before: null, after: FP('b'), changed: null });
});

it('N2 test 13: the same log replayed twice gives byte-identical odù logs, net change included', () => {
  const base = tmpDir();
  try {
    const log = makeLog(base, {}, { baseline: BASE });
    log.append(M.edited(0, 'c1', 'src/a.js'));
    log.append(M.fingerprinted(1600, 'src/a.js', FP('b')));
    log.append(M.turnEnded(1600));
    log.append(M.tick(9000));
    const a = replayFolder(log.dir);
    const b = replayFolder(log.dir);
    assert.ok(a.odu.includes('"net_change"'));
    assert.strictEqual(a.odu, b.odu);
    assert.strictEqual(a.text, b.text);
  } finally {
    rmrf(base);
  }
});

runAll('net');
