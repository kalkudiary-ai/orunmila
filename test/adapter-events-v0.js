// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/adapter-events-v0.js — the adapter that translates today's event log
 * (format v0, ~/.orunmila/events.jsonl) into marks (Phase 1 slice A8; brief v3
 * lines 240-268, 336; tests 43, 59, 60's mark side). Events below are
 * hand-built in today's shapes (field names from src/capture/core.js and the
 * Sentinel); no recorded data.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { translateEvents } = require('../src/opon/intake/adapters/events-v0');
const { createSessionLog } = require('../src/opon/ledger/session-log');

const HEADERS = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'spec', 'session-headers.json'), 'utf8'));
const SID = HEADERS.good.header.session_id;
const H = (c) => c.repeat(64);
const g = (over) => ({ ts: '2026-11-16T09:00:00.000Z', session_id: SID, turn_id: 't3', agent: 'claude-code', source: 'hook', failed: false, call_id: 'toolu_01', ...over });
const sentinel = (over) => ({ ts: '2026-11-16T09:00:01.000Z', session_id: null, turn_id: null, agent: 'fs-sentinel', source: 'fs-sentinel', type: 'file_write', path: '/p/src/a.ts', rel_path: 'src/a.ts', failed: false, ...over });
const one = (events, opts = {}) => translateEvents(events, { sessionId: SID, ...opts });

it('test 43: a Claude Code command that passed is exit_status pass with no exit_code; one that failed is fail with no exit_code (today\'s invented 1 dropped)', () => {
  const r = one([
    g({ type: 'command_run', command: 'npm test', exit_code: null, stdout_excerpt: 'ok', output_path: null }),
    g({ type: 'command_run', call_id: 'toolu_02', command: 'npm test', exit_code: 1, failed: true, stdout_excerpt: 'FAIL', output_path: null }),
  ]);
  assert.strictEqual(r.rejects.length, 0, JSON.stringify(r.rejects));
  const [pass, fail] = r.marks.map((x) => x.mark);
  assert.strictEqual(pass.says, 'exited');
  assert.deepStrictEqual(pass.target, { kind: 'command', text: 'npm test' });
  assert.strictEqual(pass.detail.exit_status, 'pass');
  assert.ok(!('exit_code' in pass.detail));
  assert.strictEqual(fail.detail.exit_status, 'fail');
  assert.ok(!('exit_code' in fail.detail), 'NF22: no invented code');
  assert.strictEqual(pass.cause_hint, 'toolu_01');
  assert.strictEqual(pass.detail.tool, 'Bash');
  assert.strictEqual(pass.observed_at, '2026-11-16T09:00:00.000Z');
  assert.ok(!('mono_ns' in pass), 'today\'s records have no monotonic clock: intake stamps it');
});

it('NF22, LD121: a row\'s integer exit code is carried for any agent, except a failed row\'s 1, which capture invents with exact capture off', () => {
  const r = one([
    g({ type: 'command_run', command: 'npm test', exit_code: 2, failed: true, stdout_excerpt: 'FAIL', output_path: null }),
    g({ type: 'command_run', call_id: 'toolu_02', command: 'npm test', exit_code: 1, failed: true, stdout_excerpt: 'FAIL', output_path: null }),
    g({ type: 'command_run', call_id: 'toolu_03', command: 'sleep 9', exit_code: null, failed: true, stdout_excerpt: 'timed out', output_path: null }),
    g({ type: 'command_run', call_id: 'toolu_04', agent: 'cursor', command: 'make', exit_code: 0, stdout_excerpt: '', output_path: null }),
  ]);
  assert.deepStrictEqual(r.marks.map((x) => x.mark.detail.exit_code), [2, undefined, undefined, 0]);
  assert.deepStrictEqual(r.marks.map((x) => x.mark.detail.exit_status), ['fail', 'fail', 'fail', 'pass']);
});

it('LD94, LD121: a read row with exact capture\'s read_range keeps its range or full and the extent; a listing is a listing of its folder', () => {
  const range = { asked_offset: 1, asked_limit: 3, start_line: 1, lines: 3, total_lines: 891 };
  const r = one([
    g({ type: 'file_read', path: 'README.md', hash: H('a'), bytes: 10, read_kind: 'range', read_range: range }),
    g({ type: 'file_read', call_id: 'toolu_02', path: 'a.js', hash: H('b'), bytes: 4, read_kind: 'full', read_range: { asked_offset: null, asked_limit: null, start_line: 1, lines: 2, total_lines: 2 } }),
    g({ type: 'file_read', call_id: 'toolu_03', path: 'a.js', hash: H('b'), bytes: 4, read_kind: 'range', read_range: { ...range, truncated_by_token_cap: true, extra: 'x' } }),
    g({ type: 'file_read', call_id: 'toolu_04', agent: 'cursor', path: 'src', hash: null, bytes: null, read_kind: 'listing' }),
  ]);
  assert.deepStrictEqual(r.rejects, []);
  const [a, b, c, l] = r.marks.map((x) => x.mark);
  assert.deepStrictEqual([a.detail.read_kind, a.detail.read_range, a.detail.fingerprint], ['range', range, 'sha256:' + H('a')]);
  assert.deepStrictEqual([b.detail.read_kind, b.detail.read_range.total_lines], ['full', 2]);
  assert.deepStrictEqual(c.detail.read_range, { ...range, truncated_by_token_cap: true }, 'only the extent\'s own fields are carried');
  assert.deepStrictEqual([l.target, l.detail.read_kind, 'fingerprint' in l.detail, 'read_range' in l.detail], [{ kind: 'dir', path: 'src' }, 'listing', false, false]);
});

it('a command\'s full output kept beside today\'s log becomes a request to keep it; the excerpt stays', () => {
  const r = one([g({ type: 'command_run', command: 'make', exit_code: null, stdout_excerpt: 'x'.repeat(2000), output_path: '/home/u/.orunmila/output/s/toolu_01.txt' })]);
  assert.deepStrictEqual(r.marks[0].keep, [{ slot: 'output_ref', fromFile: '/home/u/.orunmila/output/s/toolu_01.txt' }]);
  assert.strictEqual(r.marks[0].mark.detail.output_excerpt.length, 2000);
});

it('test 60, mark side: git and CI records from a command\'s output go on that command\'s exited mark as detail.vcs, source hook', () => {
  const r = one([
    g({ type: 'command_run', command: 'git status -sb', exit_code: null, stdout_excerpt: '## main', output_path: null }),
    g({ type: 'git_state', branch: 'main', head_sha: 'a'.repeat(40) }),
    g({ type: 'ci_state', ref: 'main', checks: [{ name: 'test', conclusion: 'success' }] }),
  ]);
  assert.strictEqual(r.marks.length, 1);
  const m = r.marks[0].mark;
  assert.strictEqual(m.source, 'hook');
  assert.deepStrictEqual(m.detail.vcs, [
    { type: 'git_state', branch: 'main', head_sha: 'a'.repeat(40) },
    { type: 'ci_state', ref: 'main', checks: [{ name: 'test', conclusion: 'success' }] },
  ]);
  const orphan = one([g({ type: 'git_state', call_id: 'toolu_x', branch: 'main', head_sha: 'b'.repeat(40) })]);
  assert.strictEqual(orphan.rejects.length, 1);
  assert.ok(orphan.rejects[0].reason.includes('no command'), orphan.rejects[0].reason);
});

it('a hook write: modified (today\'s record cannot tell created from modified), before-state unknown, the diff kept beside the log', () => {
  const r = one([g({ type: 'file_write', path: 'src/a.ts', diff: '--- a\n+++ b\n@@\n-x\n+y\n' })]);
  const { mark, keep } = r.marks[0];
  assert.strictEqual(mark.says, 'modified');
  assert.deepStrictEqual(mark.target, { kind: 'file', path: 'src/a.ts' });
  assert.strictEqual(mark.detail.fingerprint_before, null);
  assert.strictEqual(mark.detail.lines_added, null);
  assert.strictEqual(mark.detail.tool, null, 'today\'s write record names no tool');
  assert.deepStrictEqual(keep, [{ slot: 'diff_ref', text: '--- a\n+++ b\n@@\n-x\n+y\n' }]);
  const failed = one([g({ type: 'file_write', path: 'src/a.ts', failed: true, diff: '' })]).marks[0];
  assert.strictEqual(failed.mark.says, 'ended');
  assert.strictEqual(failed.mark.detail.exit_status, 'fail');
  assert.deepStrictEqual(failed.keep, []);
});

it('test 55, mark side: today\'s "full" read is not shown to be whole, so read_kind is null; a pattern read is pattern on the root', () => {
  const r = one([
    g({ type: 'file_read', path: 'src/a.ts', hash: H('a'), bytes: 10, read_kind: 'full' }),
    g({ type: 'file_read', call_id: 'toolu_02', path: 'validateToken', hash: null, bytes: null, read_kind: 'pattern' }),
  ]);
  const [full, pat] = r.marks.map((x) => x.mark);
  assert.strictEqual(full.says, 'read');
  assert.strictEqual(full.detail.read_kind, null);
  assert.strictEqual(full.detail.fingerprint, 'sha256:' + H('a'));
  assert.strictEqual(full.detail.size, 10);
  assert.deepStrictEqual(pat.target, { kind: 'dir', path: '.' });
  assert.strictEqual(pat.detail.read_kind, 'pattern');
  assert.strictEqual(pat.detail.pattern, 'validateToken');
});

it('tool calls, network contacts and a web search', () => {
  const r = one([
    g({ type: 'tool_call', tool_name: 'mcp__db__query', input: { sql: 'select 1' } }),
    g({ type: 'network_call', call_id: 'toolu_02', channel: 'network', tool_name: 'WebFetch', host: 'example.com', target: 'https://example.com/a' }),
    g({ type: 'network_call', call_id: 'toolu_03', channel: 'network', tool_name: 'WebSearch', host: null, target: 'json canonicalization' }),
  ]);
  const [tool, fetch, search] = r.marks.map((x) => x.mark);
  assert.deepStrictEqual(tool.target, { kind: 'tool', name: 'mcp__db__query' });
  assert.strictEqual(tool.says, 'called');
  assert.deepStrictEqual(tool.detail.tool_input, { sql: 'select 1' });
  assert.deepStrictEqual(fetch.target, { kind: 'network', host: 'example.com', url: 'https://example.com/a' });
  assert.deepStrictEqual(search.target, { kind: 'network', host: null, query: 'json canonicalization' });
});

it('turns: a prompt, the closing claim and the stop; test 59, mark side: a sub-agent\'s mark carries it', () => {
  const r = one([
    { ts: '2026-11-16T09:00:00.000Z', session_id: SID, turn_id: 't3', agent: 'claude-code', type: 'user_prompt', text: 'go' },
    { ts: '2026-11-16T09:00:05.000Z', session_id: SID, turn_id: 't3', agent: 'claude-code', type: 'turn_claim', text: 'Done.' },
    { ts: '2026-11-16T09:00:05.001Z', session_id: SID, turn_id: 't3', agent: 'claude-code', type: 'turn_end' },
    g({ type: 'file_write', path: 'src/b.ts', diff: '', sub_agent_id: 'agent_1', sub_agent_type: 'general-purpose' }),
  ]);
  const [p, c, e, w] = r.marks.map((x) => x.mark);
  assert.deepStrictEqual([p.says, p.source, p.detail.prompt, p.target.kind], ['prompted', 'hook', 'go', 'turn']);
  assert.deepStrictEqual([c.says, c.source, c.detail.text, c.target.kind], ['claimed', 'agent_claim', 'Done.', 'claim']);
  assert.deepStrictEqual([e.says, e.target.id], ['ended', 't3']);
  assert.deepStrictEqual(w.sub_agent, { id: 'agent_1', type: 'general-purpose' });
});

it('the Sentinel: created, modified and deleted with their fingerprints, binary as no_diff, source sentinel, turn null', () => {
  const r = one([
    sentinel({ change_kind: 'create', hash_before: null, hash_after: H('1'), binary: false, diff: '+x\n' }),
    sentinel({ change_kind: 'modify', hash_before: H('1'), hash_after: H('2'), binary: false, diff: '--- a\n+++ b\n@@ -1 +1,2 @@\n-x\n+y\n+z\n' }),
    sentinel({ change_kind: 'delete', hash_before: H('2'), hash_after: null, binary: false, diff: '-y\n-z\n' }),
    sentinel({ change_kind: 'modify', hash_before: H('3'), hash_after: H('4'), binary: true, diff: 'Binary file src/a.ts changed (modify).' }),
  ]);
  const [c, m, d, b] = r.marks;
  assert.deepStrictEqual([c.mark.source, c.mark.turn, c.mark.agent, c.mark.session_id], ['sentinel', null, null, SID]);
  assert.strictEqual(c.mark.says, 'created');
  assert.ok(!('fingerprint_before' in c.mark.detail));
  assert.strictEqual(m.mark.says, 'modified');
  assert.deepStrictEqual([m.mark.detail.fingerprint_before, m.mark.detail.fingerprint], ['sha256:' + H('1'), 'sha256:' + H('2')]);
  assert.deepStrictEqual([m.mark.detail.lines_added, m.mark.detail.lines_removed], [2, 1]);
  assert.strictEqual(d.mark.says, 'deleted');
  assert.strictEqual(d.mark.detail.fingerprint, null);
  assert.strictEqual(b.mark.detail.no_diff, 'binary');
  assert.deepStrictEqual(b.keep, []);
  assert.deepStrictEqual(m.keep, [{ slot: 'diff_ref', text: '--- a\n+++ b\n@@ -1 +1,2 @@\n-x\n+y\n+z\n' }]);
});

it('line 249: a plain fingerprint of a file on the redaction list is never carried into a mark', () => {
  const r = one([sentinel({ path: '/p/.env', rel_path: '.env', change_kind: 'modify', hash_before: H('1'), hash_after: H('2'), binary: false, diff: '' })]);
  const d = r.marks[0].mark.detail;
  assert.deepStrictEqual([d.fingerprint_before, d.fingerprint], [null, null]);
  const read = one([g({ type: 'file_read', path: 'config/.env.local', hash: H('5'), bytes: 3, read_kind: 'full' })]).marks[0].mark;
  assert.strictEqual(read.detail.fingerprint, null);
});

it('nothing is dropped: an unknown type, a Sentinel event with no session to give it, and a Glove event with no turn are rejected with reasons', () => {
  const r = translateEvents([g({ type: 'mystery' }), sentinel({ change_kind: 'modify', hash_before: H('1'), hash_after: H('2'), binary: false, diff: '' }), g({ type: 'tool_call', turn_id: null, tool_name: 'x', input: {} })], {});
  assert.strictEqual(r.marks.length + r.rejects.length, 3);
  assert.deepStrictEqual(r.rejects.map((x) => x.reason.split(':')[0]), ['no translation for type mystery', 'no session for a Sentinel record', 'a Glove record with no turn']);
});

it('every translated mark is accepted by the session log (schema, keep requests, intake fields)', () => {
  const events = [
    g({ type: 'command_run', command: 'npm test', exit_code: null, stdout_excerpt: 'ok', output_path: null }),
    g({ type: 'file_write', call_id: 'toolu_02', path: 'src/a.ts', diff: '-a\n+b\n' }),
    g({ type: 'file_read', call_id: 'toolu_03', path: 'src/a.ts', hash: H('a'), bytes: 1, read_kind: 'full' }),
    g({ type: 'file_read', call_id: 'toolu_05', path: 'src/a.ts', hash: H('a'), bytes: 1, read_kind: 'range', read_range: { asked_offset: 2, asked_limit: null, start_line: 2, lines: 1, total_lines: 2, truncated_by_token_cap: true } }),
    g({ type: 'file_read', call_id: 'toolu_06', path: 'src', hash: null, bytes: null, read_kind: 'listing' }),
    g({ type: 'command_run', call_id: 'toolu_07', command: 'false', exit_code: 2, failed: true, stdout_excerpt: '', output_path: null }),
    g({ type: 'tool_call', call_id: 'toolu_04', tool_name: 'mcp__x', input: {} }),
    sentinel({ change_kind: 'modify', hash_before: H('1'), hash_after: H('2'), binary: false, diff: '-a\n+b\n' }),
    { ts: '2026-11-16T09:00:05.000Z', session_id: SID, turn_id: 't3', agent: 'claude-code', type: 'turn_end' },
  ];
  const base = tmpDir();
  try {
    const log = createSessionLog(path.join(base, 's'), (() => {
      const h = JSON.parse(JSON.stringify(HEADERS.good.header));
      delete h.seq;
      delete h.prev_hash;
      delete h.hash;
      return h;
    })());
    for (const { mark, keep } of one(events).marks) {
      const res = log.append(mark, keep); // the adapter's keep list goes in with its mark (LD59)
      assert.strictEqual(res.ok, true, JSON.stringify(res));
    }
  } finally {
    rmrf(base);
  }
});

runAll('adapter-events-v0');
