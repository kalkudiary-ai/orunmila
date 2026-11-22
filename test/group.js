'use strict';

/**
 * test/group.js — grouping keys and each group's witness status (Phase 2
 * slices G1-G2; brief v4 lines 197, 331, 372-379, 411-413; tests 2, 67-70,
 * group half). Hand-built session logs (test/helpers-opon.js); made-up paths.
 */

const { assert, tmpDir, rmrf, it, runAll } = require('./helpers');
const { makeLog, M, ns, wall, SID } = require('./helpers-opon');
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
const at = (g, p) => g.find((x) => x.target && x.target.path === p);

it('test 68: one change both witnesses saw is one group, each witness with its own marks and verbs', withBase((base) => {
  const s = makeLog(base);
  const a = s.append(M.started(0, 'e1', { kind: 'file', path: 'src/a.ts' }));
  const b = s.append(M.edited(50, 'e1', 'src/a.ts'));
  const c = s.append(M.disk(80, 'src/a.ts'));
  s.append(M.tick(20000));
  const g = groups(s.dir);
  assert.strictEqual(g.length, 1);
  assert.deepStrictEqual(g[0].witness_status.glove, { status: 'saw', mark_seqs: [a, b], says: ['started', 'modified'], slots: [{ seq: a }, { seq: b, exit_status: 'pass', fingerprint_before: g[0].witness_status.glove.slots[1].fingerprint_before, fingerprint: g[0].witness_status.glove.slots[1].fingerprint }] });
  assert.strictEqual(g[0].witness_status.sentinel.status, 'saw');
  assert.deepStrictEqual(g[0].witness_status.sentinel.mark_seqs, [c]);
  assert.deepStrictEqual(g[0].witness_status.sentinel.says, ['modified']);
  assert.ok(g[0].witness_status.sentinel.slots[0].fingerprint, 'the fingerprint is in the slots');
}));

it("test 67 (group half): a hand edit only the Sentinel saw: the Glove saw nothing; test 69: a Glove write outside the root: the Sentinel is out of scope", withBase((base) => {
  const s = makeLog(base);
  s.append(M.disk(0, 'notes.md'));
  s.append({ ...M.edited(10, 'e2', '/elsewhere/x.txt'), target: { kind: 'file', path: '/elsewhere/x.txt', outside: true } });
  s.append(M.tick(20000));
  const g = groups(s.dir);
  assert.deepStrictEqual(at(g, 'notes.md').witness_status.glove, { status: 'saw_nothing' });
  assert.deepStrictEqual(at(g, '/elsewhere/x.txt').witness_status.sentinel, { status: 'out_of_scope', scope: 'outside_root' });
}));

it('a Glove write to a path the Sentinel does not watch (the header\'s exclusions) says so: out of scope, excluded', withBase((base) => {
  const s = makeLog(base, { exclusions: ['node_modules/', 'dist/'] });
  s.append(M.edited(0, 'e3', 'node_modules/pkg/index.js'));
  s.append(M.tick(20000));
  assert.deepStrictEqual(groups(s.dir)[0].witness_status.sentinel, { status: 'out_of_scope', scope: 'excluded' });
}));

it('test 70: a read, a web search and an MCP call are one group each, the Sentinel out of scope (not a disk event); two searches of one folder are two', withBase((base) => {
  const s = makeLog(base);
  s.append(M.read(0, 'r1', 'src/a.ts'));
  s.append({ ...M.read(10, 'g1', '.'), target: { kind: 'dir', path: '.' }, detail: { tool: 'Grep', exit_status: 'pass', read_kind: 'pattern', pattern: 'TODO' } });
  s.append({ ...M.read(20, 'g2', '.'), target: { kind: 'dir', path: '.' }, detail: { tool: 'Grep', exit_status: 'pass', read_kind: 'pattern', pattern: 'FIXME' } });
  s.append({ schema_version: 1, session_id: SID, source: 'hook', agent: 'claude-code', turn: 't1', sub_agent: null, observed_at: wall(30), mono_ns: ns(30), cause_hint: 'w1', target: { kind: 'network', host: null, query: 'node streams' }, says: 'contacted', detail: { tool: 'WebSearch', exit_status: 'pass' } });
  s.append({ schema_version: 1, session_id: SID, source: 'hook', agent: 'claude-code', turn: 't1', sub_agent: null, observed_at: wall(40), mono_ns: ns(40), cause_hint: 'm1', target: { kind: 'tool', name: 'mcp__db__query' }, says: 'called', detail: { tool: 'mcp__db__query', exit_status: 'pass', tool_input: { sql: 'select 1' } } });
  s.append(M.tick(20000));
  const g = groups(s.dir);
  assert.strictEqual(g.length, 5);
  assert.deepStrictEqual(g.map((x) => x.action), ['read', 'read', 'read', 'contacted', 'called']);
  for (const x of g) assert.deepStrictEqual(x.witness_status.sentinel, { status: 'out_of_scope', scope: 'not_a_disk_event' });
}));

it("the intake's downtime gap covering a group's time: a witness that recorded nothing is down, never saw-nothing", withBase((base) => {
  const s = makeLog(base);
  s.append(M.edited(1000, 'e4', 'src/z.ts'));
  s.append({ schema_version: 1, session_id: SID, source: 'process', agent: null, turn: null, sub_agent: null, observed_at: wall(2000), mono_ns: ns(2000), cause_hint: null, target: null, says: 'gap', detail: { lost: 'every mark sent to intake while it was not running', since: { mono_ns: ns(500), observed_at: wall(500) }, until: { mono_ns: ns(2000), observed_at: wall(2000) }, sessions: [SID] } });
  s.append(M.tick(20000));
  const z = at(groups(s.dir), 'src/z.ts');
  assert.deepStrictEqual(z.witness_status.sentinel, { status: 'down' });
  assert.strictEqual(z.witness_status.glove.status, 'saw');
}));

it("rule 8 after a merge: a late mark naming the absorbed group's tool call amends the merged group", withBase((base) => {
  const s = makeLog(base);
  s.append(M.disk(0, 'new.txt'));
  s.append(M.edited(10, 'e9', 'old.txt'));
  s.append({ ...M.disk(20, 'new.txt', 'renamed'), detail: { root: '/r', size: 4, from: 'old.txt', fingerprint_before: null, fingerprint: 'sha256:' + 'e'.repeat(64), lines_added: null, lines_removed: null } });
  s.append(M.tick(10000));
  const late = s.append(M.edited(11000, 'e9', 'new.txt'));
  s.append(M.tick(30000));
  const g = groups(s.dir);
  assert.strictEqual(g.length, 2);
  assert.deepStrictEqual(g[1].mark_seqs, [late]);
  assert.strictEqual(g[1].amends, g[0].group_id);
}));

runAll('group');
