// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/support.js — DOC6 (Phase 7; brief v4 lines 727-733): the support table, stated plainly, kept in one place
 * (src/capture/support.js), and an experimental adapter's session labelled experimental in its session report
 * (`orunmila report`). A throwaway ORUNMILA_HOME with hand-built events; nothing recorded is read.
 */

const { assert, fs, path, ROOT, tmpDir, rmrf, it, runAll } = require('./helpers');
const { spawnSync } = require('child_process');

const BIN = path.join(ROOT, 'bin', 'orunmila.js');

it('DOC6: every adapter has its support line, as the brief states it: Claude Code supported, Cursor experimental until test 49, Aider sentinel only, the rest sample data only', () => {
  const { SUPPORT, supportOf } = require('../src/capture/support');
  const { listAgents } = require('../src/capture/agents');
  assert.deepStrictEqual(listAgents().map((a) => a.id).sort(), Object.keys(SUPPORT).sort(), 'one line per adapter, no more');
  assert.strictEqual(supportOf('claude-code').status, 'supported');
  for (const id of ['cursor', 'gemini-cli', 'codex', 'continue', 'antigravity', 'generic', 'aider']) assert.strictEqual(supportOf(id).status, 'experimental', id);
  assert.ok(/real-session tests/.test(supportOf('cursor').words), supportOf('cursor').words);
  assert.ok(/sentinel only/.test(supportOf('aider').words), supportOf('aider').words);
  for (const id of ['gemini-cli', 'codex', 'continue', 'antigravity', 'generic']) assert.ok(/tested only with sample data; results may be wrong/.test(supportOf(id).words), id);
  assert.strictEqual(supportOf('windsurf').status, 'none', 'no Windsurf adapter exists');
});

function report(agent) {
  const home = tmpDir();
  try {
    const ev = (o) => JSON.stringify({ ts: '2026-11-28T09:00:00.000Z', session_id: 'sup1', turn_id: 't1', agent, ...o });
    fs.writeFileSync(path.join(home, 'events.jsonl'), [ev({ type: 'user_prompt', text: 'go' }), ev({ type: 'turn_claim', text: 'done' }), ev({ type: 'turn_end' })].join('\n') + '\n');
    return spawnSync(process.execPath, [BIN, 'report', '--session', 'sup1'], { encoding: 'utf8', cwd: home, env: { ...process.env, ORUNMILA_HOME: home, ORUNMILA_INTAKE_PORT: '0' } }).stdout;
  } finally {
    rmrf(home);
  }
}

it("DOC6 (line 733): a Cursor session's report says its adapter is experimental, first; a Claude Code session's does not", () => {
  const cursor = report('cursor');
  assert.ok(cursor.startsWith('Experimental adapter (Cursor):'), cursor);
  assert.ok(!report('claude-code').includes('Experimental adapter'));
});

runAll('support');
