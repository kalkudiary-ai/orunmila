#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * scripts/smoke-hooks.js — the hooks as a user's machine runs them (Phase 5 plan section 7, slice W1, LD297; O:
 * "windows is yes, confirm that it'll work for windows").
 *
 * This repository is packed and installed globally into a throwaway prefix whose path holds a space (as
 * C:\Users\Jane Doe\... does), and that copy's `orunmila install` writes the hooks of a throwaway project. Each hook
 * command is then run exactly as the settings file holds it, through the platform's shell (cmd.exe on Windows,
 * /bin/sh elsewhere) or, with --bash, through Git Bash's `bash -c`, with a recorded payload of the shape Claude Code
 * sends; and the events are read back with that copy's `orunmila trail --json`. Nothing touches the user's own
 * settings or data: HOME, USERPROFILE and ORUNMILA_HOME point into the throwaway folder.
 *
 *   node scripts/smoke-hooks.js [--bash]
 *     prints one JSON line: { ok, shell, hooks: [{ event, status }], trail: { events, prompt, write } }
 *     exit 0 only when every hook command exited 0 and the trail holds the prompt and the write
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const win = process.platform === 'win32';
const npm = win ? 'npm.cmd' : 'npm';

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', shell: win && cmd.endsWith('.cmd'), ...opts });
}

function main() {
  const bash = process.argv.includes('--bash');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orunmila smoke ')));
  const prefix = path.join(base, 'global prefix');
  const home = path.join(base, 'home');
  const data = path.join(base, 'orunmila home');
  const project = path.join(base, 'a project');
  for (const d of [prefix, home, data, project]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, ORUNMILA_HOME: data, npm_config_prefix: prefix, npm_config_cache: path.join(base, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
  const out = { ok: false, shell: bash ? 'bash' : win ? 'cmd' : 'sh', hooks: [], trail: null };
  try {
    const pack = run(npm, ['pack', '--pack-destination', base, ROOT], { env, cwd: ROOT });
    if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
    const tarball = path.join(base, pack.stdout.trim().split('\n').pop());
    const inst = run(npm, ['install', '-g', tarball], { env, cwd: base });
    if (inst.status !== 0) throw new Error(`npm install -g failed: ${inst.stderr}`);
    const pkg = win ? path.join(prefix, 'node_modules', 'orunmila') : path.join(prefix, 'lib', 'node_modules', 'orunmila');
    const cli = path.join(pkg, 'bin', 'orunmila.js');
    const install = run(process.execPath, [cli, 'install'], { env, cwd: project });
    if (install.status !== 0) throw new Error(`orunmila install failed: ${install.stdout}${install.stderr}`);
    const settings = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'));
    const transcript = path.join(base, 'transcript.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I wrote a.txt.' }] } }) + '\n');
    const file = path.join(project, 'a.txt');
    const common = { session_id: 'smoke-session', transcript_path: transcript, cwd: project };
    const payloads = {
      UserPromptSubmit: { ...common, hook_event_name: 'UserPromptSubmit', prompt: 'write a.txt' },
      PreToolUse: { ...common, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'a\n' }, tool_use_id: 'w1' },
      PostToolUse: { ...common, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'a\n' }, tool_response: {}, tool_use_id: 'w1' },
      Stop: { ...common, hook_event_name: 'Stop', last_assistant_message: 'I wrote a.txt.' },
    };
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
      if (event === 'PostToolUse') fs.writeFileSync(file, 'a\n'); // the Write itself, between its two hooks
      for (const entry of settings.hooks[event] || []) {
        for (const h of entry.hooks || []) {
          if (h.type !== 'command') continue;
          const opts = { env, cwd: project, input: JSON.stringify(payloads[event]), encoding: 'utf8', timeout: 60000 };
          const r = bash ? spawnSync('bash', ['-c', h.command], opts) : spawnSync(h.command, { ...opts, shell: true });
          out.hooks.push({ event, status: r.status, ...(r.status !== 0 ? { stderr: String(r.stderr || r.error || '').slice(0, 500) } : {}) });
        }
      }
    }
    // PM2b (LD331): the global copy removed (as a package runner's cache is cleared), the prompt hook runs again as
    // written, through the starter and the copy `install` kept in Orunmila's home; the trail is read through it too.
    fs.rmSync(pkg, { recursive: true, force: true });
    for (const entry of settings.hooks.UserPromptSubmit || []) {
      for (const h of entry.hooks || []) {
        if (h.type !== 'command') continue;
        const opts = { env, cwd: project, input: JSON.stringify({ ...payloads.UserPromptSubmit, prompt: 'after removal' }), encoding: 'utf8', timeout: 60000 };
        const r = bash ? spawnSync('bash', ['-c', h.command], opts) : spawnSync(h.command, { ...opts, shell: true });
        out.hooks.push({ event: 'UserPromptSubmit', removed: true, status: r.status, ...(r.status !== 0 ? { stderr: String(r.stderr || r.error || '').slice(0, 500) } : {}) });
      }
    }
    const starter = path.join(data, 'bin', 'orunmila-start.js');
    const trail = run(process.execPath, [starter, 'bin/orunmila.js', 'trail', '--json', '--session', 'smoke-session'], { env, cwd: project });
    let turns = [];
    try {
      turns = JSON.parse(trail.stdout).turns || []; // trail --json: each turn's prompt and its trail of events
    } catch {
      turns = [];
    }
    const events = turns.flatMap((t) => t.trail || []);
    out.trail = { events: events.length, prompt: turns.some((t) => t.prompt === 'write a.txt'), write: events.some((e) => e.type === 'file_write'), afterRemoval: turns.some((t) => t.prompt === 'after removal') };
    out.ok = out.hooks.length >= 5 && out.hooks.every((h) => h.status === 0) && out.trail.prompt && out.trail.write && out.trail.afterRemoval;
  } catch (e) {
    out.error = e.message;
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify(out) + '\n');
  return out.ok ? 0 : 1;
}

if (require.main === module) process.exit(main());
module.exports = { main };
