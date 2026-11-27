// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/upgrade-install.js — F28 (Phase 7, EU2; brief v4 line 745: "The upgrade must not strand them"). A 0.2.4 install
 * writes hooks that name the package's own files (`node "<package>/src/capture/claude-code/<hook>.js"`). After `npm
 * install -g orunmila` replaces that package, those hooks run the new code, but `orunmila install` refused them as
 * "another copy" although they name this very copy (found in a throwaway machine, session 982aff85). Now hooks that
 * name this copy's own files are upgraded in place to run the starter; hooks that name a different copy are still
 * refused, and nothing is written. A throwaway home and project; made-up session ids.
 */

const { assert, fs, path, ROOT, tmpDir, rmrf, it, runAll } = require('./helpers');
const { spawnSync } = require('child_process');

const BIN = path.join(ROOT, 'bin', 'orunmila.js');
const HOOKS = { UserPromptSubmit: 'user-prompt-submit.js', PreToolUse: 'pre-tool-use.js', PostToolUse: 'post-tool-use.js', PostToolUseFailure: 'post-tool-use.js', Stop: 'stop.js' };

/** A project whose settings hold hooks as 0.2.4 wrote them, naming the hook scripts under `pkg`; plus a gate with an argument. */
function legacyProject(pkg) {
  const proj = tmpDir();
  fs.mkdirSync(path.join(proj, '.claude'));
  const hooks = {};
  for (const [ev, file] of Object.entries(HOOKS)) hooks[ev] = [{ matcher: ev === 'PreToolUse' ? 'Write|Edit|MultiEdit' : '*', hooks: [{ type: 'command', command: `node "${path.join(pkg, 'src', 'capture', 'claude-code', file)}"` }] }];
  hooks.Stop.push({ matcher: '*', hooks: [{ type: 'command', command: `node "${path.join(pkg, 'src', 'capture', 'claude-code', 'law-gate.js')}" --marks` }] });
  hooks.Notification = [{ matcher: '*', hooks: [{ type: 'command', command: 'echo not ours' }] }];
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ hooks, theme: 'kept' }, null, 2));
  return proj;
}
const commands = (proj) => {
  const s = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.json'), 'utf8'));
  return { s, all: Object.entries(s.hooks).flatMap(([ev, es]) => es.flatMap((e) => e.hooks.map((h) => ({ ev, command: h.command })))) };
};
const env = (home) => ({ ...process.env, HOME: home, USERPROFILE: home, ORUNMILA_HOME: path.join(home, '.orunmila'), ORUNMILA_INTAKE_PORT: '0' });

it("F28: install over hooks an earlier version wrote, naming this copy's own files, upgrades each in place to the starter: exit 0, no hook added, other hooks and settings kept", () => {
  const home = tmpDir();
  const proj = legacyProject(ROOT);
  try {
    const before = commands(proj).all.length;
    const r = spawnSync(process.execPath, [BIN, 'install'], { cwd: proj, encoding: 'utf8', env: env(home) });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const { s, all } = commands(proj);
    assert.strictEqual(all.length, before, 'no hook added or dropped');
    const starter = path.join(home, '.orunmila', 'bin', 'orunmila-start.js');
    for (const h of all.filter((x) => x.ev !== 'Notification')) assert.ok(h.command.startsWith(`node "${starter}" src/capture/claude-code/`), h.command);
    assert.ok(all.some((h) => h.command === `node "${starter}" src/capture/claude-code/law-gate.js --marks`), 'the gate keeps its argument');
    assert.ok(all.some((h) => h.command === 'echo not ours') && s.theme === 'kept', 'what is not Orunmila is untouched');
    assert.ok(/6 hooks named this copy's own files/.test(r.stdout), r.stdout);
    // The upgraded prompt hook runs, through the starter, and records.
    const prompt = all.find((h) => h.ev === 'UserPromptSubmit').command;
    const fire = spawnSync(prompt, { shell: true, cwd: proj, input: JSON.stringify({ session_id: 'ses_f28', cwd: proj, hook_event_name: 'UserPromptSubmit', prompt: 'hello' }), encoding: 'utf8', env: env(home) });
    assert.strictEqual(fire.status, 0, fire.stderr);
    const log = fs.readFileSync(path.join(home, '.orunmila', 'events.jsonl'), 'utf8');
    assert.ok(log.split('\n').some((l) => l.includes('"ses_f28"')), 'the upgraded hook recorded the prompt');
  } finally {
    rmrf(home);
    rmrf(proj);
  }
});

it('F28: hooks that name a different copy are still refused, exit 1, and nothing is written', () => {
  const home = tmpDir();
  const other = tmpDir();
  fs.mkdirSync(path.join(other, 'src', 'capture', 'claude-code'), { recursive: true });
  for (const f of new Set([...Object.values(HOOKS), 'law-gate.js'])) fs.writeFileSync(path.join(other, 'src', 'capture', 'claude-code', f), '');
  const proj = legacyProject(other);
  try {
    const before = fs.readFileSync(path.join(proj, '.claude', 'settings.json'), 'utf8');
    const r = spawnSync(process.execPath, [BIN, 'install'], { cwd: proj, encoding: 'utf8', env: env(home) });
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.ok(/Refusing to install/.test(r.stderr), r.stderr);
    assert.strictEqual(fs.readFileSync(path.join(proj, '.claude', 'settings.json'), 'utf8'), before);
    assert.ok(!fs.existsSync(path.join(home, '.orunmila', 'runtime')), "a refusal touches nothing in Orunmila's home");
  } finally {
    rmrf(home);
    rmrf(other);
    rmrf(proj);
  }
});

runAll('upgrade-install');
