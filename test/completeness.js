// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/completeness.js — CF5 (LD385): at the closeout, the agent's transcript's tool calls since the session started
 * that have no mark in the record, counted and named. Transcripts are hand-built in the line shape Claude Code writes
 * (an assistant line's message.content holding tool_use blocks with an id and a name); made-up ids; throwaway folders.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { transcriptCalls, completeness, MAX_NAMED } = require('../src/capture/completeness');
const { createRouter } = require('../src/opon/intake/router');
const { verifySessionLog } = require('../src/opon/ledger/session-log');

const KEY = Buffer.alloc(32, 7);
const line = (ts, calls, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }, ...calls.map(([id, name]) => ({ type: 'tool_use', id, name, input: {} }))] }, ...extra });

it("CF5 (LD385): the transcript's tool calls since the session started, the main thread only, each once", () => {
  const text = [
    line('2026-11-28T08:59:00.000Z', [['toolu_old', 'Bash']]),
    line('2026-11-28T09:00:01.000Z', [['toolu_a', 'Read'], ['toolu_b', 'Bash']]),
    JSON.stringify({ type: 'user', timestamp: '2026-11-28T09:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a' }] } }),
    line('2026-11-28T09:00:03.000Z', [['toolu_side', 'Grep']], { isSidechain: true }),
    line('2026-11-28T09:00:04.000Z', [['toolu_b', 'Bash']]),
    'not json',
    '',
  ].join('\n');
  assert.deepStrictEqual(transcriptCalls(text, '2026-11-28T09:00:00.000Z'), [{ id: 'toolu_a', tool: 'Read' }, { id: 'toolu_b', tool: 'Bash' }]);
});

it('CF5: the calls with no mark are named, in transcript order; a long list is cut and counted; no transcript, or one too large, says so', () => {
  const calls = [{ id: 'a', tool: 'Read' }, { id: 'b', tool: 'Bash' }, { id: 'c', tool: 'Edit' }];
  assert.deepStrictEqual(completeness({ transcript: 'read', calls }, new Set(['a', 'c'])), { transcript: 'read', calls: 3, unmarked: [{ id: 'b', tool: 'Bash' }] });
  assert.deepStrictEqual(completeness({ transcript: 'read', calls }, new Set(['a', 'b', 'c'])), { transcript: 'read', calls: 3, unmarked: [] });
  const many = Array.from({ length: MAX_NAMED + 3 }, (_, i) => ({ id: `x${i}`, tool: 'Bash' }));
  const cut = completeness({ transcript: 'read', calls: many }, new Set());
  assert.deepStrictEqual([cut.unmarked.length, cut.cut], [MAX_NAMED, 3]);
  assert.deepStrictEqual(completeness({ transcript: 'none', calls: [] }, new Set()), { transcript: 'none', calls: 0, unmarked: [] });
});

it("CF5 at the router: with commandFacts, the closeout names the transcript's tool call that left no mark, verified intact; without it (the default), nothing", () => {
  for (const on of [true, false]) {
    const base = tmpDir();
    try {
      const home = path.join(base, 'home');
      const project = path.join(base, 'project');
      fs.mkdirSync(project, { recursive: true });
      let mono = 5000n * 1000000n;
      let wall = Date.UTC(2026, 10, 28, 9, 0, 0);
      const clock = () => ({ mono: mono.toString(), wall: new Date(wall).toISOString() });
      const router = createRouter({ home, clock, checkSender: () => true, codeRoot: path.join(__dirname, '..', 'src'), orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: true, outsideHome: path.join(base, 'nobody'), ...(on ? { commandFacts: true } : {}) });
      const transcript = path.join(base, 't.jsonl');
      const p = { session_id: 'ses_c5', transcript_path: transcript, cwd: project };
      router.payload({ ...p, hook_event_name: 'UserPromptSubmit', prompt: 'go' }, { channel: 'command' });
      wall += 1000;
      mono += 1000n * 1000000n;
      router.payload({ ...p, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_seen' }, { channel: 'command' });
      router.payload({ ...p, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: '', stderr: '' }, tool_use_id: 'toolu_seen' }, { channel: 'command' });
      fs.writeFileSync(transcript, [line(new Date(wall).toISOString(), [['toolu_seen', 'Bash'], ['toolu_lost', 'mcp__db__query']])].join('\n') + '\n');
      router.payload({ ...p, hook_event_name: 'Stop', last_assistant_message: 'Done.' }, { channel: 'command' });
      router.payload({ ...p, hook_event_name: 'SessionEnd', reason: 'exit' }, { channel: 'command' });
      mono += 10000n * 1000000n;
      wall += 10000;
      router.poll();
      const dir = path.join(home, 'sessions', 'ses_c5');
      const recs = fs.readFileSync(path.join(dir, 'raw.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const end = recs.find((r) => r.says === 'exited' && r.target && r.target.name === 'closeout');
      assert.ok(end, 'the closeout ran');
      assert.deepStrictEqual(end.detail.completeness, on ? { transcript: 'read', calls: 2, unmarked: [{ id: 'toolu_lost', tool: 'mcp__db__query' }] } : undefined, `commandFacts ${on}`);
      assert.strictEqual(verifySessionLog(dir).ok, true);
    } finally {
      rmrf(base);
    }
  }
});

runAll('completeness');
