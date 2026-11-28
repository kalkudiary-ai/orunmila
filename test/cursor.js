// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/cursor.js — CU1: the Cursor adapter against the hook shapes Cursor sends.
 *
 * Measured on 2026-11-28 with Cursor's command-line agent 2026.11.22-e9042b2 (one print-mode session, one
 * interactive session, every hook's stdin kept): the hooks file is `{ version: 1, hooks: { <event>: [{ command }] } }`;
 * preToolUse/postToolUse carry `tool_name` (Read, Write, Grep, Shell), `tool_input` as an object and `tool_output` as
 * JSON text (Shell's holds `output` and `exitCode`); the final text comes only in `afterAgentResponse` (`text`), at
 * the same moment as `stop`, whose payload has none; print mode (`-p`) fires no prompt, stop or response hook at all,
 * only sessionStart and sessionEnd. The payloads below have those shapes, with invented ids and temporary paths.
 */

const { assert, fs, path, tmpHome, tmpDir, rmrf, run, runUntil, it, runAll } = require('./helpers');

const CONNECTOR = 'src/capture/connector.js';

function readEvents(home) {
  const p = path.join(home, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

const common = (conv) => ({ conversation_id: conv, generation_id: 'g-1', session_id: conv, model: 'default', cursor_version: '2026.11.22-e9042b2', workspace_roots: ['/w'] });

function cursorTranscript(dir, ask, finalText) {
  const p = path.join(dir, 'transcript.jsonl');
  const lines = [
    { role: 'user', message: { content: [{ type: 'text', text: `<timestamp>Saturday, Nov 28, 2026, 11:31 AM (UTC+3)</timestamp>\n<user_query>\n${ask}\n</user_query>` }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'I will look first.' }, { type: 'tool_use', name: 'Read', input: { path: '/w/a.js' } }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: finalText }] } },
    { type: 'turn_ended', status: 'success' },
  ];
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

it('CU1: install --agent cursor writes the hooks file Cursor reads: version 1, each event a list of commands', () => {
  const home = tmpHome();
  const work = tmpDir();
  const r = run('bin/orunmila.js', { args: ['install', '--agent', 'cursor'], env: { ORUNMILA_HOME: home }, cwd: work });
  assert.strictEqual(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(work, '.cursor', 'hooks.json'), 'utf8'));
  assert.strictEqual(cfg.version, 1, 'Cursor\'s format version');
  const want = { beforeSubmitPrompt: 'prompt', preToolUse: 'preTool', postToolUse: 'postTool', postToolUseFailure: 'postTool', afterAgentResponse: 'stop', sessionEnd: 'sessionEnd' };
  assert.deepStrictEqual(Object.keys(cfg.hooks).sort(), Object.keys(want).sort(), 'exactly the measured events, no hook that answers for Cursor');
  for (const [ev, phase] of Object.entries(want)) {
    assert.ok(Array.isArray(cfg.hooks[ev]) && cfg.hooks[ev].length === 1, `${ev} is a list of one`);
    assert.ok(String(cfg.hooks[ev][0].command).endsWith(`orunmila-start.js" src/capture/connector.js cursor ${phase}`), `${ev} runs the connector's ${phase}`);
  }
  rmrf(home);
  rmrf(work);
});

it('CU1: installing over an earlier one-string-per-event Cursor install replaces it, keeps the user\'s own hooks, and twice adds nothing', () => {
  const home = tmpHome();
  const work = tmpDir();
  fs.mkdirSync(path.join(work, '.cursor'));
  const old = 'node "/old/copy/src/capture/connector.js" cursor postTool';
  fs.writeFileSync(path.join(work, '.cursor', 'hooks.json'), JSON.stringify({
    version: 1,
    hooks: { afterFileEdit: old, afterShellExecution: old, beforeShellExecution: 'node "/old/copy/src/capture/connector.js" cursor preTool', stop: [{ command: './hooks/mine.sh' }, { command: 'node "/old/copy/src/capture/connector.js" cursor stop' }] },
  }));
  for (let i = 0; i < 2; i++) {
    const r = run('bin/orunmila.js', { args: ['install', '--agent', 'cursor'], env: { ORUNMILA_HOME: home }, cwd: work });
    assert.strictEqual(r.status, 0, r.stderr);
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(work, '.cursor', 'hooks.json'), 'utf8'));
  assert.deepStrictEqual(cfg.hooks.stop, [{ command: './hooks/mine.sh' }], 'the user\'s own hook kept, the old connector entry gone');
  for (const ev of ['afterFileEdit', 'afterShellExecution', 'beforeShellExecution']) assert.ok(!(ev in cfg.hooks), `${ev}: the old string entry is gone`);
  assert.strictEqual(cfg.hooks.postToolUse.length, 1, 'installed twice, registered once');
  const all = JSON.stringify(cfg);
  assert.ok(!all.includes('/old/copy/'), 'nothing of the earlier copy left');
  rmrf(home);
  rmrf(work);
});

it('CU1: a Cursor turn in the measured shapes is recorded: prompt, edit with its diff, read, search, command and its exit, the final text', () => {
  const home = tmpHome();
  const work = tmpDir();
  const file = path.join(work, 'greet.js');
  fs.writeFileSync(file, "return 'Hello';\n");
  const env = { ORUNMILA_HOME: home };
  const C = (phase, payload) => run(CONNECTOR, { args: ['cursor', phase], input: JSON.stringify(payload), env });
  const c = common('conv-1');
  const tp = cursorTranscript(work, 'change the greeting', 'Changed it. npm test passed.');

  assert.strictEqual(C('prompt', { ...c, hook_event_name: 'beforeSubmitPrompt', prompt: 'change the greeting', attachments: [], transcript_path: null }).stdout, '', 'answers nothing, so it decides nothing for Cursor');
  C('postTool', { ...c, hook_event_name: 'postToolUse', tool_name: 'Read', tool_input: { file_path: file }, tool_output: JSON.stringify({ file_path: file, content_length: 16 }), duration: 1.2, tool_use_id: 'call-1', transcript_path: tp });
  C('postTool', { ...c, hook_event_name: 'postToolUse', tool_name: 'Grep', tool_input: { pattern: '', glob: '**/greet.js', output_mode: 'files_with_matches' }, tool_output: JSON.stringify({ pattern: '', success: true }), tool_use_id: 'call-2', transcript_path: tp });
  C('preTool', { ...c, hook_event_name: 'preToolUse', tool_name: 'Write', tool_input: { file_path: file, content: "return 'Hi';\n" }, tool_use_id: 'call-3', transcript_path: tp });
  fs.writeFileSync(file, "return 'Hi';\n");
  C('postTool', { ...c, hook_event_name: 'postToolUse', tool_name: 'Write', tool_input: { file_path: file, content: "return 'Hi';\n" }, tool_output: JSON.stringify({ file_path: file, success: true }), duration: 27.5, tool_use_id: 'call-3', transcript_path: tp });
  C('preTool', { ...c, hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: { command: 'npm test', cwd: '', timeout: 30000 }, tool_use_id: 'call-4', cwd: '', transcript_path: tp });
  C('postTool', { ...c, hook_event_name: 'postToolUse', tool_name: 'Shell', tool_input: { command: 'npm test', cwd: '', timeout: 30000 }, tool_output: JSON.stringify({ output: '\n> node test.js\n\n1 test passed\n', exitCode: 0 }), duration: 230.8, tool_use_id: 'call-4', cwd: '', transcript_path: tp });
  C('postTool', { ...c, hook_event_name: 'postToolUse', tool_name: 'Shell', tool_input: { command: 'npm run lint', cwd: '', timeout: 30000 }, tool_output: JSON.stringify({ output: 'error: 1 problem\n', exitCode: 1 }), tool_use_id: 'call-5', cwd: '', transcript_path: tp });
  C('stop', { ...c, hook_event_name: 'afterAgentResponse', text: 'Changed it. npm test passed.', input_tokens: 10, output_tokens: 5, transcript_path: tp });

  const ev = readEvents(home);
  assert.ok(ev.length && ev.every((e) => e.agent === 'cursor' && e.session_id === 'conv-1'), 'every event is the conversation\'s, stamped cursor');
  const of = (t) => ev.filter((e) => e.type === t);
  assert.deepStrictEqual(of('user_prompt').map((e) => e.text), ['change the greeting']);
  const w = of('file_write');
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].path, file);
  assert.ok(/-return 'Hello';/.test(w[0].diff) && /\+return 'Hi';/.test(w[0].diff), 'the diff is the edit, from the snapshot preToolUse took');
  const reads = of('file_read');
  assert.deepStrictEqual(reads.map((e) => [e.path, e.read_kind]), [[file, 'full'], ['**/greet.js', 'pattern']]);
  const cmds = of('command_run');
  assert.deepStrictEqual(cmds.map((e) => [e.command, e.exit_code, e.failed]), [['npm test', 0, false], ['npm run lint', 1, true]], 'each command with how it ended');
  assert.ok(/1 test passed/.test(cmds[0].stdout_excerpt), 'its output');
  assert.deepStrictEqual(of('turn_claim').map((e) => e.text), ['Changed it. npm test passed.'], 'the final text, from afterAgentResponse');
  assert.strictEqual(of('turn_end').length, 1);
  assert.strictEqual(of('tool_call').length, 0, 'nothing fell through to a generic tool call');
  rmrf(home);
  rmrf(work);
});

it('CU1: sessionEnd closes a turn no response hook closed (print mode), its claim and ask from the transcript; after a closed turn it adds nothing', () => {
  const home = tmpHome();
  const work = tmpDir();
  const env = { ORUNMILA_HOME: home };
  const C = (phase, payload) => run(CONNECTOR, { args: ['cursor', phase], input: JSON.stringify(payload), env });

  // Print mode: tool hooks, then only sessionEnd.
  const p = common('conv-print');
  const tp = cursorTranscript(work, 'run the tests', 'The tests pass.');
  C('postTool', { ...p, hook_event_name: 'postToolUse', tool_name: 'Shell', tool_input: { command: 'npm test' }, tool_output: JSON.stringify({ output: 'ok\n', exitCode: 0 }), tool_use_id: 'c1', transcript_path: tp });
  C('sessionEnd', { ...p, hook_event_name: 'sessionEnd', reason: 'completed', final_status: 'completed', duration_ms: 1000, transcript_path: tp });
  // Interactive: the response hook closed the turn; sessionEnd comes later.
  const q = common('conv-tty');
  C('prompt', { ...q, hook_event_name: 'beforeSubmitPrompt', prompt: 'say hi', transcript_path: null });
  C('stop', { ...q, hook_event_name: 'afterAgentResponse', text: 'hi', transcript_path: tp });
  C('sessionEnd', { ...q, hook_event_name: 'sessionEnd', reason: 'aborted', final_status: 'aborted', transcript_path: tp });
  // A session with nothing recorded: sessionEnd writes nothing.
  C('sessionEnd', { ...common('conv-empty'), hook_event_name: 'sessionEnd', reason: 'completed', transcript_path: tp });

  const ev = readEvents(home);
  const of = (s, t) => ev.filter((e) => e.session_id === s && e.type === t);
  assert.deepStrictEqual(of('conv-print', 'turn_claim').map((e) => e.text), ['The tests pass.'], 'the transcript\'s last assistant text');
  assert.deepStrictEqual(of('conv-print', 'user_prompt').map((e) => e.text), ['run the tests'], 'the ask without Cursor\'s timestamp and query tags');
  assert.strictEqual(of('conv-print', 'turn_end').length, 1);
  assert.deepStrictEqual(of('conv-tty', 'turn_claim').map((e) => e.text), ['hi'], 'one claim: sessionEnd after a closed turn adds none');
  assert.strictEqual(of('conv-tty', 'turn_end').length, 1);
  assert.strictEqual(ev.filter((e) => e.session_id === 'conv-empty').length, 0, 'nothing for a session with no record');
  rmrf(home);
  rmrf(work);
});

it('CU1: the claim is the final message: afterAgentResponse joins the turn\'s text blocks with no space, so its tail is taken when the transcript\'s last message is exactly that tail', () => {
  const home = tmpHome();
  const work = tmpDir();
  const env = { ORUNMILA_HOME: home };
  const C = (phase, payload) => run(CONNECTOR, { args: ['cursor', phase], input: JSON.stringify(payload), env });
  const tp = cursorTranscript(work, 'fix it', 'Fixed `a.js`. All tests pass.');
  C('prompt', { ...common('j1'), prompt: 'fix it' });
  C('stop', { ...common('j1'), hook_event_name: 'afterAgentResponse', text: 'I will look first.Fixed `a.js`. All tests pass.', transcript_path: tp });
  // A transcript that has not caught up (its last message is not the text's tail): the hook's text stands.
  const stale = cursorTranscript(fs.mkdtempSync(path.join(work, 's')), 'fix it', 'An earlier message.');
  C('prompt', { ...common('j2'), prompt: 'fix it' });
  C('stop', { ...common('j2'), hook_event_name: 'afterAgentResponse', text: 'I will look first.Fixed `a.js`. All tests pass.', transcript_path: stale });
  const claims = (s) => readEvents(home).filter((e) => e.session_id === s && e.type === 'turn_claim').map((e) => e.text);
  assert.deepStrictEqual(claims('j1'), ['Fixed `a.js`. All tests pass.'], 'the final message, as Claude Code\'s claim is');
  assert.deepStrictEqual(claims('j2'), ['I will look first.Fixed `a.js`. All tests pass.'], 'never a stale message');
  rmrf(home);
  rmrf(work);
});

it("F41: orunmila watch names the agent whose hooks the folder holds (Cursor), never Claude Code there; with none, it names no agent", () => {
  const project = fs.realpathSync(tmpDir());
  const home = tmpDir();
  try {
    fs.mkdirSync(path.join(project, '.cursor'));
    fs.writeFileSync(path.join(project, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { postToolUse: [{ command: 'node "/x/connector.js" cursor postTool' }] } }));
    const w = runUntil('bin/orunmila.js', { args: ['watch'], env: { ORUNMILA_HOME: home }, cwd: project, ms: 1500 });
    assert.ok(w.stdout.includes('work normally in Cursor'), w.stdout + w.stderr);
    assert.ok(!w.stdout.includes('Claude Code'), w.stdout);
    const empty = fs.realpathSync(tmpDir());
    try {
      const n = runUntil('bin/orunmila.js', { args: ['watch'], env: { ORUNMILA_HOME: home }, cwd: empty, ms: 1500 });
      assert.ok(n.stdout.includes('work normally in your coding agent'), n.stdout + n.stderr);
    } finally {
      rmrf(empty);
    }
  } finally {
    rmrf(project);
    rmrf(home);
  }
});

runAll('cursor');
