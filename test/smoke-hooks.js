// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/smoke-hooks.js — W1 (LD297): scripts/smoke-hooks.js packs this repository, installs it globally into a prefix
 * whose path holds a space, writes a throwaway project's hooks with that copy, runs every hook command exactly as the
 * settings file holds it through the platform's shell, and reads the events back with `orunmila trail --json`. CI runs
 * the same script on Windows through cmd.exe and Git Bash (.github/workflows/ci.yml, job `smoke`).
 */

const { assert, run, it, runAll } = require('./helpers');

it('W1 (LD297): installed into a path with a space, every hook command runs as written through the shell, and the trail holds the prompt and the write', () => {
  const r = run('scripts/smoke-hooks.js');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.strictEqual(out.ok, true, r.stdout);
  const first = out.hooks.filter((h) => !h.removed);
  assert.deepStrictEqual(first.map((h) => h.event), ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'].filter((e) => first.some((h) => h.event === e)));
  assert.ok(out.trail.prompt && out.trail.write, JSON.stringify(out.trail));
});

it('PM2b (LD331): with the installed package removed, the prompt hook still runs as written, through the starter and the copy kept in Orunmila\'s home, and the trail holds that prompt', () => {
  const r = run('scripts/smoke-hooks.js');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepStrictEqual(out.hooks.filter((h) => h.removed).map((h) => [h.event, h.status]), [['UserPromptSubmit', 0]], r.stdout);
  assert.strictEqual(out.trail.afterRemoval, true, JSON.stringify(out.trail));
});

runAll('smoke-hooks');
