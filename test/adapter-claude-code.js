// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/adapter-claude-code.js — the Claude Code adapter: live hook payloads to
 * marks (Phase 1 slice A8, second half; brief v3 lines 240-268, 336-337;
 * tests 43, 55, 57, 59, 63's mark side; NF54, NF66). Payloads are hand-built in
 * the shapes Claude Code sends (field names as src/capture/agents.js reads
 * them); the file facts a write needs come from the caller, as they will from
 * intake.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { translatePayload } = require('../src/opon/intake/adapters/claude-code');
const { createSessionLog } = require('../src/opon/ledger/session-log');

const HEADERS = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'spec', 'session-headers.json'), 'utf8'));
const SID = HEADERS.good.header.session_id;
const H = (c) => 'sha256:' + c.repeat(64);
const ctx = { turn: 't4', observedAt: '2026-11-16T10:00:00.000Z' };
const base = { session_id: SID, transcript_path: '/tmp/t.jsonl', cwd: '/p' };
const pre = (tool_name, tool_input, extra = {}) => ({ ...base, hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'toolu_9', ...extra });
const post = (tool_name, tool_input, tool_response, extra = {}) => ({ ...base, hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response, tool_use_id: 'toolu_9', ...extra });
const only = (payload, c = ctx) => {
  const r = translatePayload(payload, c);
  assert.deepStrictEqual(r.rejects, []);
  assert.strictEqual(r.marks.length, 1, JSON.stringify(r.marks));
  return r.marks[0];
};

it('a prompt: prompted on the turn; one Claude Code wrote itself (a task notification) is marked as not from the human (NF54)', () => {
  const m = only({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'fix it' }).mark;
  assert.deepStrictEqual([m.says, m.source, m.target, m.detail.prompt, m.detail.from_human], ['prompted', 'hook', { kind: 'turn', id: 't4' }, 'fix it', true]);
  assert.strictEqual(only({ ...base, hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>x' }).mark.detail.from_human, false);
});

it('every tool call gets a started mark before it runs, with its call id and tool name (NF17)', () => {
  for (const [tool, input, kind] of [['Bash', { command: 'npm test' }, 'command'], ['Edit', { file_path: 'src/a.ts' }, 'file'], ['mcp__db__q', { sql: 'x' }, 'tool'], ['WebFetch', { url: 'https://example.com/' }, 'network']]) {
    const m = only(pre(tool, input)).mark;
    assert.strictEqual(m.says, 'started', tool);
    assert.strictEqual(m.target.kind, kind, tool);
    assert.deepStrictEqual([m.cause_hint, m.detail.tool], ['toolu_9', tool]);
  }
});

it('test 43: a Bash result is exit_status pass with no exit_code; a PostToolUseFailure that states no code is fail with no code', () => {
  const ok = only(post('Bash', { command: 'npm test' }, { stdout: 'ok', stderr: '', interrupted: false })).mark;
  assert.deepStrictEqual([ok.says, ok.detail.exit_status, 'exit_code' in ok.detail, ok.detail.output_excerpt], ['exited', 'pass', false, 'ok']);
  const none = only({ ...post('Bash', { command: 'sleep 999' }, {}), hook_event_name: 'PostToolUseFailure', error: 'Command timed out after 2m' }).mark;
  assert.deepStrictEqual([none.says, none.detail.exit_status, 'exit_code' in none.detail, none.detail.output_excerpt], ['exited', 'fail', false, 'Command timed out after 2m']);
});

it('NF22, LD121: a failure that states its code ("Exit code N", either form) carries that code and the output after it; never an invented one', () => {
  const fail = (error) => only({ ...post('Bash', { command: 'npm test' }, {}), hook_event_name: 'PostToolUseFailure', error }).mark.detail;
  assert.deepStrictEqual([fail('Exit code 1').exit_code, fail('Exit code 1').output_excerpt], [1, '']);
  assert.deepStrictEqual([fail('Error: Exit code 2\nFAIL test/a.js').exit_code, fail('Error: Exit code 2\nFAIL test/a.js').output_excerpt], [2, 'FAIL test/a.js']);
  assert.strictEqual(fail('Exit code 3 (killed)').exit_code, undefined, 'a first line that is not exactly the code states none');
  const long = fail('Exit code 4\n' + 'y'.repeat(2500));
  assert.deepStrictEqual([long.exit_code, long.output_excerpt.length], [4, 2000]);
  const r = translatePayload({ ...post('Bash', { command: 'x' }, {}), hook_event_name: 'PostToolUseFailure', error: 'Exit code 4\n' + 'y'.repeat(2500) }, ctx);
  assert.deepStrictEqual(r.marks[0].keep, [{ slot: 'output_ref', text: 'y'.repeat(2500) }]);
});

it('LD94, LD121: a Read records the extent its own result states: full only when the counts show the whole file came back', () => {
  const res = (file) => ({ type: 'text', file: { filePath: 'src/a.ts', content: 'x', ...file } });
  const whole = only(post('Read', { file_path: 'src/a.ts' }, res({ numLines: 40, startLine: 1, totalLines: 40 }))).mark.detail;
  assert.deepStrictEqual([whole.read_kind, whole.read_range], ['full', { asked_offset: null, asked_limit: null, start_line: 1, lines: 40, total_lines: 40 }]);
  const part = only(post('Read', { file_path: 'src/a.ts', offset: 1, limit: 3 }, res({ numLines: 3, startLine: 1, totalLines: 891 }))).mark.detail;
  assert.deepStrictEqual([part.read_kind, part.read_range], ['range', { asked_offset: 1, asked_limit: 3, start_line: 1, lines: 3, total_lines: 891 }]);
  const cut = only(post('Read', { file_path: 'src/a.ts' }, res({ numLines: 40, startLine: 1, totalLines: 40, truncatedByTokenCap: true }))).mark.detail;
  assert.deepStrictEqual([cut.read_kind, cut.read_range.truncated_by_token_cap], ['range', true]);
  const asked = only(post('Read', { file_path: 'src/a.ts', limit: 5 }, {})).mark.detail;
  assert.deepStrictEqual([asked.read_kind, asked.read_range], ['range', { asked_offset: null, asked_limit: 5, start_line: null, lines: null, total_lines: null }]);
  const blind = only(post('Read', { file_path: 'src/a.ts' }, {})).mark.detail;
  assert.deepStrictEqual([blind.read_kind, 'read_range' in blind], [null, false], 'no counts and no bounds: the adapter cannot tell');
});

it('NF66: a command launched in the background, or interrupted, is exit_status unknown, never pass', () => {
  const bg = only(post('Bash', { command: 'npm run soak', run_in_background: true }, { stdout: '', stderr: '' })).mark;
  assert.strictEqual(bg.detail.exit_status, 'unknown');
  assert.strictEqual(bg.detail.background, true);
  const cut = only(post('Bash', { command: 'sleep 99' }, { stdout: '', stderr: '', interrupted: true })).mark;
  assert.strictEqual(cut.detail.exit_status, 'unknown');
  assert.strictEqual(cut.detail.interrupted, true);
});

// VC1 (LD372): the live path's git, pull-request and CI state, as today's capture derives it from a command's output,
// on the command's own exited mark (brief v4 line 267); with the intake's ORUNMILA_VCS_MARKS=1 only, off by default.
it('test 60: git status -sb, then gh pr list --json number,state showing two pull requests: detail.vcs on each exited mark, one entry with the branch, then one per pull request; source hook, never git', () => {
  const on = { ...ctx, vcs: true };
  const st = only(post('Bash', { command: 'git status -sb' }, { stdout: '## main...origin/main\n M src/a.ts\n', stderr: '' }), on).mark;
  assert.deepStrictEqual([st.source, st.says, st.detail.vcs], ['hook', 'exited', [{ type: 'git_state', head_sha: null, branch: 'main' }]]);
  const prs = JSON.stringify([{ number: 12, state: 'OPEN' }, { number: 9, state: 'MERGED' }]);
  const pr = only(post('Bash', { command: 'gh pr list --json number,state' }, { stdout: prs, stderr: '' }), on).mark;
  assert.deepStrictEqual([pr.source, pr.says, pr.detail.vcs], [
    'hook',
    'exited',
    [
      { type: 'pr_state', pr_number: 12, pr_state: 'open', merged_sha: null },
      { type: 'pr_state', pr_number: 9, pr_state: 'merged', merged_sha: null },
    ],
  ]);
  const long = only(post('Bash', { command: 'git log -1 --format=%H' }, { stdout: 'x'.repeat(2100) + '\n' + 'a'.repeat(40), stderr: '' }), on).mark;
  assert.deepStrictEqual(long.detail.vcs, [{ type: 'git_state', head_sha: 'a'.repeat(40), branch: null }], 'read from the whole output, not the excerpt');
});

it('VC1 (LD372): no detail.vcs with the switch off (the default), on a failed command, or on a command that is neither git nor gh', () => {
  const cmd = post('Bash', { command: 'git status -sb' }, { stdout: '## main...origin/main\n', stderr: '' });
  assert.ok(!('vcs' in only(cmd).mark.detail), 'off by default');
  const on = { ...ctx, vcs: true };
  assert.ok(!('vcs' in only({ ...cmd, hook_event_name: 'PostToolUseFailure', error: 'Exit code 128\n## main' }, on).mark.detail), 'a failed command asserts nothing');
  assert.ok(!('vcs' in only(post('Bash', { command: 'echo "## main"' }, { stdout: '## main\n', stderr: '' }), on).mark.detail), 'not git or gh');
});

it('long output: the first 2,000 characters in the mark, the whole output kept beside the log', () => {
  const out = 'x'.repeat(2500);
  const { mark, keep } = only(post('Bash', { command: 'make' }, { stdout: out, stderr: 'warn' }));
  assert.strictEqual(mark.detail.output_excerpt.length, 2000);
  assert.deepStrictEqual(keep, [{ slot: 'output_ref', text: out + '\nwarn' }]);
});

it('a write: created, modified or deleted from the file facts intake measured; unknown facts give modified with the before-state null', () => {
  const facts = (f) => ({ ...ctx, file: f });
  const created = only(post('Write', { file_path: 'src/n.ts' }, {}), facts({ existedBefore: false, existsAfter: true, size: 3, fingerprint: H('2'), diff: '+abc\n', linesAdded: 1, linesRemoved: 0 }));
  assert.strictEqual(created.mark.says, 'created');
  assert.ok(!('fingerprint_before' in created.mark.detail));
  assert.deepStrictEqual(created.keep, [{ slot: 'diff_ref', text: '+abc\n' }]);
  const modified = only(post('Edit', { file_path: 'src/a.ts' }, {}), facts({ existedBefore: true, existsAfter: true, size: 4, fingerprintBefore: H('1'), fingerprint: H('2'), diff: '-a\n+b\n', linesAdded: 1, linesRemoved: 1 })).mark;
  assert.deepStrictEqual([modified.says, modified.detail.fingerprint_before, modified.detail.lines_added], ['modified', H('1'), 1]);
  const deleted = only(post('Write', { file_path: 'src/a.ts' }, {}), facts({ existedBefore: true, existsAfter: false, fingerprintBefore: H('1'), fingerprint: null, diff: '-a\n', linesAdded: 0, linesRemoved: 1 })).mark;
  assert.strictEqual(deleted.says, 'deleted');
  const unknown = only(post('Edit', { file_path: 'src/a.ts' }, {})).mark;
  assert.deepStrictEqual([unknown.says, unknown.detail.fingerprint_before, unknown.detail.lines_added], ['modified', null, null]);
  const failed = only({ ...post('Edit', { file_path: 'src/a.ts' }, {}), hook_event_name: 'PostToolUseFailure', error: 'old_string not found' }).mark;
  assert.deepStrictEqual([failed.says, failed.detail.exit_status], ['ended', 'fail']);
});

it('test 55: a Read with offset or limit is range; one without cannot be shown whole, so null; a search is pattern on its folder', () => {
  const part = only(post('Read', { file_path: 'src/a.ts', offset: 10, limit: 20 }, {}), { ...ctx, file: { size: 900, fingerprint: H('3') } }).mark;
  assert.deepStrictEqual([part.says, part.detail.read_kind, part.detail.size, part.detail.fingerprint], ['read', 'range', 900, H('3')]);
  const whole = only(post('Read', { file_path: 'src/a.ts' }, {})).mark;
  assert.strictEqual(whole.detail.read_kind, null);
  const grep = only(post('Grep', { pattern: 'validateToken', path: 'src' }, {})).mark;
  assert.deepStrictEqual([grep.target, grep.detail.read_kind, grep.detail.pattern], [{ kind: 'dir', path: 'src' }, 'pattern', 'validateToken']);
  const glob = only(post('Glob', { pattern: '**/*.ts' }, {})).mark;
  assert.deepStrictEqual(glob.target, { kind: 'dir', path: '.' });
});

it('test 57: a fetch names its host; a search has host null and the query, never an invented host', () => {
  const f = only(post('WebFetch', { url: 'https://example.com/a?b=1', prompt: 'x' }, {})).mark;
  assert.deepStrictEqual(f.target, { kind: 'network', host: 'example.com', url: 'https://example.com/a?b=1' });
  const s = only(post('WebSearch', { query: 'rfc 8785' }, {})).mark;
  assert.deepStrictEqual(s.target, { kind: 'network', host: null, query: 'rfc 8785' });
});

it('any other tool is called, with its input; a failed one ends', () => {
  const c = only(post('mcp__db__q', { sql: 'select 1' }, { rows: [] })).mark;
  assert.deepStrictEqual([c.says, c.target, c.detail.tool_input], ['called', { kind: 'tool', name: 'mcp__db__q' }, { sql: 'select 1' }]);
  const e = only({ ...post('mcp__db__q', {}, {}), hook_event_name: 'PostToolUseFailure', error: 'boom' }).mark;
  assert.deepStrictEqual([e.says, e.detail.exit_status], ['ended', 'fail']);
});

it('test 59, mark side: a tool call inside a sub-agent carries sub_agent', () => {
  const m = only(post('Edit', { file_path: 'a' }, {}, { agent_id: 'ag_1', agent_type: 'Explore' })).mark;
  assert.deepStrictEqual(m.sub_agent, { id: 'ag_1', type: 'Explore' });
});

it('test 63, mark side: Stop gives the claimed mark (the payload\'s own final text, N10) and the turn\'s ended mark', () => {
  const r = translatePayload({ ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'All done.' }, ctx);
  const [claim, end] = r.marks.map((x) => x.mark);
  assert.deepStrictEqual([claim.source, claim.says, claim.detail.text], ['agent_claim', 'claimed', 'All done.']);
  assert.deepStrictEqual([end.says, end.target], ['ended', { kind: 'turn', id: 't4' }]);
  const none = translatePayload({ ...base, hook_event_name: 'Stop' }, ctx).marks[0].mark;
  assert.deepStrictEqual([none.detail.text, none.detail.claim_unconfirmed], ['', true]);
});

it('LD55: SessionEnd is the session\'s end: ended, target the session, no turn (none is needed), with the reason Claude Code gives', () => {
  const m = only({ ...base, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }, { observedAt: ctx.observedAt }).mark;
  assert.deepStrictEqual([m.source, m.says, m.turn, m.target, m.detail, m.cause_hint], ['hook', 'ended', null, { kind: 'session', id: SID }, { reason: 'prompt_input_exit' }, null]);
  assert.strictEqual(only({ ...base, hook_event_name: 'SessionEnd' }, ctx).mark.turn, null, 'a turn given is not used');
  assert.deepStrictEqual(only({ ...base, hook_event_name: 'SessionEnd' }, ctx).mark.detail, {}, 'no reason given, none written');
});

it('an unknown hook event, or a payload with no turn given, is rejected with a reason, never dropped', () => {
  assert.strictEqual(translatePayload({ ...base, hook_event_name: 'Notification' }, ctx).rejects[0].reason, 'no translation for hook event Notification');
  assert.strictEqual(translatePayload(pre('Bash', { command: 'x' }), { observedAt: ctx.observedAt }).rejects[0].reason, 'no turn given for a Glove mark');
});

it('every translated mark is accepted by the session log', () => {
  const dir = tmpDir();
  try {
    const h = JSON.parse(JSON.stringify(HEADERS.good.header));
    delete h.seq;
    delete h.prev_hash;
    delete h.hash;
    const log = createSessionLog(path.join(dir, 's'), h);
    const payloads = [
      [{ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'go' }, ctx],
      [pre('Bash', { command: 'npm test' }), ctx],
      [post('Bash', { command: 'npm test' }, { stdout: 'x'.repeat(2100), stderr: '' }), ctx],
      [post('Edit', { file_path: 'src/a.ts' }, {}), { ...ctx, file: { existedBefore: true, existsAfter: true, size: 2, fingerprintBefore: H('1'), fingerprint: H('2'), diff: '-a\n+b\n', linesAdded: 1, linesRemoved: 1 } }],
      [post('Read', { file_path: 'src/a.ts' }, {}), ctx],
      [post('Read', { file_path: 'src/a.ts', offset: 1, limit: 3 }, { type: 'text', file: { numLines: 3, startLine: 1, totalLines: 9, truncatedByTokenCap: true } }), ctx],
      [post('Read', { file_path: 'src/a.ts' }, { type: 'text', file: { numLines: 9, startLine: 1, totalLines: 9 } }), ctx],
      [{ ...post('Bash', { command: 'false' }, {}), hook_event_name: 'PostToolUseFailure', error: 'Exit code 1\nno' }, ctx],
      [post('Grep', { pattern: 'x' }, {}), ctx],
      [post('WebSearch', { query: 'q' }, {}), ctx],
      [post('mcp__x', {}, {}), ctx],
      [{ ...base, hook_event_name: 'Stop', last_assistant_message: 'ok' }, ctx],
      [{ ...base, hook_event_name: 'SessionEnd', reason: 'clear' }, ctx],
    ];
    for (const [p, c] of payloads) {
      for (const { mark, keep } of translatePayload(p, c).marks) {
        const res = log.append(mark, keep); // the adapter's keep list goes in with its mark (LD59)
        assert.strictEqual(res.ok, true, `${p.hook_event_name} ${p.tool_name || ''}: ${JSON.stringify(res.reasons)}`);
      }
    }
  } finally {
    rmrf(dir);
  }
});

it("CF1 (LD385): with command facts on, a command's mark names the hosts its text names and that it asked for administrator rights; with them off (the default), neither", () => {
  const facts = { ...ctx, facts: true };
  const run = (command, c = facts, failed = false) => {
    const p = failed ? { ...post('Bash', { command }, {}), hook_event_name: 'PostToolUseFailure', error: 'Exit code 1\nno' } : post('Bash', { command }, { stdout: '', stderr: '' });
    return only(p, c).mark.detail;
  };
  assert.deepStrictEqual(run('curl -s https://api.example.com/v1/x | jq .').hosts, ['api.example.com']);
  assert.deepStrictEqual(run('git clone git@github.com:o/r.git && scp f deploy@host.example:/tmp && wget http://127.0.0.1:8080/a').hosts, ['127.0.0.1:8080', 'github.com', 'host.example']);
  assert.strictEqual(run('npm test').hosts, undefined, 'no host named: no field');
  for (const c of ['sudo rm -rf /x', 'FOO=1 sudo make install', 'cd a && doas cp x y', 'ls; su -c id', 'pkexec true']) assert.strictEqual(run(c).elevated, true, c);
  for (const c of ['echo sudo', 'grep sudo notes.txt', 'npm test']) assert.strictEqual(run(c).elevated, undefined, c);
  assert.strictEqual(run('sudo false', facts, true).elevated, true, 'a failed command still asked for it');
  const off = run('sudo curl https://x.example', ctx);
  assert.deepStrictEqual([off.hosts, off.elevated], [undefined, undefined], 'off by default');
  // The session log accepts them (their fields are in the spec).
  const dir = tmpDir();
  try {
    const h = JSON.parse(JSON.stringify(HEADERS.good.header));
    for (const k of ['seq', 'prev_hash', 'hash']) delete h[k];
    const log = createSessionLog(path.join(dir, 's'), h);
    const { mark } = only(post('Bash', { command: 'sudo curl https://x.example/a' }, { stdout: '', stderr: '' }), facts);
    const res = log.append(mark, []);
    assert.strictEqual(res.ok, true, JSON.stringify(res.reasons));
  } finally {
    rmrf(dir);
  }
});

it("CF2 (LD385): with command facts on, a test run's mark carries its runner's own counts, passed or failed; off (the default), or not a test run, none", () => {
  const facts = { ...ctx, facts: true };
  const tap = '# tests 3\n# pass 2\n# fail 0\n# skipped 1\n# todo 0\n';
  const ok = only(post('Bash', { command: 'npm test' }, { stdout: tap, stderr: '' }), facts).mark.detail;
  assert.deepStrictEqual(ok.test_counts, [{ format: 'node:test', unit: 'tests', passed: 2, failed: 0, skipped: 1, summaries: 1 }]);
  const long = only(post('Bash', { command: 'npx jest' }, { stdout: 'x'.repeat(5000) + '\nTests:       1 failed, 4 passed, 5 total\n', stderr: '' }), facts).mark.detail;
  assert.deepStrictEqual(long.test_counts.map((e) => [e.failed, e.passed]), [[1, 4]], 'read from the whole output, past the excerpt');
  const failed = only({ ...post('npm test', {}, {}), tool_name: 'Bash', tool_input: { command: 'pytest' }, hook_event_name: 'PostToolUseFailure', error: 'Exit code 1\n=== 1 failed, 3 passed in 0.2s ===' }, facts).mark.detail;
  assert.deepStrictEqual(failed.test_counts.map((e) => [e.format, e.failed, e.passed]), [['pytest', 1, 3]]);
  assert.strictEqual(only(post('Bash', { command: 'npm test' }, { stdout: tap, stderr: '' })).mark.detail.test_counts, undefined, 'off by default');
  assert.strictEqual(only(post('Bash', { command: 'cat log' }, { stdout: tap, stderr: '' }), facts).mark.detail.test_counts, undefined, 'not a test run');
  assert.strictEqual(only(post('Bash', { command: 'npm test' }, { stdout: 'fine', stderr: '' }), facts).mark.detail.test_counts, undefined, 'no summary: no field');
  const dir = tmpDir();
  try {
    const h = JSON.parse(JSON.stringify(HEADERS.good.header));
    for (const k of ['seq', 'prev_hash', 'hash']) delete h[k];
    const log = createSessionLog(path.join(dir, 's'), h);
    const res = log.append(only(post('Bash', { command: 'npm test' }, { stdout: tap, stderr: '' }), facts).mark, []);
    assert.strictEqual(res.ok, true, JSON.stringify(res.reasons));
  } finally {
    rmrf(dir);
  }
});

it("CF3 (LD385): with command facts on, the packages the intake measured go on the install's exited mark, passed or failed; off, none", () => {
  const packages = { manager: 'npm', lock: 'package-lock.json', added: [{ name: 'x', version: '1.0.0', install_script: false }], changed: [], removed: [], not_read: [] };
  const p = post('Bash', { command: 'npm i x' }, { stdout: '', stderr: '' });
  assert.deepStrictEqual(only(p, { ...ctx, facts: true, packages }).mark.detail.packages, packages);
  const failed = { ...p, hook_event_name: 'PostToolUseFailure', error: 'Exit code 1\nERR' };
  assert.deepStrictEqual(only(failed, { ...ctx, facts: true, packages }).mark.detail.packages, packages);
  assert.strictEqual(only(p, { ...ctx, packages }).mark.detail.packages, undefined, 'off by default');
});

runAll('adapter-claude-code');
