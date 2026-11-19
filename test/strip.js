'use strict';

/**
 * test/strip.js — shape-stripped fixtures (Phase 1 slice A9; brief v3 lines
 * 738-744; P1-9; test 50's mark half). The "raw" events below are hand-built in
 * today's shapes with made-up private values; no recorded data.
 */

const { assert, it, runAll } = require('./helpers');
const { stripEvents, leakCheck, relevance } = require('../src/opon/fixtures/strip');

const H = (c) => c.repeat(64);
const RAW = [
  { ts: '2026-11-16T09:00:00.000Z', session_id: 'sess-alice-77', turn_id: 't1', agent: 'claude-code', type: 'user_prompt', text: 'fix the payroll bug for Acme' },
  { ts: '2026-11-16T09:00:01.000Z', session_id: 'sess-alice-77', turn_id: 't1', agent: 'claude-code', source: 'hook', failed: false, call_id: 'toolu_secretcall1', type: 'file_read', path: '/Users/alice/acme-payroll/src/payroll.ts', hash: H('a'), bytes: 812, read_kind: 'full' },
  { ts: '2026-11-16T09:00:02.000Z', session_id: 'sess-alice-77', turn_id: 't1', agent: 'claude-code', source: 'hook', failed: false, call_id: 'toolu_secretcall2', type: 'file_write', path: '/Users/alice/acme-payroll/src/payroll.ts', diff: '--- a\n+++ b\n@@ -1 +1,2 @@\n-const rate = 0.2;\n+const rate = 0.25;\n+// acme override\n' },
  { ts: '2026-11-16T09:00:03.000Z', session_id: 'sess-alice-77', turn_id: 't1', agent: 'claude-code', source: 'hook', failed: true, call_id: 'toolu_secretcall3', type: 'command_run', command: 'npm test -- --grep payrollRate > /tmp/alice-out.txt', exit_code: 1, stdout_excerpt: 'FAIL payroll.test.ts', output_path: null },
  { ts: '2026-11-16T09:00:04.000Z', session_id: 'sess-alice-77', turn_id: 't1', agent: 'claude-code', source: 'hook', failed: false, call_id: 'toolu_secretcall4', type: 'network_call', channel: 'network', tool_name: 'WebFetch', host: 'intranet.acme.example', target: 'https://intranet.acme.example/payroll/rates' },
  { ts: '2026-11-16T09:00:05.000Z', session_id: 'sess-alice-77', turn_id: 't1', agent: 'claude-code', source: 'hook', failed: false, call_id: 'toolu_secretcall5', type: 'tool_call', tool_name: 'mcp__acmedb__query', input: { sql: 'select salary from employees', limit: 5 } },
  { ts: '2026-11-16T09:00:06.000Z', session_id: null, turn_id: null, agent: 'fs-sentinel', source: 'fs-sentinel', type: 'file_write', path: '/Users/alice/acme-payroll/src/payroll.ts', rel_path: 'src/payroll.ts', change_kind: 'modify', hash_before: H('b'), hash_after: H('c'), binary: false, diff: '-const rate = 0.2;\n+const rate = 0.25;\n', failed: false },
  { ts: '2026-11-16T09:00:07.000Z', session_id: null, turn_id: null, agent: 'fs-sentinel', source: 'fs-sentinel', type: 'file_write', path: '/Users/alice/acme-payroll/src/payroll.ts', rel_path: 'src/payroll.ts', change_kind: 'modify', hash_before: H('c'), hash_after: H('d'), binary: false, diff: '', failed: false },
  { ts: '2026-11-16T09:00:08.000Z', session_id: 'sess-alice-77', turn_id: 't1', agent: 'claude-code', type: 'turn_claim', text: 'Fixed the Acme payroll rate.' },
  { ts: '2026-11-16T09:00:08.001Z', session_id: 'sess-alice-77', turn_id: 't1', agent: 'claude-code', type: 'turn_end' },
];
const PRIVATE = ['alice', 'acme', 'payroll', 'payrollRate', 'intranet', 'acmedb', 'salary', 'employees', 'secretcall1', 'sess-alice-77', 'rates', 'override'];

it('no private value survives stripping, anywhere in the output', () => {
  const out = JSON.stringify(stripEvents(RAW).events).toLowerCase();
  for (const p of PRIVATE) assert.ok(!out.includes(p.toLowerCase()), p);
  for (const c of ['a', 'b', 'c', 'd']) assert.ok(!out.includes(H(c)), 'a real fingerprint survived');
});

it('the shape survives: order, timing, counts, sizes, exit statuses, null-means-pass, path and command structure', () => {
  const s = stripEvents(RAW).events;
  assert.strictEqual(s.length, RAW.length);
  for (let i = 0; i < RAW.length; i++) {
    for (const k of ['ts', 'type', 'source', 'agent', 'turn_id', 'failed', 'exit_code', 'read_kind', 'change_kind', 'binary', 'bytes', 'channel']) {
      assert.deepStrictEqual(s[i][k], RAW[i][k], `${i} ${k}`);
    }
  }
  const p = s[1].path;
  assert.strictEqual(p.split('/').length, RAW[1].path.split('/').length, 'same depth');
  assert.ok(p.endsWith('.ts'), 'extension kept');
  assert.strictEqual(s[2].diff.split('\n').length, RAW[2].diff.split('\n').length, 'diff lines kept');
  assert.deepStrictEqual(s[2].diff.split('\n').map((l) => l[0]), RAW[2].diff.split('\n').map((l) => l[0]), 'diff line markers kept');
  assert.strictEqual(s[2].diff.length, RAW[2].diff.length, 'diff size kept');
  const words = s[3].command.split(' ');
  assert.strictEqual(words.length, RAW[3].command.split(' ').length);
  assert.deepStrictEqual([words[0], words[2], words[3], words[5]], ['npm', '--', '--grep', '>'], 'program, flags and operators kept');
  assert.strictEqual(s[0].text.length, RAW[0].text.length, 'prompt length kept, content gone');
  const vals = Object.values(s[5].input);
  assert.deepStrictEqual(vals.map((v) => typeof v), ['string', 'number'], 'input shape kept (keys are placeholders)');
  assert.strictEqual(vals[1], 0, 'numbers in tool input zeroed');
  assert.strictEqual(s[4].tool_name, 'WebFetch', 'a public tool name is kept');
});

it('replacement is consistent: the same real value always becomes the same placeholder, different ones stay different', () => {
  const s = stripEvents(RAW).events;
  assert.strictEqual(s[1].path, s[2].path);
  assert.strictEqual(s[6].path, s[2].path);
  assert.strictEqual(s[6].hash_after, s[7].hash_before, 'a fingerprint chain survives');
  assert.notStrictEqual(s[6].hash_before, s[6].hash_after);
  assert.strictEqual(s[0].session_id, s[9].session_id);
  assert.notStrictEqual(s[1].call_id, s[2].call_id);
  assert.strictEqual(s[4].host, s[4].target.split('/')[2], 'the host in the URL is the host field\'s placeholder');
});

it('A9\'s failing test: the stripper\'s own leak check catches a planted leak (a real path segment put back)', () => {
  const stripped = stripEvents(RAW);
  assert.deepStrictEqual(leakCheck(RAW, stripped), []);
  const planted = JSON.parse(JSON.stringify(stripped.events));
  planted[1].path = planted[1].path.replace(/^\/[^/]+\/[^/]+/, '/Users/alice');
  const leaks = leakCheck(RAW, { ...stripped, events: planted });
  assert.ok(leaks.includes('alice'), JSON.stringify(leaks));
  assert.ok(leaks.includes('users'), 'a word found only in paths is caught too: ' + JSON.stringify(leaks));
});

it('the leak check ignores what is not private: JSON literals, and runs of the mask character itself', () => {
  const raw = [
    ...RAW,
    { ...RAW[3], call_id: 'toolu_secretcall9', command: 'node -e false null true xxxxxxxxxxxx', failed: false, exit_code: null },
    { ...RAW[2], call_id: 'toolu_secretcall10', diff: 'a\n-x\n', stdout_excerpt: 'n-x' }, // JSON writes "\n-x" as \n-x: no word "n-x" exists
  ];
  assert.deepStrictEqual(leakCheck(raw, stripEvents(raw)), []);
});

it('kept words come from public lists only: a private word in an extension or a flag is replaced, not kept', () => {
  const raw = [{ ...RAW[3], command: 'deploytool --tenant-alice --check -x notes.acmepay', call_id: 'c1' }, { ...RAW[1], path: '/w/notes.acmepay', call_id: 'c2' }];
  const s = stripEvents(raw);
  const text = JSON.stringify(s.events).toLowerCase();
  for (const p of ['alice', 'tenant', 'acmepay', 'deploytool']) assert.ok(!text.includes(p), p);
  assert.ok(s.events[0].command.includes(' --check -x '), 'common flags kept');
  assert.ok(!s.kept.has('acmepay') && !s.kept.has('alice'), 'nothing private in the kept vocabulary');
});

it('no raw word is kept by key or name: tool-input keys, unknown tool names, sub-agent types and redaction kinds outside public lists are replaced', () => {
  const raw = [
    { ...RAW[5], call_id: 'k1', input: { acme_payroll_key: 1, nested: [{ alice_var_name: 'v' }] } },
    { ...RAW[5], call_id: 'k2', tool_name: 'AcmeInternalTool', input: {} },
    { ...RAW[4], call_id: 'k3', tool_name: 'AcmeFetcher' },
    { ...RAW[2], call_id: 'k4', sub_agent_id: 'ag1', sub_agent_type: 'acme-payroll-agent', redactions: ['acme_kind', 'github_token'] },
    { ...RAW[5], call_id: 'k5', tool_name: 'WebSearch', input: {}, extra_obj: { aliceconfig: true } },
    { ...RAW[2], call_id: 'k6', sub_agent_id: 'ag2', sub_agent_type: 'general-purpose' },
  ];
  const s = stripEvents(raw);
  const text = JSON.stringify(s.events).toLowerCase();
  for (const p of ['acme', 'alice', 'payroll', 'internaltool', 'fetcher', 'aliceconfig']) assert.ok(!text.includes(p), p);
  for (const p of ['acme', 'alice', 'payroll']) assert.ok(![...s.kept].some((k) => k.includes(p)), `kept: ${p}`);
  assert.strictEqual(s.events[4].tool_name, 'WebSearch', 'a public tool name is kept');
  assert.strictEqual(s.events[5].sub_agent_type, 'general-purpose', 'a public sub-agent type is kept');
  assert.ok(s.events[3].redactions.includes('github_token'), 'a known redaction kind is kept');
  assert.strictEqual(Object.keys(s.events[0].input).length, 2, 'the shape of the input object is kept');
});

it('LD84: every top-level key and every kept field\'s value comes from Orunmila\'s own lists; anything else is a placeholder', () => {
  const raw = [
    { ...RAW[1], call_id: 'm1', acme_tenant: 'x1', agent: 'acme-agent', source: 'acmesource', type: 'acme_type', read_kind: 'acmeread' },
    { ...RAW[6], change_kind: 'acmechange', channel: 'acmechannel', turn_id: 'acme-turn-1', ts: 'acme o clock' },
    { ...RAW[3], call_id: 'm3', failed: 'acmefailed', exit_code: ['acmecode'], bytes: { acmekey: 'acmebytes' } },
    { ...RAW[4], call_id: 'm4', channel: 'acmenet' },
  ];
  const s = stripEvents(raw);
  const text = JSON.stringify(s.events).toLowerCase();
  assert.ok(!text.includes('acme'), text);
  assert.ok(![...s.kept].some((k) => k.includes('acme')), 'nothing private in the kept vocabulary');
  assert.strictEqual(Object.keys(s.events[0]).length, Object.keys(raw[0]).length, 'an unknown key keeps its place, under a placeholder name');
  const s0 = stripEvents(RAW).events;
  for (const [i, k] of [[1, 'agent'], [1, 'source'], [1, 'type'], [1, 'read_kind'], [6, 'change_kind'], [4, 'channel'], [1, 'turn_id'], [1, 'ts']]) {
    assert.strictEqual(s0[i][k], RAW[i][k], `a listed ${k} is kept`);
  }
});

it("LD86: a URL's scheme is kept only from a fixed list, and the leak check reads top-level key names and schemes", () => {
  const raw = [{ ...RAW[4], call_id: 'u1', target: 'zorbscheme://h.test/p' }, { ...RAW[1], call_id: 'u2', zorbkey: 1 }];
  const s = stripEvents(raw);
  const text = JSON.stringify(s.events).toLowerCase();
  assert.ok(!text.includes('zorb'), text);
  assert.ok(![...s.kept].some((k) => k.includes('zorb')), 'nothing private in the kept vocabulary');
  assert.ok(stripEvents(RAW).events[4].target.startsWith('https://'), 'a listed scheme is kept');
  const planted = JSON.parse(JSON.stringify(s.events));
  planted[0].target = 'zorbscheme' + planted[0].target.slice(planted[0].target.indexOf(':'));
  planted[1].zorbkey = 1;
  const leaks = leakCheck(raw, { ...s, events: planted });
  assert.ok(leaks.includes('zorbscheme') && leaks.includes('zorbkey'), JSON.stringify(leaks));
});

it('relevance at the mark level: the stripped events translate to the same marks, kinds and counts as the raw ones', () => {
  const stripped = stripEvents(RAW);
  const r = relevance(RAW, stripped.events);
  assert.strictEqual(r.same, true, JSON.stringify(r));
  assert.ok(r.raw.marks > 0);
  const broken = JSON.parse(JSON.stringify(stripped.events));
  broken[3].failed = false; // a changed exit status is a different fixture
  assert.strictEqual(relevance(RAW, broken).same, false);
});

runAll('strip');
