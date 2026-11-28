#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * scripts/upgrade-proof.js — EU2 (Phase 7; brief v4 line 745: "The upgrade must not strand them"; LD371, LD379): an
 * existing user's upgrade, run and checked in a throwaway machine (HOME, ORUNMILA_HOME, npm's prefix and cache in one
 * temporary folder, as scripts/install-routes.js makes it). In order, one JSON line per step:
 *
 *   installed          the earlier copy installed globally, and its `orunmila install` run in a project: both exit 0
 *   used               its prompt hook, run as written through the platform's shell, exits 0 and is recorded
 *   upgraded           this repository, packed, installed globally over it: exit 0
 *   install-again      `orunmila install` run again in the project: exit 0
 *   hooks-moved        every Orunmila hook now runs the starter in Orunmila's home, and no hook was added or dropped
 *   capture-continues  the prompt hook, run as written again, exits 0 and is recorded
 *   old-log-kept       the event log still holds what was recorded before the upgrade; owner-only (not on Windows,
 *                      which has no POSIX modes)
 *   status             `orunmila status` exits 0 (no hook names a missing script)
 *   kept-commands      `trail --json`, `json` and `laws --check --json` on the session each exit 0 with JSON
 *
 *   node scripts/upgrade-proof.js [--from orunmila@0.2.4 | --from self] [--plant-foreign-hook]
 *     --from self   offline: this repository packed as the earlier copy, and again one patch version on as the upgrade
 *     --plant-foreign-hook   before the upgrade, a hook naming a different copy of Orunmila is added to the project,
 *                   which install must refuse (named and left untouched), so the proof fails (its own test)
 *   exit 0 when every step passed. CI's `upgrade` job runs it from the published 0.2.4 on every OS (network needed).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pack, machine, sh, hooksOf } = require('./install-routes');

const ROOT = path.resolve(__dirname, '..');
const SID = 'upgrade-proof';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

/** The prompt hook, run exactly as written, and whether its words reached the event log. */
function fire(m, words) {
  const c = hooksOf(m).find((h) => h.event === 'UserPromptSubmit');
  if (!c) return false;
  const r = spawnSync(c.command, { shell: true, cwd: m.project, env: m.env, encoding: 'utf8', input: JSON.stringify({ session_id: SID, transcript_path: path.join(m.home, 't.jsonl'), cwd: m.project, hook_event_name: 'UserPromptSubmit', prompt: words }), timeout: 60000 });
  return r.status === 0 && logLines(m).some((l) => l.includes(JSON.stringify(words)));
}

function logLines(m) {
  try {
    return fs.readFileSync(path.join(m.data, 'events.jsonl'), 'utf8').split('\n');
  } catch {
    return [];
  }
}

const isOrunmila = (cmd) => /orunmila/i.test(cmd);

function main() {
  const from = arg('--from', 'orunmila@0.2.4');
  const plant = process.argv.includes('--plant-foreign-hook');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orunmila upgrade ')));
  const out = [];
  const step = (name, ok, said = null) => {
    const s = { step: name, ok: Boolean(ok), ...(said ? { said: String(said).trim().slice(-600) } : {}) };
    out.push(s);
    process.stdout.write(JSON.stringify(s) + '\n');
    return s.ok;
  };
  try {
    const env = { ...process.env, npm_config_cache: path.join(base, 'pack-cache'), npm_config_update_notifier: 'false' };
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const next = version.replace(/^(\d+)\.(\d+)\.(\d+).*$/, (_, x, y, z) => `${x}.${y}.${Number(z) + 1}`);
    const earlier = from === 'self' ? pack(base, env, version) : from;
    const later = pack(base, env, from === 'self' ? next : version);
    const m = machine(base, 'upgrade');
    const run = (cmd, args) => sh(cmd, args, { env: m.env, cwd: m.project });
    const a = run('npm', ['install', '-g', earlier]);
    const b = a.status === 0 ? run('orunmila', ['install']) : a;
    if (!step('installed', a.status === 0 && b.status === 0, `${from}: ${b.stdout || ''}${b.stderr || ''}`)) return 1;
    if (!step('used', fire(m, 'before the upgrade'))) return 1;
    if (plant) {
      const file = path.join(m.project, '.claude', 'settings.json');
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      s.hooks.Stop = [...(s.hooks.Stop || []), { matcher: '*', hooks: [{ type: 'command', command: `node "${path.join(base, 'another copy', 'orunmila', 'src', 'capture', 'claude-code', 'stop.js')}"` }] }];
      fs.writeFileSync(file, JSON.stringify(s, null, 2));
    }
    const before = hooksOf(m).filter((h) => isOrunmila(h.command)).length;
    const up = run('npm', ['install', '-g', later]);
    if (!step('upgraded', up.status === 0, up.stderr)) return 1;
    const again = run('orunmila', ['install']);
    step('install-again', again.status === 0, again.stdout + again.stderr);
    const starter = path.join(m.data, 'bin', 'orunmila-start.js');
    const hooks = hooksOf(m).filter((h) => isOrunmila(h.command));
    step('hooks-moved', hooks.length === before && hooks.every((h) => h.command.startsWith(`node "${starter}" `)), `${hooks.length} of ${before} Orunmila hooks; ${hooks.filter((h) => !h.command.startsWith(`node "${starter}" `)).length} not on the starter`);
    step('capture-continues', fire(m, 'after the upgrade'));
    const log = path.join(m.data, 'events.jsonl');
    const owner = process.platform === 'win32' || (fs.existsSync(log) && (fs.statSync(log).mode & 0o077) === 0);
    step('old-log-kept', logLines(m).some((l) => l.includes(JSON.stringify('before the upgrade'))) && owner, owner ? null : 'the event log is readable by others');
    const st = run('orunmila', ['status']);
    step('status', st.status === 0, st.stdout + st.stderr);
    const bad = [];
    for (const args of [['trail', '--json', '--session', SID], ['json', '--session', SID], ['laws', '--check', '--json', '--session', SID]]) {
      const r = run('orunmila', args);
      try {
        JSON.parse(r.stdout);
        if (r.status !== 0) bad.push(`${args.join(' ')}: exit ${r.status}`);
      } catch {
        bad.push(`${args.join(' ')}: not JSON (exit ${r.status})`);
      }
    }
    step('kept-commands', bad.length === 0, bad.join('; '));
    const ok = out.every((s) => s.ok);
    process.stdout.write(JSON.stringify({ step: 'done', ok, from, to: from === 'self' ? next : version }) + '\n');
    return ok ? 0 : 1;
  } catch (e) {
    step('error', false, e.message);
    return 1;
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

if (require.main === module) process.exit(main());
