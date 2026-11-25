// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * scripts/hook-reach.js — which repo files the Claude Code hooks load.
 *
 * Runs each hook entry in src/capture/claude-code/ on a set of payloads, with a
 * throwaway ORUNMILA_HOME and working folder (the real ~/.orunmila is never
 * touched), and records every module Node loaded from the repo. The union is
 * the code a live session runs. While the worktree's hooks are being measured
 * (test 41), Phase 1 code must stay out of this set until it is wired in on
 * purpose.
 *
 * A payload only reaches the code its path runs, so this is a lower bound on
 * reach: a file loaded on a path no payload takes is not listed.
 *
 *   node scripts/hook-reach.js            print the union, one path per line
 *   node scripts/hook-reach.js --check    exit 1 if it differs from
 *                                         scripts/hook-reach.expected.txt
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOKS = path.join(ROOT, 'src', 'capture', 'claude-code');
const EXPECTED = path.join(__dirname, 'hook-reach.expected.txt');

function payloads(cwd) {
  const base = { session_id: 'hook-reach', transcript_path: '', cwd };
  const file = path.join(cwd, 'a.js');
  const post = (tool, input, extra) => ({ ...base, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_response: {}, ...extra });
  const stop = { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'All tests pass.' };
  return [
    ['user-prompt-submit.js', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'run the tests' }],
    ['pre-tool-use.js', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file, old_string: '', new_string: 'x' } }],
    ['post-tool-use.js', post('Bash', { command: 'npm test' }, { tool_response: { stdout: 'ok', stderr: '', interrupted: false } })],
    ['post-tool-use.js', post('Edit', { file_path: file })],
    ['post-tool-use.js', post('Read', { file_path: file })],
    ['post-tool-use.js', post('WebFetch', { url: 'https://example.com/' })],
    ['post-tool-use.js', { ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'false' }, error: 'exit 1' }],
    ['stop.js', stop],
    ['law-gate.js', stop],
  ];
}

function reach() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'orunmila-hook-reach-'));
  const home = path.join(scratch, 'home');
  const cwd = path.join(scratch, 'cwd');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const all = new Set();
  try {
    payloads(cwd).forEach(([entry, payload], i) => {
      const out = path.join(scratch, `${i}.json`);
      const r = spawnSync('node', ['-r', path.join(__dirname, 'hook-reach-preload.js'), path.join(HOOKS, entry)], {
        cwd,
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, ORUNMILA_HOME: home, HOOK_REACH_ROOT: ROOT, HOOK_REACH_OUT: out },
      });
      if (r.status !== 0 || !fs.existsSync(out)) {
        throw new Error(`${entry} (payload ${i}) exited ${r.status}: ${r.stderr}`);
      }
      for (const f of JSON.parse(fs.readFileSync(out, 'utf8'))) all.add(f);
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return [...all].sort();
}

function main() {
  const files = reach();
  if (!process.argv.includes('--check')) {
    process.stdout.write(files.join('\n') + '\n');
    return 0;
  }
  const want = fs.readFileSync(EXPECTED, 'utf8').split('\n').filter(Boolean);
  const added = files.filter((f) => !want.includes(f));
  const gone = want.filter((f) => !files.includes(f));
  for (const f of added) console.log(`now loaded by a hook: ${f}`);
  for (const f of gone) console.log(`no longer loaded by a hook: ${f}`);
  console.log(added.length || gone.length ? 'hook reach: CHANGED' : `hook reach: unchanged (${files.length} files)`);
  return added.length || gone.length ? 1 : 0;
}

process.exit(main());
