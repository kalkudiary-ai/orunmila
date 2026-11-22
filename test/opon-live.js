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
const { makeLog, M } = require('./helpers-opon');
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

runAll('opon-live');
