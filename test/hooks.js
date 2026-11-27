// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/hooks.js
 *
 * End-to-end tests for the Claude Code capture hooks and the CLI. These run the
 * real scripts as child processes (exactly how Claude Code invokes them: JSON on
 * stdin, fast exit), pointed at a throwaway ORUNMILA_HOME, then assert on the
 * events.jsonl they produce. c8 captures child-process coverage automatically
 * via NODE_V8_COVERAGE, so this is what lifts the hooks/CLI off 0%.
 *
 * Run: node test/hooks.js
 */

const { assert, fs, path, tmpHome, tmpDir, rmrf, run, runUntil, it, runAll } = require('./helpers');

const HOOK = (name) => `src/capture/claude-code/${name}`;

function readEvents(home) {
  const p = path.join(home, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// --- user-prompt-submit -----------------------------------------------------

it('user-prompt-submit: logs the prompt text into the turn in flight', () => {
  const home = tmpHome();
  const r = run(HOOK('user-prompt-submit.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({ session_id: 'S', prompt: 'add a login form' }),
  });
  assert.strictEqual(r.status, 0);
  const ev = readEvents(home).find((e) => e.type === 'user_prompt');
  assert.ok(ev, 'user_prompt event written');
  assert.strictEqual(ev.text, 'add a login form');
  assert.strictEqual(ev.turn_id, 't1', 'the first prompt opens t1; a prompt no longer force-bumps');
  rmrf(home);
});

it('user-prompt-submit: invalid JSON on stdin exits 0 without writing', () => {
  const home = tmpHome();
  const r = run(HOOK('user-prompt-submit.js'), { env: { ORUNMILA_HOME: home }, input: 'not json' });
  assert.strictEqual(r.status, 0, 'never blocks the agent over a parse error');
  assert.strictEqual(readEvents(home).length, 0);
  rmrf(home);
});

it('user-prompt-submit: falls back to user_prompt field and "unknown" session', () => {
  const home = tmpHome();
  // no session_id (=> "unknown" branch) and no `prompt` (=> user_prompt fallback)
  const r = run(HOOK('user-prompt-submit.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({ user_prompt: 'legacy field shape' }),
  });
  assert.strictEqual(r.status, 0);
  const ev = readEvents(home).find((e) => e.type === 'user_prompt');
  assert.strictEqual(ev.text, 'legacy field shape', 'user_prompt used when prompt is absent');
  assert.strictEqual(ev.session_id, 'unknown', 'missing session bucketed as unknown');
  rmrf(home);
});

// --- pre-tool-use -----------------------------------------------------------

it('pre-tool-use: snapshots an existing file into the cache slot', () => {
  const home = tmpHome();
  const work = tmpDir();
  const file = path.join(work, 'auth.js');
  fs.writeFileSync(file, 'original contents\n');
  const r = run(HOOK('pre-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({ session_id: 'S', tool_name: 'Edit', tool_input: { file_path: file } }),
  });
  assert.strictEqual(r.status, 0);
  const slot = path.join(home, 'cache', 'S', encodeURIComponent(file) + '.before');
  assert.ok(fs.existsSync(slot), 'before-snapshot cached');
  assert.strictEqual(fs.readFileSync(slot, 'utf8'), 'original contents\n');
  rmrf(home);
  rmrf(work);
});

it('pre-tool-use: a Write to a not-yet-existing file caches an empty "before"', () => {
  const home = tmpHome();
  const work = tmpDir();
  const file = path.join(work, 'brand-new.js'); // does NOT exist yet
  const r = run(HOOK('pre-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({ session_id: 'S', tool_name: 'Write', tool_input: { file_path: file } }),
  });
  assert.strictEqual(r.status, 0);
  const slot = path.join(home, 'cache', 'S', encodeURIComponent(file) + '.before');
  assert.ok(fs.existsSync(slot), 'before-snapshot cached even for a new file');
  assert.strictEqual(fs.readFileSync(slot, 'utf8'), '', 'empty before-state is a legit baseline');
  rmrf(home);
  rmrf(work);
});

it('pre-tool-use: a write tool with no file_path is a safe no-op', () => {
  const home = tmpHome();
  const r = run(HOOK('pre-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({ session_id: 'S', tool_name: 'Edit', tool_input: {} }),
  });
  assert.strictEqual(r.status, 0, 'missing file_path must not crash the hook');
  rmrf(home);
});

it('pre-tool-use: a non-write tool is a no-op; bad JSON exits 0', () => {
  const home = tmpHome();
  const ok = run(HOOK('pre-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({ session_id: 'S', tool_name: 'Read', tool_input: { file_path: '/x' } }),
  });
  assert.strictEqual(ok.status, 0);
  const bad = run(HOOK('pre-tool-use.js'), { env: { ORUNMILA_HOME: home }, input: '{' });
  assert.strictEqual(bad.status, 0);
  rmrf(home);
});

// --- post-tool-use: every channel -------------------------------------------

it('post-tool-use: a Write produces a file_write event with a real diff', () => {
  const home = tmpHome();
  const work = tmpDir();
  const file = path.join(work, 'b.js');
  // seed the before-snapshot the way pre-tool-use would, then write the after
  const slotDir = path.join(home, 'cache', 'S');
  fs.mkdirSync(slotDir, { recursive: true });
  fs.writeFileSync(path.join(slotDir, encodeURIComponent(file) + '.before'), '');
  fs.writeFileSync(file, 'const x = 1;\n');
  const r = run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({ session_id: 'S', tool_name: 'Write', tool_input: { file_path: file }, tool_use_id: 'call1' }),
  });
  assert.strictEqual(r.status, 0);
  const ev = readEvents(home).find((e) => e.type === 'file_write');
  assert.ok(ev, 'file_write written');
  assert.ok(ev.diff.includes('const x = 1;'), 'diff captured');
  assert.strictEqual(ev.failed, false);
  rmrf(home);
  rmrf(work);
});

it('post-tool-use: a Read of a real file carries a content hash + byte size', () => {
  const home = tmpHome();
  const work = tmpDir();
  const file = path.join(work, 'a.js');
  fs.writeFileSync(file, 'hello');
  const r = run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({ session_id: 'S', tool_name: 'Read', tool_input: { file_path: file } }),
  });
  assert.strictEqual(r.status, 0);
  const ev = readEvents(home).find((e) => e.type === 'file_read');
  assert.ok(ev.hash, 'read hashed as a provenance source');
  assert.strictEqual(ev.bytes, 5);
  rmrf(home);
  rmrf(work);
});

it('post-tool-use: a Read of a missing file records a null hash (read failure path)', () => {
  const home = tmpHome();
  const r = run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({ session_id: 'S', tool_name: 'Read', tool_input: { file_path: '/no/such/file.js' } }),
  });
  assert.strictEqual(r.status, 0);
  const ev = readEvents(home).find((e) => e.type === 'file_read');
  assert.strictEqual(ev.hash, null, 'unreadable file => null provenance hash');
  assert.strictEqual(ev.bytes, null);
  rmrf(home);
});

it('post-tool-use: an Edit whose file was deleted records an empty after (deletion path)', () => {
  const home = tmpHome();
  const work = tmpDir();
  const file = path.join(work, 'gone.js');
  // seed a before-snapshot, but never create the after file => after-read fails
  const slotDir = path.join(home, 'cache', 'S');
  fs.mkdirSync(slotDir, { recursive: true });
  fs.writeFileSync(path.join(slotDir, encodeURIComponent(file) + '.before'), 'old = 1;\n');
  const r = run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({ session_id: 'S', tool_name: 'Edit', tool_input: { file_path: file } }),
  });
  assert.strictEqual(r.status, 0);
  const ev = readEvents(home).find((e) => e.type === 'file_write');
  assert.ok(ev, 'file_write recorded even though the file is gone');
  assert.ok(ev.diff.includes('old = 1;'), 'diff shows the removed content');
  rmrf(home);
  rmrf(work);
});

it('post-tool-use: a Write with no cached before-snapshot still diffs (before-read fail)', () => {
  const home = tmpHome();
  const work = tmpDir();
  const file = path.join(work, 'fresh.js');
  fs.writeFileSync(file, 'const a = 1;\n'); // after exists, but NO .before slot
  const r = run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({ session_id: 'S', tool_name: 'Write', tool_input: { file_path: file } }),
  });
  assert.strictEqual(r.status, 0);
  const ev = readEvents(home).find((e) => e.type === 'file_write');
  assert.ok(ev.diff.includes('const a = 1;'), 'missing before-slot => empty before, full add diff');
  rmrf(home);
  rmrf(work);
});

it('post-tool-use: exit code is derived from a success:false response', () => {
  const home = tmpHome();
  const r = run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({
      session_id: 'S',
      tool_name: 'Bash',
      tool_input: { command: 'flaky' },
      tool_response: { success: false },
    }),
  });
  assert.strictEqual(r.status, 0);
  const ev = readEvents(home).find((e) => e.type === 'command_run');
  assert.strictEqual(ev.exit_code, 1, 'success:false maps to exit 1');
  assert.strictEqual(ev.failed, true);
  rmrf(home);
});

it('post-tool-use: exit code is read from a camelCase exitCode field', () => {
  const home = tmpHome();
  const r = run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({
      session_id: 'S',
      tool_name: 'Bash',
      tool_input: { command: 'ok' },
      tool_response: { exitCode: 0, stdout: 'short' },
    }),
  });
  assert.strictEqual(r.status, 0);
  const ev = readEvents(home).find((e) => e.type === 'command_run');
  assert.strictEqual(ev.exit_code, 0, 'exitCode (camelCase) honored');
  assert.strictEqual(ev.output_path, null, 'short output stays inline, no sidecar');
  rmrf(home);
});

it('post-tool-use: an error field with no exit code is treated as a failure', () => {
  const home = tmpHome();
  const r = run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({
      session_id: 'S',
      tool_name: 'Bash',
      tool_input: { command: 'boom' },
      error: 'something broke',
    }),
  });
  assert.strictEqual(r.status, 0);
  const ev = readEvents(home).find((e) => e.type === 'command_run');
  assert.strictEqual(ev.exit_code, 1, 'payload.error implies a non-zero exit');
  rmrf(home);
});

it('post-tool-use: a Grep (pattern read) carries no hash', () => {
  const home = tmpHome();
  const r = run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({ session_id: 'S', tool_name: 'Grep', tool_input: { pattern: 'foo' } }),
  });
  assert.strictEqual(r.status, 0);
  const ev = readEvents(home).find((e) => e.type === 'file_read');
  assert.strictEqual(ev.hash, null, 'pattern read is not a single-file provenance source');
  rmrf(home);
});

it('post-tool-use: a Bash run records command, exit code, and sidecars large output', () => {
  const home = tmpHome();
  const big = 'x'.repeat(2500);
  const r = run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({
      session_id: 'S',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_response: { stdout: big, exit_code: 0 },
      tool_use_id: 'cmd1',
    }),
  });
  assert.strictEqual(r.status, 0);
  const ev = readEvents(home).find((e) => e.type === 'command_run');
  assert.strictEqual(ev.command, 'echo hi');
  assert.strictEqual(ev.exit_code, 0);
  assert.ok(ev.output_path, 'large output sidecar pointer set');
  assert.ok(fs.existsSync(ev.output_path), 'sidecar file written');
  rmrf(home);
});

it('post-tool-use: a WebFetch is captured as a network_call with its host', () => {
  const home = tmpHome();
  const r = run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({
      session_id: 'S',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com/api?q=1' },
    }),
  });
  assert.strictEqual(r.status, 0);
  const ev = readEvents(home).find((e) => e.type === 'network_call');
  assert.strictEqual(ev.host, 'example.com');
  rmrf(home);
});

it('post-tool-use: a tool call inside a sub-agent is attributed to that sub-agent', () => {
  // Claude Code's PostToolUse stdin carries agent_id + agent_type ONLY when the
  // hook fires inside a Task/sidechain. The glove must tag the touch with which
  // sub-agent made it so a parent session shows who actually did what.
  const home = tmpHome();
  const work = tmpDir();
  const file = path.join(work, 'sub.js');
  fs.writeFileSync(file, 'hi');
  const r = run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({
      session_id: 'S',
      tool_name: 'Read',
      tool_input: { file_path: file },
      agent_id: 'agent-42',
      agent_type: 'Explore',
    }),
  });
  assert.strictEqual(r.status, 0);
  const ev = readEvents(home).find((e) => e.type === 'file_read');
  assert.strictEqual(ev.sub_agent_id, 'agent-42', 'sub-agent id captured');
  assert.strictEqual(ev.sub_agent_type, 'Explore', 'sub-agent type captured');
  rmrf(home);
  rmrf(work);
});

it('post-tool-use: a main-thread tool call carries no sub-agent attribution', () => {
  // The inverse: with no agent_id on stdin the touch is the parent's, and the
  // event must stay clean (no sub_agent_* fields) so main-thread work reads plain.
  const home = tmpHome();
  const r = run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({ session_id: 'S', tool_name: 'Read', tool_input: { file_path: '/x' } }),
  });
  assert.strictEqual(r.status, 0);
  const ev = readEvents(home).find((e) => e.type === 'file_read');
  assert.strictEqual(ev.sub_agent_id, undefined, 'no sub_agent_id on a main-thread touch');
  assert.strictEqual(ev.sub_agent_type, undefined, 'no sub_agent_type on a main-thread touch');
  rmrf(home);
});

it('post-tool-use: a WebSearch query (not a URL) keeps a null host', () => {
  const home = tmpHome();
  run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({ session_id: 'S', tool_name: 'WebSearch', tool_input: { query: 'how to test node' } }),
  });
  const ev = readEvents(home).find((e) => e.type === 'network_call');
  assert.strictEqual(ev.host, null, 'a search query has no parseable host');
  rmrf(home);
});

it('post-tool-use: an MCP url tool is detected as network via its input url', () => {
  const home = tmpHome();
  run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({ session_id: 'S', tool_name: 'mcp__server__do', tool_input: { url: 'https://api.test/x' } }),
  });
  const ev = readEvents(home).find((e) => e.type === 'network_call');
  assert.ok(ev && ev.host === 'api.test');
  rmrf(home);
});

it('post-tool-use: an unknown tool falls through to a generic tool_call', () => {
  const home = tmpHome();
  run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({ session_id: 'S', tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } }),
  });
  const ev = readEvents(home).find((e) => e.type === 'tool_call');
  assert.strictEqual(ev.tool_name, 'ExitPlanMode');
  rmrf(home);
});

it('post-tool-use: a PostToolUseFailure payload marks the event failed', () => {
  const home = tmpHome();
  run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({
      session_id: 'S',
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'false' },
      tool_response: { stdout: '', exit_code: 1 },
    }),
  });
  const ev = readEvents(home).find((e) => e.type === 'command_run');
  assert.strictEqual(ev.failed, true);
  assert.strictEqual(ev.exit_code, 1);
  rmrf(home);
});

// --- ORUNMILA_EXACT_CAPTURE: NF22 (exit codes) and LD94 (read extent) --------
// Off by default: live capture writes exactly what it wrote before. On, a
// failed Claude Code command keeps its real exit code and its output, and a
// read records how much of the file the tool returned.

const EXACT = { ORUNMILA_EXACT_CAPTURE: '1' };

// Claude Code's failure payload: no tool_response; the code is the first line
// of `error`, the command's output the rest (hooks page; transcripts show the
// same text with an `Error: ` prefix).
function failedBash(error) {
  return JSON.stringify({
    session_id: 'S', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
    tool_input: { command: 'npm test' }, tool_use_id: 'c1', error,
  });
}

function postOnce(input, env) {
  const home = tmpHome();
  const r = run(HOOK('post-tool-use.js'), { env: Object.assign({ ORUNMILA_HOME: home }, env || {}), input });
  assert.strictEqual(r.status, 0);
  const events = readEvents(home);
  rmrf(home);
  return events;
}

it('NF22 flag off: a failed command is still recorded as exit 1 with no output (unchanged)', () => {
  const ev = postOnce(failedBash('Exit code 2\nsuite failed')).find((e) => e.type === 'command_run');
  assert.strictEqual(ev.failed, true);
  assert.strictEqual(ev.exit_code, 1);
  assert.strictEqual(ev.stdout_excerpt, '');
});

it('NF22 flag on: the exit code comes from the error line, with or without "Error: "', () => {
  const a = postOnce(failedBash('Exit code 2\nsuite failed'), EXACT).find((e) => e.type === 'command_run');
  assert.strictEqual(a.failed, true);
  assert.strictEqual(a.exit_code, 2);
  const b = postOnce(failedBash('Error: Exit code 127\nnpm: not found'), EXACT).find((e) => e.type === 'command_run');
  assert.strictEqual(b.exit_code, 127);
});

it('NF22 flag on: a failed command keeps its output, the code line removed', () => {
  const ev = postOnce(failedBash('Exit code 2\nline one\nline two'), EXACT).find((e) => e.type === 'command_run');
  assert.strictEqual(ev.stdout_excerpt, 'line one\nline two');
});

it('NF22 flag on: no code line means the code was not observed: null, still failed, text kept', () => {
  const ev = postOnce(failedBash('Command timed out after 2m'), EXACT).find((e) => e.type === 'command_run');
  assert.strictEqual(ev.failed, true);
  assert.strictEqual(ev.exit_code, null);
  assert.strictEqual(ev.stdout_excerpt, 'Command timed out after 2m');
});

it('NF22 flag on: a secret in a failed command\'s output is redacted, excerpt and sidecar', () => {
  const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const home = tmpHome();
  const long = 'x'.repeat(2100);
  run(HOOK('post-tool-use.js'), {
    env: Object.assign({ ORUNMILA_HOME: home }, EXACT),
    input: failedBash(`Exit code 1\ntoken ${secret}\n${long}`),
  });
  const ev = readEvents(home).find((e) => e.type === 'command_run');
  assert.ok(!ev.stdout_excerpt.includes(secret), 'excerpt redacted');
  assert.deepStrictEqual(ev.redactions, ['github_token']);
  assert.ok(ev.output_path, 'a long failure output goes to a sidecar');
  assert.ok(!fs.readFileSync(ev.output_path, 'utf8').includes(secret), 'sidecar redacted');
  rmrf(home);
});

it('NF22 flag on: a success payload is unchanged (no exit code given, none invented)', () => {
  const ev = postOnce(JSON.stringify({
    session_id: 'S', hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: 'ls' }, tool_response: { stdout: 'a\n', stderr: '' },
  }), EXACT).find((e) => e.type === 'command_run');
  assert.strictEqual(ev.failed, false);
  assert.strictEqual(ev.exit_code, null);
  assert.strictEqual(ev.stdout_excerpt, 'a\n');
});

function readPayload(input, response, toolName) {
  return JSON.stringify({ session_id: 'S', tool_name: toolName || 'Read', tool_input: input, tool_response: response });
}

it('LD94 flag off: a bounded read is still recorded as full, with no range (unchanged)', () => {
  const ev = postOnce(readPayload({ file_path: '/no/a.js', offset: 5, limit: 10 },
    { type: 'text', file: { filePath: '/no/a.js', content: 'x', numLines: 10, startLine: 5, totalLines: 40 } }))
    .find((e) => e.type === 'file_read');
  assert.strictEqual(ev.read_kind, 'full');
  assert.strictEqual(ev.read_range, undefined);
});

it('LD94 flag on: a read that returned part of the file is a range, asked and returned both recorded', () => {
  const ev = postOnce(readPayload({ file_path: '/no/a.js', offset: 5, limit: 10 },
    { type: 'text', file: { filePath: '/no/a.js', content: 'x', numLines: 10, startLine: 5, totalLines: 40 } }), EXACT)
    .find((e) => e.type === 'file_read');
  assert.strictEqual(ev.read_kind, 'range');
  assert.deepStrictEqual(ev.read_range, { asked_offset: 5, asked_limit: 10, start_line: 5, lines: 10, total_lines: 40 });
});

it('LD94 flag on: a read that returned every line is full, its extent recorded', () => {
  const ev = postOnce(readPayload({ file_path: '/no/a.js' },
    { type: 'text', file: { filePath: '/no/a.js', content: 'x', numLines: 40, startLine: 1, totalLines: 40 } }), EXACT)
    .find((e) => e.type === 'file_read');
  assert.strictEqual(ev.read_kind, 'full');
  assert.deepStrictEqual(ev.read_range, { asked_offset: null, asked_limit: null, start_line: 1, lines: 40, total_lines: 40 });
});

it('LD94 flag on: content cut by the token cap is a range even when the line counts match', () => {
  const ev = postOnce(readPayload({ file_path: '/no/a.js' },
    { type: 'text', file: { filePath: '/no/a.js', content: 'x', numLines: 40, startLine: 1, totalLines: 40, truncatedByTokenCap: true } }), EXACT)
    .find((e) => e.type === 'file_read');
  assert.strictEqual(ev.read_kind, 'range');
  assert.strictEqual(ev.read_range.truncated_by_token_cap, true);
});

it('LD94 flag on: the flat result shape is read too', () => {
  const ev = postOnce(readPayload({ file_path: '/no/a.js' }, { numLines: 3, startLine: 1, totalLines: 9 }), EXACT)
    .find((e) => e.type === 'file_read');
  assert.strictEqual(ev.read_kind, 'range');
  assert.strictEqual(ev.read_range.total_lines, 9);
});

it('LD94 flag on: with no extent in the result, a bounded request is a range and an unbounded one stays full', () => {
  const bounded = postOnce(readPayload({ file_path: '/no/a.js', limit: 10 }, {}), EXACT).find((e) => e.type === 'file_read');
  assert.strictEqual(bounded.read_kind, 'range');
  assert.deepStrictEqual(bounded.read_range, { asked_offset: null, asked_limit: 10, start_line: null, lines: null, total_lines: null });
  const open = postOnce(readPayload({ file_path: '/no/a.js' }, {}), EXACT).find((e) => e.type === 'file_read');
  assert.strictEqual(open.read_kind, 'full');
  assert.strictEqual(open.read_range, undefined, 'nothing known, nothing recorded');
});

it('LD94 flag on: a folder listing is recorded as a listing, never as a read of a file', () => {
  const work = tmpDir();
  const on = postOnce(readPayload({ path: work }, {}, 'list_dir'), EXACT).find((e) => e.type === 'file_read');
  assert.strictEqual(on.read_kind, 'listing');
  assert.strictEqual(on.hash, null);
  const off = postOnce(readPayload({ path: work }, {}, 'list_dir')).find((e) => e.type === 'file_read');
  assert.strictEqual(off.read_kind, 'full', 'flag off: unchanged');
  rmrf(work);
});

it('post-tool-use: invalid JSON exits 0 and writes nothing', () => {
  const home = tmpHome();
  const r = run(HOOK('post-tool-use.js'), { env: { ORUNMILA_HOME: home }, input: 'oops' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(readEvents(home).length, 0);
  rmrf(home);
});

it('post-tool-use: a Write deletes its before-snapshot slot after diffing', () => {
  // The cache slot is a temp pairing for ONE write; leaving it behind would make
  // the next write to the same path diff against a stale "before". Assert cleanup.
  const home = tmpHome();
  const work = tmpDir();
  const file = path.join(work, 'c.js');
  const slotDir = path.join(home, 'cache', 'S');
  fs.mkdirSync(slotDir, { recursive: true });
  const slot = path.join(slotDir, encodeURIComponent(file) + '.before');
  fs.writeFileSync(slot, 'old = 0;\n');
  fs.writeFileSync(file, 'old = 1;\n');
  const r = run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({ session_id: 'S', tool_name: 'Write', tool_input: { file_path: file } }),
  });
  assert.strictEqual(r.status, 0);
  assert.ok(readEvents(home).some((e) => e.type === 'file_write'), 'write recorded');
  assert.ok(!fs.existsSync(slot), 'before-snapshot slot removed after the diff');
  rmrf(home);
  rmrf(work);
});

it('post-tool-use: the tool_use_id is carried onto the event as call_id', () => {
  // call_id is what stitches a pre/post pair and names the output sidecar; if it
  // silently dropped, large-output pointers and cross-event joins would break.
  const home = tmpHome();
  const r = run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({
      session_id: 'S', tool_name: 'Read',
      tool_input: { file_path: '/no/such.js' }, tool_use_id: 'call-xyz',
    }),
  });
  assert.strictEqual(r.status, 0);
  const ev = readEvents(home).find((e) => e.type === 'file_read');
  assert.strictEqual(ev.call_id, 'call-xyz', 'tool_use_id propagated to call_id');
  rmrf(home);
});

it('post-tool-use: a command sidecar appends stderr to stdout and is named by call_id', () => {
  const home = tmpHome();
  const out = 'o'.repeat(1500);
  const err = 'e'.repeat(1500); // stdout+stderr > 2000 forces the sidecar branch
  const r = run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({
      session_id: 'S', tool_name: 'Bash', tool_input: { command: 'build' },
      tool_response: { stdout: out, stderr: err, exit_code: 0 }, tool_use_id: 'cmd-7',
    }),
  });
  assert.strictEqual(r.status, 0);
  const ev = readEvents(home).find((e) => e.type === 'command_run');
  assert.ok(ev.output_path, 'sidecar pointer set for combined output > 2000');
  assert.ok(ev.output_path.includes('cmd-7'), 'sidecar named by call_id');
  const saved = fs.readFileSync(ev.output_path, 'utf8');
  assert.ok(saved.includes(out) && saved.includes(err), 'sidecar holds stdout AND stderr');
  rmrf(home);
});

it('post-tool-use: a large-output command with no call_id still sidecars (timestamp fallback)', () => {
  const home = tmpHome();
  const r = run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({
      session_id: 'S', tool_name: 'Bash', tool_input: { command: 'noisy' },
      tool_response: { stdout: 'z'.repeat(2500), exit_code: 0 }, // no tool_use_id
    }),
  });
  assert.strictEqual(r.status, 0);
  const ev = readEvents(home).find((e) => e.type === 'command_run');
  assert.ok(ev.output_path && fs.existsSync(ev.output_path), 'sidecar still written without a call_id');
  rmrf(home);
});

// --- stop: the reconciliation finale ----------------------------------------

it('stop: writes claim + turn_end events, persists a report, and prints it', () => {
  const home = tmpHome();
  const work = tmpDir();
  // a minimal transcript with a user ask and an assistant claim
  const transcript = path.join(work, 't.jsonl');
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ role: 'user', content: 'add login to auth.js' }),
      JSON.stringify({ role: 'assistant', content: 'I added login to auth.js.' }),
    ].join('\n') + '\n'
  );
  const r = run(HOOK('stop.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({ session_id: 'S', transcript_path: transcript }),
  });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('orunmila'), 'rendered report printed to stdout');
  const events = readEvents(home);
  assert.ok(events.some((e) => e.type === 'turn_claim'), 'claim event written');
  assert.ok(events.some((e) => e.type === 'turn_end'), 'turn_end written');
  assert.ok(events.some((e) => e.type === 'user_prompt'), 'prompt synthesized from transcript');
  assert.ok(fs.existsSync(path.join(home, 'reports', 'S', 't1.json')), 'report persisted');
  rmrf(home);
  rmrf(work);
});

it('stop: bad JSON exits 0', () => {
  const home = tmpHome();
  const r = run(HOOK('stop.js'), { env: { ORUNMILA_HOME: home }, input: 'x' });
  assert.strictEqual(r.status, 0);
  rmrf(home);
});

it('stop: a handler that throws mid-run is swallowed — observe-only never blocks the agent', () => {
  // The observe-only contract: a capture error AFTER a valid JSON parse must
  // never surface to the agent. We force a throw inside handleStop by pointing
  // transcript_path at a directory (readFileSync raises EISDIR), and assert the
  // hook still exits 0 and writes no claim/turn_end — the error is swallowed.
  const home = tmpHome();
  const work = tmpDir(); // a real directory, used as a bogus "transcript file"
  const r = run(HOOK('stop.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({ session_id: 'S', transcript_path: work }),
  });
  assert.strictEqual(r.status, 0, 'a thrown handler still exits 0');
  rmrf(home);
  rmrf(work);
});

// --- bin/orunmila CLI -------------------------------------------------------

function cli(args, env) {
  return run('bin/orunmila.js', { args, env, input: '' });
}

it('cli: no command prints usage and exits 0', () => {
  const r = cli([], {});
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('Usage:'));
});

it('cli: an unknown command prints usage and exits 1', () => {
  const r = cli(['frobnicate'], {});
  assert.strictEqual(r.status, 1);
  assert.ok(r.stdout.includes('Usage:'));
});

it('cli: status reports counts and the sentinel ignore list', () => {
  const home = tmpHome();
  // seed one event so status has something to count
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'events.jsonl'), JSON.stringify({ session_id: 'S', type: 'file_read' }) + '\n');
  const r = cli(['status'], { ORUNMILA_HOME: home });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('Events captured: 1'));
  assert.ok(r.stdout.includes('ignore list'));
  rmrf(home);
});

it('cli: status reports the log size in KB', () => {
  const home = tmpHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'events.jsonl'), JSON.stringify({ session_id: 'S', type: 'file_read' }) + '\n');
  const r = cli(['status'], { ORUNMILA_HOME: home });
  assert.strictEqual(r.status, 0);
  assert.ok(/Log size: \d+ KB/.test(r.stdout), 'status prints the log size');
  rmrf(home);
});

it('cli: prune caps the log to the N most-recent sessions', () => {
  const home = tmpHome();
  fs.mkdirSync(home, { recursive: true });
  const lines = [
    { session_id: 'old', turn_id: 't1', type: 'file_read' },
    { session_id: 'mid', turn_id: 't1', type: 'file_read' },
    { session_id: 'new', turn_id: 't1', type: 'file_read' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(home, 'events.jsonl'), lines);
  const r = cli(['prune', '--keep', '1'], { ORUNMILA_HOME: home });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('Pruned 2 old session(s)'), 'reports how many it dropped');
  const survivors = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(survivors.length, 1, 'only the newest session survives');
  assert.strictEqual(survivors[0].session_id, 'new');
  rmrf(home);
});

it('cli: prune is a no-op when there are fewer sessions than --keep', () => {
  const home = tmpHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'events.jsonl'), JSON.stringify({ session_id: 'only', turn_id: 't1', type: 'file_read' }) + '\n');
  const r = cli(['prune', '--keep', '20'], { ORUNMILA_HOME: home });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('Nothing to prune'), 'no-op message when under the cap');
  rmrf(home);
});

it('cli: install merges hooks into a local .claude/settings.json and is idempotent', () => {
  const home = tmpHome();
  const work = tmpDir();
  // install writes to <cwd>/.claude/settings.json, so run it inside the work dir.
  const r = run('bin/orunmila.js', { args: ['install'], env: { ORUNMILA_HOME: home }, cwd: work });
  assert.strictEqual(r.status, 0);
  const settings = JSON.parse(fs.readFileSync(path.join(work, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.hooks.Stop, 'Stop hook installed');
  assert.ok(settings.hooks.PostToolUse, 'PostToolUse hook installed');
  const before = settings.hooks.PostToolUse.length;
  run('bin/orunmila.js', { args: ['install'], env: { ORUNMILA_HOME: home }, cwd: work });
  const after = JSON.parse(fs.readFileSync(path.join(work, '.claude', 'settings.json'), 'utf8'));
  assert.strictEqual(after.hooks.PostToolUse.length, before, 'install is idempotent');
  rmrf(home);
  rmrf(work);
});

it('cli: report / html / trail run end to end against a captured session', () => {
  const home = tmpHome();
  const work = tmpDir();
  // Build a session by replaying hooks, so reports exist for report/html/trail.
  run(HOOK('user-prompt-submit.js'), { env: { ORUNMILA_HOME: home }, input: JSON.stringify({ session_id: 'S', prompt: 'write a.js' }) });
  const f = path.join(work, 'a.js');
  fs.writeFileSync(f, 'const a = 1;\n');
  const slotDir = path.join(home, 'cache', 'S');
  fs.mkdirSync(slotDir, { recursive: true });
  fs.writeFileSync(path.join(slotDir, encodeURIComponent(f) + '.before'), '');
  run(HOOK('post-tool-use.js'), { env: { ORUNMILA_HOME: home }, input: JSON.stringify({ session_id: 'S', tool_name: 'Write', tool_input: { file_path: f } }) });
  const transcript = path.join(work, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ role: 'assistant', content: 'I wrote a.js.' }) + '\n');
  run(HOOK('stop.js'), { env: { ORUNMILA_HOME: home }, input: JSON.stringify({ session_id: 'S', transcript_path: transcript }) });

  const rep = cli(['report', '--session', 'S'], { ORUNMILA_HOME: home });
  assert.strictEqual(rep.status, 0);
  assert.ok(rep.stdout.includes('orunmila'));

  const out1 = path.join(work, 'r.html');
  const html = cli(['html', '--session', 'S', '--out', out1], { ORUNMILA_HOME: home });
  assert.strictEqual(html.status, 0);
  assert.ok(fs.existsSync(out1), 'html report written');

  const out2 = path.join(work, 'g.html');
  const trail = cli(['trail', '--session', 'S', '--out', out2], { ORUNMILA_HOME: home });
  assert.strictEqual(trail.status, 0);
  assert.ok(fs.existsSync(out2), 'trail report written');
  assert.ok(trail.stdout.includes('Trail'), 'trail totals printed');

  // "the glove" is the user-facing name kept as an alias of the trail command.
  const out3 = path.join(work, 'g2.html');
  const glove = cli(['glove', '--session', 'S', '--out', out3], { ORUNMILA_HOME: home });
  assert.strictEqual(glove.status, 0, 'glove alias still works');
  assert.ok(fs.existsSync(out3), 'glove alias writes the same report');
  rmrf(home);
  rmrf(work);
});

it('cli: report/html/trail with no sessions print the empty-state message', () => {
  const home = tmpHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'events.jsonl'), '');
  for (const c of ['report', 'html', 'trail', 'glove']) {
    const r = cli([c], { ORUNMILA_HOME: home });
    assert.strictEqual(r.status, 0, `${c} exits 0 on empty`);
    assert.ok(r.stdout.includes('No sessions captured yet'), `${c} prints empty state`);
  }
  rmrf(home);
});

it('cli: report --turn for a missing turn is handled', () => {
  const home = tmpHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'events.jsonl'), JSON.stringify({ session_id: 'S', type: 'file_read' }) + '\n');
  const r = cli(['report', '--session', 'S', '--turn', 't9'], { ORUNMILA_HOME: home });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('No report'));
  rmrf(home);
});

it('cli: report --turn for an existing turn renders just that turn', () => {
  const home = tmpHome();
  const work = tmpDir();
  // Build a real session so a persisted report for t1 exists.
  run(HOOK('user-prompt-submit.js'), { env: { ORUNMILA_HOME: home }, input: JSON.stringify({ session_id: 'S', prompt: 'write a.js' }) });
  const f = path.join(work, 'a.js');
  fs.writeFileSync(f, 'const a = 1;\n');
  const slotDir = path.join(home, 'cache', 'S');
  fs.mkdirSync(slotDir, { recursive: true });
  fs.writeFileSync(path.join(slotDir, encodeURIComponent(f) + '.before'), '');
  run(HOOK('post-tool-use.js'), { env: { ORUNMILA_HOME: home }, input: JSON.stringify({ session_id: 'S', tool_name: 'Write', tool_input: { file_path: f } }) });
  const tr = path.join(work, 't.jsonl');
  fs.writeFileSync(tr, JSON.stringify({ role: 'assistant', content: 'I wrote a.js.' }) + '\n');
  run(HOOK('stop.js'), { env: { ORUNMILA_HOME: home }, input: JSON.stringify({ session_id: 'S', transcript_path: tr }) });

  // A prompt no longer force-bumps, so the whole exchange -- work and claim --
  // lands in t1 together.
  const r = cli(['report', '--session', 'S', '--turn', 't1'], { ORUNMILA_HOME: home });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('orunmila'), 'the single-turn report renders');
  rmrf(home);
  rmrf(work);
});

// --- watch / watch-fs: the long-running observers ---------------------------
// These never exit on their own; runUntil lets them boot + tick, then SIGINTs
// them through their own shutdown handler.

it('cli: watch-fs boots the sentinel, prints a banner, and stops cleanly on SIGINT', () => {
  const home = tmpHome();
  const work = tmpDir();
  const r = runUntil('bin/orunmila.js', { args: ['watch-fs', '--root', work], env: { ORUNMILA_HOME: home }, ms: 1500 });
  assert.ok(r.stdout.includes('Filesystem Sentinel on'), 'startup banner printed');
  rmrf(home);
  rmrf(work);
});

it('cli: watch boots the combined observer and tails new turn reports', () => {
  const home = tmpHome();
  const work = tmpDir();
  // seed a persisted report so the watch tick has something to print
  run(HOOK('user-prompt-submit.js'), { env: { ORUNMILA_HOME: home }, input: JSON.stringify({ session_id: 'S', prompt: 'write a.js' }) });
  const f = path.join(work, 'a.js');
  fs.writeFileSync(f, 'const a = 1;\n');
  const slotDir = path.join(home, 'cache', 'S');
  fs.mkdirSync(slotDir, { recursive: true });
  fs.writeFileSync(path.join(slotDir, encodeURIComponent(f) + '.before'), '');
  run(HOOK('post-tool-use.js'), { env: { ORUNMILA_HOME: home }, input: JSON.stringify({ session_id: 'S', tool_name: 'Write', tool_input: { file_path: f } }) });
  const tr = path.join(work, 't.jsonl');
  fs.writeFileSync(tr, JSON.stringify({ role: 'assistant', content: 'I wrote a.js.' }) + '\n');
  run(HOOK('stop.js'), { env: { ORUNMILA_HOME: home }, input: JSON.stringify({ session_id: 'S', transcript_path: tr }) });

  const r = runUntil('bin/orunmila.js', { args: ['watch', '--root', work], env: { ORUNMILA_HOME: home }, ms: 2200 });
  assert.ok(r.stdout.includes('Watching for new turn reports'), 'watch banner printed');
  assert.ok(r.stdout.includes('orunmila'), 'the tick rendered the seeded report');
  rmrf(home);
  rmrf(work);
});

/** F20: one real turn report for session S in `home` (the hooks, as in the case above); returns the report file. */
function seedWatchReport(home, work) {
  run(HOOK('user-prompt-submit.js'), { env: { ORUNMILA_HOME: home }, input: JSON.stringify({ session_id: 'S', prompt: 'write a.js' }) });
  const f = path.join(work, 'a.js');
  fs.writeFileSync(f, 'const a = 1;\n');
  const slotDir = path.join(home, 'cache', 'S');
  fs.mkdirSync(slotDir, { recursive: true });
  fs.writeFileSync(path.join(slotDir, encodeURIComponent(f) + '.before'), '');
  run(HOOK('post-tool-use.js'), { env: { ORUNMILA_HOME: home }, input: JSON.stringify({ session_id: 'S', tool_name: 'Write', tool_input: { file_path: f } }) });
  const tr = path.join(work, 't.jsonl');
  fs.writeFileSync(tr, JSON.stringify({ role: 'assistant', content: 'I wrote a.js.' }) + '\n');
  run(HOOK('stop.js'), { env: { ORUNMILA_HOME: home }, input: JSON.stringify({ session_id: 'S', transcript_path: tr }) });
  const report = path.join(home, 'reports', 'S', 't1.json');
  assert.ok(fs.existsSync(report), 'the hooks wrote the turn report');
  return report;
}
const WATCH_HEADER = '=== orunmila: session S / turn t1 ===';
const countOf = (text, s) => text.split(s).length - 1;

it('F20: watch keeps running when the event log holds the disk watcher\'s rows (session_id null), and prints each report once', () => {
  const home = tmpHome();
  const work = tmpDir();
  seedWatchReport(home, work);
  // A row of the shape src/capture/fs-sentinel/index.js writes: it knows no session, so session_id is null. `watch`
  // starts that Sentinel itself, so any change on disk while it runs puts such a row in the log.
  const row = { ts: new Date().toISOString(), session_id: null, turn_id: null, agent: 'fs-sentinel', source: 'fs-sentinel', type: 'file_write', path: path.join(work, 'b.js'), rel_path: 'b.js', diff: '', hash_before: null, hash_after: 'x', binary: false, change_kind: 'created', failed: false };
  fs.appendFileSync(path.join(home, 'events.jsonl'), JSON.stringify(row) + '\n');
  const r = runUntil('bin/orunmila.js', { args: ['watch', '--root', work], env: { ORUNMILA_HOME: home }, ms: 4000 }); // two ticks (1.5 s, 3 s)
  try {
    assert.ok(r.timedOut, `watch was still running when stopped (it ended on its own, exit ${r.status}): ${r.stderr.split('\n').slice(0, 6).join(' | ')}`);
    assert.strictEqual(countOf(r.stdout, WATCH_HEADER), 1, 'the seeded report printed once over two ticks');
  } finally {
    rmrf(home);
    rmrf(work);
  }
});

it('F20: watch keeps running past a report caught half-written, and prints it once it is whole', async () => {
  const { spawn } = require('child_process');
  const home = tmpHome();
  const work = tmpDir();
  const report = seedWatchReport(home, work);
  const whole = fs.readFileSync(report, 'utf8');
  fs.writeFileSync(report, whole.slice(0, Math.floor(whole.length / 2))); // as a reader can find a report mid-write
  const child = spawn('node', [path.join(__dirname, '..', 'bin', 'orunmila.js'), 'watch', '--root', work], { env: { ...process.env, ORUNMILA_HOME: home } });
  let out = '';
  let err = '';
  let exited = null;
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.on('exit', (code, signal) => (exited = { code, signal }));
  const waitFor = async (ok, ms) => {
    for (const end = Date.now() + ms; Date.now() < end && !ok(); ) await new Promise((res) => setTimeout(res, 50));
    return ok();
  };
  try {
    assert.ok(await waitFor(() => out.includes('Watching for new turn reports') || exited, 8000), 'watch printed its banner');
    await new Promise((res) => setTimeout(res, 3400)); // two ticks (1.5 s, 3 s) read the half-written report
    assert.strictEqual(exited, null, `watch was still running after reading a half-written report: ${err.split('\n').slice(0, 6).join(' | ')}`);
    assert.strictEqual(countOf(out, WATCH_HEADER), 0, 'nothing printed for a report it could not read');
    fs.writeFileSync(report, whole);
    assert.ok(await waitFor(() => out.includes(WATCH_HEADER) || exited, 6000), 'the whole report printed on a later tick');
    await new Promise((res) => setTimeout(res, 1700)); // one more tick: no second print
    assert.strictEqual(exited, null, 'still running');
    assert.strictEqual(countOf(out, WATCH_HEADER), 1, 'printed once');
    assert.strictEqual(countOf(err, 'the report S/t1.json could not be read yet'), 1, 'the half-written report named once on stderr, never silently skipped');
  } finally {
    if (exited === null) {
      child.kill('SIGINT');
      await waitFor(() => exited, 5000);
    }
    rmrf(home);
    rmrf(work);
  }
});

it('cli: the fs-sentinel module run directly boots and stops on SIGINT', () => {
  const home = tmpHome();
  const work = tmpDir();
  // Run src/capture/fs-sentinel/index.js as its own process (its main() entry),
  // passing the root as argv[2]; runUntil SIGINTs it through its shutdown path.
  const r = runUntil('src/capture/fs-sentinel/index.js', { args: [work], env: { ORUNMILA_HOME: home }, ms: 1500 });
  assert.ok((r.stderr + r.stdout).includes('[fs-sentinel] watching'), 'sentinel main() booted');
  rmrf(home);
  rmrf(work);
});

it('cli: debug-transcript dumps parsed lines, and warns with no path', () => {
  const home = tmpHome();
  const work = tmpDir();
  const t = path.join(work, 't.jsonl');
  fs.writeFileSync(t, [JSON.stringify({ role: 'user', content: 'hi' }), JSON.stringify({ role: 'assistant', content: 'done' })].join('\n') + '\n');
  const r = cli(['debug-transcript', t], { ORUNMILA_HOME: home });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('raw lines parsed'));
  const r2 = cli(['debug-transcript'], { ORUNMILA_HOME: home });
  assert.ok(r2.stdout.includes('Usage'));
  rmrf(home);
  rmrf(work);
});

// --- the two lenses --------------------------------------------------------
// The Stain Map (capture + report) and the Closeout Gate (the law layer on
// Stop) are separate products with separate install paths. These lock the
// separation itself: that one can exist without the other, that the original
// --with-laws spelling keeps working, and that the CLI can tell you which you
// have without you reading a config file by hand.

/** Read the hook commands registered in a work dir's settings, flattened. */
function hookCommands(work) {
  const p = path.join(work, '.claude', 'settings.json');
  if (!fs.existsSync(p)) return [];
  const settings = JSON.parse(fs.readFileSync(p, 'utf8'));
  const out = [];
  for (const [event, entries] of Object.entries(settings.hooks || {})) {
    for (const entry of entries || []) {
      for (const h of (entry && entry.hooks) || []) out.push({ event, command: String(h.command || '') });
    }
  }
  return out;
}
const hasStainMap = (work) => hookCommands(work).some((h) => h.command.includes('post-tool-use.js'));
const hasGate = (work) => hookCommands(work).some((h) => h.command.includes('law-gate.js'));

it('lenses: install alone installs the Stain Map and NOT the Closeout Gate', () => {
  const home = tmpHome();
  const work = tmpDir();
  const r = run('bin/orunmila.js', { args: ['install'], env: { ORUNMILA_HOME: home }, cwd: work });
  assert.strictEqual(r.status, 0);
  assert.ok(hasStainMap(work), 'Stain Map installed');
  assert.ok(!hasGate(work), 'the gate is NOT installed by default — it can refuse a turn, so it is opt-in');
  assert.ok(r.stdout.includes('Closeout Gate'), 'the second lens is advertised, not hidden');
  rmrf(home);
  rmrf(work);
});

it('lenses: install --with-gate installs both', () => {
  const home = tmpHome();
  const work = tmpDir();
  const r = run('bin/orunmila.js', { args: ['install', '--with-gate'], env: { ORUNMILA_HOME: home }, cwd: work });
  assert.strictEqual(r.status, 0);
  assert.ok(hasStainMap(work), 'Stain Map installed');
  assert.ok(hasGate(work), 'Closeout Gate installed');
  assert.ok(r.stdout.includes('CAN STOP A TURN'), 'the blocking laws are read out at install time');
  rmrf(home);
  rmrf(work);
});

it('lenses: --with-laws is still accepted as the original spelling of --with-gate', () => {
  const home = tmpHome();
  const work = tmpDir();
  const r = run('bin/orunmila.js', { args: ['install', '--with-laws'], env: { ORUNMILA_HOME: home }, cwd: work });
  assert.strictEqual(r.status, 0, '--with-laws must never break: it is in instructions people already followed');
  assert.ok(hasStainMap(work) && hasGate(work), 'both lenses installed via the old flag');
  rmrf(home);
  rmrf(work);
});

it('lenses: --gate-only adds the gate, leaves capture untouched, and says the gate has nothing to judge', () => {
  const home = tmpHome();
  const work = tmpDir();
  const r = run('bin/orunmila.js', { args: ['install', '--gate-only'], env: { ORUNMILA_HOME: home }, cwd: work });
  assert.strictEqual(r.status, 0);
  assert.ok(hasGate(work), 'gate installed');
  assert.ok(!hasStainMap(work), '--gate-only does not install capture');
  assert.ok(
    r.stdout.includes('nothing to read') || r.stdout.includes('NOT installed'),
    'warns that a gate with no Stain Map under it judges nothing'
  );
  rmrf(home);
  rmrf(work);
});

it('lenses: --with-gate over an existing Stain Map adds the gate without duplicating capture', () => {
  const home = tmpHome();
  const work = tmpDir();
  run('bin/orunmila.js', { args: ['install'], env: { ORUNMILA_HOME: home }, cwd: work });
  const captureBefore = hookCommands(work).filter((h) => h.command.includes('post-tool-use.js')).length;
  const r = run('bin/orunmila.js', { args: ['install', '--with-gate'], env: { ORUNMILA_HOME: home }, cwd: work });
  assert.strictEqual(r.status, 0, 'adding the second lens is a success, not a refusal');
  const captureAfter = hookCommands(work).filter((h) => h.command.includes('post-tool-use.js')).length;
  assert.strictEqual(captureAfter, captureBefore, 'capture is not registered twice (the dual-install corruption)');
  assert.ok(hasGate(work), 'gate added');
  assert.ok(
    !r.stdout.includes('Remove the existing registration first') && !r.stderr.includes('Remove the existing registration first'),
    'does not tell the user to remove an install on a run that succeeded'
  );
  rmrf(home);
  rmrf(work);
});

it('lenses: a second plain install never doubles a hook: over this home\'s starter it is an upgrade (F19, LD336); from another copy it is refused with a non-zero exit', () => {
  const home = tmpHome();
  const work = tmpDir();
  run('bin/orunmila.js', { args: ['install'], env: { ORUNMILA_HOME: home }, cwd: work });
  const settings = () => fs.readFileSync(path.join(work, '.claude', 'settings.json'), 'utf8');
  const once = settings();
  const same = run('bin/orunmila.js', { args: ['install'], env: { ORUNMILA_HOME: home }, cwd: work });
  assert.strictEqual(same.status, 0, same.stdout + same.stderr);
  assert.ok(same.stdout.includes('already installed'), same.stdout);
  assert.strictEqual(settings(), once, 'no hook added: one registration');
  const other = tmpHome(); // another Orunmila home: its starter is another copy, as two installs of two copies are
  const r = run('bin/orunmila.js', { args: ['install'], env: { ORUNMILA_HOME: other }, cwd: work });
  assert.notStrictEqual(r.status, 0, 'a second capture install of another copy must fail loudly');
  assert.ok(r.stderr.includes('Refusing to install'), 'and say why');
  assert.strictEqual(settings(), once, 'and add nothing');
  rmrf(home);
  rmrf(other);
  rmrf(work);
});

it('lenses: the lenses command names both and reports which are installed', () => {
  const home = tmpHome();
  const work = tmpDir();
  const before = run('bin/orunmila.js', { args: ['lenses'], env: { ORUNMILA_HOME: home }, cwd: work });
  assert.strictEqual(before.status, 0);
  assert.ok(before.stdout.includes('The Stain Map'), 'names the first lens');
  assert.ok(before.stdout.includes('The Closeout Gate'), 'names the second lens');
  assert.ok(before.stdout.includes('neither'), 'reports an empty install honestly');

  run('bin/orunmila.js', { args: ['install', '--with-gate'], env: { ORUNMILA_HOME: home }, cwd: work });
  const after = run('bin/orunmila.js', { args: ['lenses'], env: { ORUNMILA_HOME: home }, cwd: work });
  assert.strictEqual(after.status, 0);
  assert.ok(after.stdout.includes('installed'), 'reports what is installed');
  assert.ok(after.stdout.includes('law-gate.js'), 'shows WHERE the gate hook lives, not just that it exists');
  rmrf(home);
  rmrf(work);
});

it('lenses: --gate-only is refused for an agent that cannot run the gate', () => {
  const home = tmpHome();
  const work = tmpDir();
  const r = run('bin/orunmila.js', { args: ['install', '--agent', 'cursor', '--gate-only'], env: { ORUNMILA_HOME: home }, cwd: work });
  assert.notStrictEqual(r.status, 0, 'refuses rather than installing a gate that cannot fire');
  assert.ok(r.stderr.includes('claude-code only'), 'says why');
  rmrf(home);
  rmrf(work);
});

it('lenses: status reports which lenses are live, and flags the kill switch', () => {
  const home = tmpHome();
  const work = tmpDir();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'events.jsonl'), JSON.stringify({ session_id: 'S', type: 'file_read' }) + '\n');

  const off = run('bin/orunmila.js', { args: ['status'], env: { ORUNMILA_HOME: home }, cwd: work });
  assert.strictEqual(off.status, 0);
  assert.ok(off.stdout.includes('Lenses:'), 'status leads with lens state');

  run('bin/orunmila.js', { args: ['install', '--with-gate'], env: { ORUNMILA_HOME: home }, cwd: work });
  const killed = run('bin/orunmila.js', {
    args: ['status'],
    env: { ORUNMILA_HOME: home, ORUNMILA_LAWS: 'off' },
    cwd: work,
  });
  assert.ok(
    killed.stdout.includes('ORUNMILA_LAWS=off'),
    'an installed gate disabled by the env var must not read as simply "on"'
  );
  rmrf(home);
  rmrf(work);
});

runAll('hooks + cli');
