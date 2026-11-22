'use strict';

/**
 * test/odu.js — the odù record and the odù log, from replay (Phase 3 slice O1,
 * LD167; brief v4 lines 285-333; guarantees 2 and 3; test 13). Hand-built
 * session logs (test/helpers-opon.js); made-up paths.
 */

const { assert, fs, path, ROOT, tmpDir, rmrf, it, runAll } = require('./helpers');
const { makeLog, M, FP } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');
const { oduLog } = require('../src/opon/ledger/odu-log');
const { verifyText } = require('../src/verify/chain');
const { compile } = require('../src/verify/schema');

const schemaOf = (f) => compile(JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', f), 'utf8')));
const withBase = (fn) => () => {
  const base = tmpDir();
  try {
    fn(base);
  } finally {
    rmrf(base);
  }
};
const records = (text) => text.split('\n').slice(0, -1).map((l) => JSON.parse(l));

/** An edit both witnesses saw, a read, and a command with one child, all sealed. */
function busyLog(base) {
  const s = makeLog(base);
  const seq = {};
  seq.edit = [s.append(M.started(0, 'e1', { kind: 'file', path: 'src/a.ts' })), s.append(M.edited(100, 'e1', 'src/a.ts')), s.append(M.disk(300, 'src/a.ts'))];
  seq.read = s.append(M.read(400, 'r1', 'src/b.ts'));
  seq.cmd = [s.append(M.started(500, 'c1', { kind: 'command', text: 'npm install' }, 'Bash'))];
  seq.child = s.append(M.disk(700, 'node_modules/x.js', 'created'));
  seq.cmd.push(s.append(M.exited(900, 'c1', 'npm install')));
  s.append(M.tick(10000));
  return { s, seq };
}

it(
  'O1: replay writes an odù log: a header tied to the raw log, then one odù per sealed group, hash-chained, each valid by spec/odu.schema.json',
  withBase((base) => {
    const { s } = busyLog(base);
    const out = replayFolder(s.dir);
    assert.strictEqual(out.ok, true, out.words);
    assert.deepStrictEqual(verifyText(out.odu), { ok: true, lines: 5 });
    const [head, ...odus] = records(out.odu);
    assert.deepStrictEqual(schemaOf('odu-header.schema.json')(head), []);
    assert.strictEqual(head.record, 'odu_header');
    assert.strictEqual(head.session_id, s.header.session_id);
    const raw = JSON.parse(fs.readFileSync(path.join(s.dir, 'raw.jsonl'), 'utf8').split('\n')[0]);
    assert.strictEqual(head.raw_header, raw.hash, "the odù log names the raw log's header");
    const check = schemaOf('odu.schema.json');
    odus.forEach((o, i) => assert.deepStrictEqual(check(o), [], `odù ${i + 1}`));
    assert.ok(odus.every((o) => o.state === 'sealed'));
    assert.ok(odus.every((o) => o.lease.checked === false && o.lease.inside === null), 'the lease slot, empty, on every odù');
    const none = check({ ...odus[0], mark_seqs: [] });
    assert.deepStrictEqual(none.map((e) => [e.path, e.keyword]), [['/mark_seqs', 'minItems']], 'an odù with no marks cannot exist (guarantee 2)');
  }),
);

it(
  'O1: every odù points to marks that exist (guarantee 2); its witnesses, witness_status, parent and children come from its group',
  withBase((base) => {
    const { s, seq } = busyLog(base);
    const out = replayFolder(s.dir);
    const odus = records(out.odu).slice(1);
    const raw = fs.readFileSync(path.join(s.dir, 'raw.jsonl'), 'utf8').split('\n').slice(1, -1).map((l) => JSON.parse(l));
    const seqs = new Set(raw.map((m) => m.seq));
    for (const o of odus) assert.ok(o.mark_seqs.length && o.mark_seqs.every((n) => seqs.has(n)), o.odu_id);
    const by = (p) => odus.find((o) => o.target && o.target.path === p);
    const edit = by('src/a.ts');
    assert.deepStrictEqual(edit.mark_seqs, seq.edit);
    assert.deepStrictEqual(edit.witnesses, ['hook', 'sentinel']);
    // Q6 (O, yes, LD174): `says` beside each mark's key detail slots (line 331).
    assert.deepStrictEqual(edit.witness_status.glove, {
      status: 'saw',
      mark_seqs: seq.edit.slice(0, 2),
      says: ['started', 'modified'],
      slots: [{ seq: seq.edit[0] }, { seq: seq.edit[1], exit_status: 'pass', fingerprint_before: FP('a'), fingerprint: FP('b') }],
    });
    assert.deepStrictEqual(edit.witness_status.sentinel, { status: 'saw', mark_seqs: [seq.edit[2]], says: ['modified'], slots: [{ seq: seq.edit[2], fingerprint_before: FP('c'), fingerprint: FP('d') }] });
    const read = by('src/b.ts');
    assert.strictEqual(read.action, 'read');
    assert.deepStrictEqual(read.witness_status.sentinel, { status: 'out_of_scope', scope: 'not_a_disk_event', mark_seqs: [] });
    const cmd = odus.find((o) => o.target && o.target.kind === 'command');
    const child = by('node_modules/x.js');
    assert.deepStrictEqual(cmd.children, [child.odu_id]);
    assert.strictEqual(child.parent_id, cmd.odu_id);
    assert.ok(odus.every((o) => o.amends === null && o.continues === null && o.ceiling === false));
  }),
);

it(
  'O1: a continuation names the odù it continues (rule 2); a group not sealed when the log ends is not in the odù log',
  withBase((base) => {
    const s = makeLog(base, { ceiling_ms: 2000 });
    for (let ms = 0; ms <= 3000; ms += 200) s.append(M.disk(ms, 'app.log'));
    s.append(M.tick(9000)); // both sealed
    s.append(M.disk(9100, 'late.txt')); // still open at the end
    const odus = records(replayFolder(s.dir).odu).slice(1);
    assert.deepStrictEqual(odus.map((o) => o.target.path), ['app.log', 'app.log']);
    assert.strictEqual(odus[0].continues, null);
    assert.strictEqual(odus[1].continues, odus[0].odu_id);
    // Q6: the odù says when the ceiling settled it (rule 2); the continuation opened at 2,000 ms meets its own ceiling at 4,000 ms, before its quiet end.
    assert.deepStrictEqual(odus.map((o) => o.ceiling), [true, true]);
    // oduLog itself writes only sealed groups, whatever its caller hands it (the live intake will, L1).
    const out = replayFolder(s.dir);
    const all = out.lines.slice(1).map((l) => JSON.parse(l));
    assert.ok(all.some((g) => g.state !== 'sealed'), 'the log ends with a group still open');
    const raw = fs.readFileSync(path.join(s.dir, 'raw.jsonl'), 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));
    const direct = records(oduLog({ header: raw[0], marks: raw.slice(1), groups: all }).text).slice(1);
    assert.deepStrictEqual(direct.map((o) => o.target.path), ['app.log', 'app.log']);
  }),
);

it(
  'O1: the same raw log replayed twice gives a byte-identical odù log (test 13, guarantee 3)',
  withBase((base) => {
    const { s } = busyLog(base);
    const first = replayFolder(s.dir).odu;
    assert.ok(typeof first === 'string' && first.split('\n').length > 2, 'an odù log with records');
    assert.strictEqual(replayFolder(s.dir).odu, first);
  }),
);

runAll('odu');
