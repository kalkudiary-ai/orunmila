'use strict';

/**
 * test/opon-live.js — the Ọpọ́n live in the intake (Phase 3 slice L1, LD166,
 * LD200; brief v4 lines 336, 386, guarantee 3): one engine per held session,
 * fed every record its log takes; a settled change of a file gets a
 * `fingerprinted` mark; sealed groups go to the session's odù log, which must
 * equal replay's byte for byte. Behind ORUNMILA_OPON_LIVE=1 (the router's
 * `baseline` option); with it off nothing changes. Glove and Sentinel joined
 * on every odù asserted (LD182). Hand-built payloads and logs, labelled so
 * (brief line 761): made-up paths in throwaway folders.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { makeLog, M, FP } = require('./helpers-opon');
const { createOpon } = require('../src/opon/settle/engine');
const { replayFolder } = require('../src/opon/replay');
const { oduLog, createOduWriter } = require('../src/opon/ledger/odu-log');
const { canonicalize } = require('../src/verify/canonical');
const { verifyText } = require('../src/verify/chain');

const withBase = (fn) => () => {
  const base = tmpDir();
  try {
    fn(base);
  } finally {
    rmrf(base);
  }
};
const rawRecords = (dir) => fs.readFileSync(path.join(dir, 'raw.jsonl'), 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));

it(
  'L1a: the odù writer, given each sealed group as it seals and each mark\'s source, writes the odù log oduLog writes, byte for byte',
  withBase((base) => {
    const s = makeLog(base);
    s.append(M.started(0, 'e1', { kind: 'file', path: 'src/a.ts' }));
    s.append(M.edited(100, 'e1', 'src/a.ts'));
    s.append(M.disk(300, 'src/a.ts'));
    s.append(M.disk(400, 'src/hand.ts'));
    s.append(M.turnEnded(900));
    s.append(M.tick(10000));
    const out = replayFolder(s.dir);
    assert.strictEqual(out.ok, true, out.words);
    const [header, ...marks] = rawRecords(s.dir);
    const groups = out.lines.slice(1).map((l) => JSON.parse(l));
    const source = new Map(marks.map((m) => [m.seq, m.source]));
    const w = createOduWriter(header);
    const text = [w.head, ...groups.map((g) => w.add(g, (seq) => source.get(seq))).filter(Boolean)].map((r) => canonicalize(r) + '\n').join('');
    assert.strictEqual(text, out.odu);
    assert.strictEqual(text, oduLog({ header, marks, groups }).text);
    assert.deepStrictEqual(verifyText(text), { ok: true, lines: 4 }, 'its own chain, checked apart from oduLog: the header, the edit, the hand edit, the turn');
    const odus = text.split('\n').slice(1, -1).map((l) => JSON.parse(l));
    const of = (p) => odus.find((o) => o.target && o.target.path === p);
    assert.deepStrictEqual([of('src/a.ts').witness_status.glove.status, of('src/a.ts').witness_status.sentinel.status], ['saw', 'saw']);
    assert.deepStrictEqual([of('src/hand.ts').witness_status.glove.status, of('src/hand.ts').witness_status.sentinel.status], ['saw_nothing', 'saw']);
    assert.strictEqual(w.add({ ...groups[0], state: 'open' }, (seq) => source.get(seq)), null, 'a group not sealed is not written');
  }),
);

it(
  'L1b line 386: a change of a file inside the root is due a fingerprint each time it settles with a mark since it last asked, never for its own fingerprint; a read, an excluded path and one outside the root are never due',
  () => {
    const o = createOpon({ sessionId: 'ses_l1b', config: { quiet_window_ms: 1500, lag_grace_ms: 3000, ceiling_ms: 30000, exclusions: ['node_modules'] } });
    let seq = 0;
    const sealed = [];
    const push = (m) => sealed.push(...o.push({ ...m, seq: ++seq }));
    push(M.edited(0, 'e1', 'src/a.ts'));
    push(M.disk(50, 'src/a.ts'));
    push(M.read(0, 'r1', 'src/b.ts'));
    push(M.disk(0, 'node_modules/x.js', 'created'));
    push({ ...M.edited(0, 'e2', '/elsewhere/y.ts'), target: { kind: 'file', path: '/elsewhere/y.ts', outside: true } });
    push(M.turnEnded(100));
    push(M.tick(1000));
    assert.deepStrictEqual(o.fingerprintsDue(), [], 'nothing has settled yet');
    push(M.tick(1600));
    assert.deepStrictEqual(o.fingerprintsDue(), ['src/a.ts']);
    assert.deepStrictEqual(o.fingerprintsDue(), [], 'each ask is given once');
    push(M.fingerprinted(1650, 'src/a.ts', FP('b')));
    push(M.tick(2200));
    assert.deepStrictEqual(o.fingerprintsDue(), [], 'its own fingerprint reopens it until the next step, and does not ask again');
    push(M.disk(2300, 'src/a.ts')); // a slow source's mark in its grace: it opens and settles again, and asks again
    push(M.tick(3900));
    assert.deepStrictEqual(o.fingerprintsDue(), ['src/a.ts']);
    push(M.fingerprinted(3950, 'src/a.ts', FP('c')));
    push(M.tick(9000));
    const a = sealed.find((g) => g.target && g.target.path === 'src/a.ts');
    assert.deepStrictEqual([a.witness_status.glove.status, a.witness_status.sentinel.status, a.net_change.after], ['saw', 'saw', FP('c')]);
    push(M.disk(10000, 'src/a.ts')); // a new event after the seal
    push(M.tick(11600));
    assert.deepStrictEqual(o.fingerprintsDue(), ['src/a.ts']);
  },
);

runAll('opon-live');
