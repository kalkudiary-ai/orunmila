// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/intake-update.js — PM2c3 (LD334; Phase 5 plan section 6): the intake runs the copy of Orunmila in its home, and
 * moves to a new one once an update has switched to it and no session is held. `orunmila intake start` and the launch
 * agent run the intake through the starter (PM2b) when one is installed; a running intake that finds `runtime/current`
 * naming another version than its own, while it holds no session, stops as asked and starts again on the new one (a
 * launch agent's intake leaves the start to launchd). The intake's status names the version it runs. Throwaway homes;
 * the "new version" is a copy of this one with its version number changed.
 */

const { assert, fs, path, ROOT, tmpDir, rmrf, run, sleep, it, runAll } = require('./helpers');
const { installRuntime } = require('../src/runtime/install');
const { intakePaths, statusOf } = require('../src/opon/intake/server');
const { plistFor } = require('../src/opon/intake/launch-agent');

async function until(cond, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(50);
  }
  return cond();
}
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const env = (home) => ({ ...process.env, ORUNMILA_HOME: home, ORUNMILA_INTAKE_PORT: '0', ORUNMILA_UPDATES: '', ORUNMILA_UPDATE_POLL_MS: '200', XPC_SERVICE_NAME: '' });

/** A second version folder beside the installed one: the same files, its package.json saying 9.9.9. */
function newerCopy(home, from) {
  const folder = '9.9.9_000000000000';
  const dir = path.join(home, 'runtime', folder);
  fs.cpSync(path.join(home, 'runtime', from), dir, { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...pkg, version: '9.9.9' }));
  return folder;
}

it('PM2c3: intake start runs the intake through the starter, and its status names the version it runs', async () => {
  const base = tmpDir();
  const home = path.join(base, 'h');
  installRuntime({ home, from: ROOT });
  try {
    const r = run('bin/orunmila.js', { args: ['intake', 'start'], env: env(home) });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const st = await statusOf(intakePaths(home).sock, 1000);
    assert.strictEqual(st && st.version, VERSION, JSON.stringify(st));
  } finally {
    run('bin/orunmila.js', { args: ['intake', 'stop'], env: env(home) });
    rmrf(base);
  }
});

it('PM2c3: once current names a new version and no session is held, the intake moves onto it; while one is held, it stays', async () => {
  const base = tmpDir();
  const home = path.join(base, 'h');
  const project = path.join(base, 'p');
  fs.mkdirSync(project, { recursive: true });
  const first = installRuntime({ home, from: ROOT }).folder;
  try {
    assert.strictEqual(run('bin/orunmila.js', { args: ['intake', 'start'], env: env(home) }).status, 0);
    const sock = intakePaths(home).sock;
    const before = await statusOf(sock, 1000);
    // a session held: the switch must wait
    await new Promise((resolve, reject) => {
      const c = require('net').createConnection(sock);
      c.on('error', reject);
      c.on('close', resolve);
      c.on('connect', () => c.end(JSON.stringify({ op: 'payload', payload: { session_id: 'ses_hold', transcript_path: '/none', cwd: project, hook_event_name: 'UserPromptSubmit', prompt: 'go' } }) + '\n'));
    });
    assert.ok(await until(async () => ((await statusOf(sock, 300)) || { held: [] }).held.includes('ses_hold')), 'the session is held');
    const next = newerCopy(home, first);
    fs.writeFileSync(path.join(home, 'runtime', 'current'), next + '\n');
    await sleep(1500);
    const held = await statusOf(sock, 1000);
    assert.deepStrictEqual([held.pid, held.version], [before.pid, VERSION], 'a held session keeps the intake where it is');
    // the same, with no session held (a new home: a held session is let go only after 30 quiet minutes)
    const home2 = path.join(base, 'h2');
    const first2 = installRuntime({ home: home2, from: ROOT }).folder;
    assert.strictEqual(run('bin/orunmila.js', { args: ['intake', 'start'], env: env(home2) }).status, 0);
    const sock2 = intakePaths(home2).sock;
    const was = await statusOf(sock2, 1000);
    fs.writeFileSync(path.join(home2, 'runtime', 'current'), newerCopy(home2, first2) + '\n');
    assert.ok(await until(async () => {
      const st = await statusOf(sock2, 300);
      return Boolean(st && st.version === '9.9.9' && st.pid !== was.pid);
    }), 'the intake moved onto 9.9.9');
    const out = fs.readFileSync(intakePaths(home2).out, 'utf8');
    assert.ok(out.includes('moving onto 9.9.9'), out);
    assert.strictEqual(run('bin/orunmila.js', { args: ['intake', 'stop'], env: env(home2) }).status, 0);
  } finally {
    run('bin/orunmila.js', { args: ['intake', 'stop'], env: env(home) });
    run('bin/orunmila.js', { args: ['intake', 'stop'], env: env(path.join(base, 'h2')) });
    rmrf(base);
  }
});

it('PM2c3: the launch agent runs the intake through the starter when one is installed', () => {
  const x = plistFor({ node: '/n', script: '/repo/bin/orunmila.js', home: '/u/.orunmila', env: {}, args: ['/u/.orunmila/bin/orunmila-start.js', 'bin/orunmila.js', 'intake', 'run'] });
  assert.ok(x.includes('<key>ProgramArguments</key>\n  <array>\n    <string>/n</string>\n    <string>/u/.orunmila/bin/orunmila-start.js</string>\n    <string>bin/orunmila.js</string>\n    <string>intake</string>\n    <string>run</string>\n  </array>'), x);
  const base = tmpDir();
  try {
    const home = path.join(base, 'h');
    installRuntime({ home, from: ROOT });
    const agents = path.join(base, 'agents');
    // launchctl replaced by a program that does nothing and exits 0: the real launchd is never touched
    // CI2 (LD341): the Startup folder fenced too: on Windows the agent is W2b's Startup script, tested in intake-keep.js
    const r = run('bin/orunmila.js', { args: ['intake', 'agent', 'install'], env: { ...env(home), ORUNMILA_LAUNCH_AGENTS_DIR: agents, ORUNMILA_LAUNCHCTL: '/usr/bin/true', ORUNMILA_STARTUP_DIR: path.join(base, 'Startup') } });
    if (process.platform === 'win32') {
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      return;
    }
    if (process.platform !== 'darwin') {
      assert.strictEqual(r.status, 1, 'the launch agent is macOS only');
      return;
    }
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const plist = fs.readFileSync(path.join(agents, 'dev.orunmila.intake.plist'), 'utf8');
    assert.ok(plist.includes(`<string>${path.join(home, 'bin', 'orunmila-start.js')}</string>\n    <string>bin/orunmila.js</string>`), plist);
  } finally {
    rmrf(base);
  }
});

runAll('intake-update');
