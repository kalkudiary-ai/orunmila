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

it('test 43: a Bash result is exit_status pass with no exit_code; a PostToolUseFailure is fail with no code', () => {
  const ok = only(post('Bash', { command: 'npm test' }, { stdout: 'ok', stderr: '', interrupted: false })).mark;
  assert.deepStrictEqual([ok.says, ok.detail.exit_status, 'exit_code' in ok.detail, ok.detail.output_excerpt], ['exited', 'pass', false, 'ok']);
  const bad = only({ ...post('Bash', { command: 'false' }, {}), hook_event_name: 'PostToolUseFailure', error: 'Exit code 1' }).mark;
  assert.deepStrictEqual([bad.says, bad.detail.exit_status, 'exit_code' in bad.detail], ['exited', 'fail', false]);
});

it('NF66: a command launched in the background, or interrupted, is exit_status unknown, never pass', () => {
  const bg = only(post('Bash', { command: 'npm run soak', run_in_background: true }, { stdout: '', stderr: '' })).mark;
  assert.strictEqual(bg.detail.exit_status, 'unknown');
  assert.strictEqual(bg.detail.background, true);
  const cut = only(post('Bash', { command: 'sleep 99' }, { stdout: '', stderr: '', interrupted: true })).mark;
  assert.strictEqual(cut.detail.exit_status, 'unknown');
  assert.strictEqual(cut.detail.interrupted, true);
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
      [post('Grep', { pattern: 'x' }, {}), ctx],
      [post('WebSearch', { query: 'q' }, {}), ctx],
      [post('mcp__x', {}, {}), ctx],
      [{ ...base, hook_event_name: 'Stop', last_assistant_message: 'ok' }, ctx],
    ];
    for (const [p, c] of payloads) {
      for (const { mark, keep } of translatePayload(p, c).marks) {
        for (const k of keep) mark.detail[k.slot] = log.keep(k.text);
        const res = log.append(mark);
        assert.strictEqual(res.ok, true, `${p.hook_event_name} ${p.tool_name || ''}: ${JSON.stringify(res.reasons)}`);
      }
    }
  } finally {
    rmrf(dir);
  }
});

runAll('adapter-claude-code');
