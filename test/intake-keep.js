// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/intake-keep.js — W2b (LD338; Phase 5 plan section 7): the intake started at login on Windows, and kept running.
 * `orunmila intake keep` runs the intake and starts it again after a failed exit, as the launch agent's KeepAlive does
 * on macOS (a crash, a stop no one asked for: TE2's exit 1; a move onto an update: PM2c3's exit 75); a stop asked for
 * (exit 0) ends it too. On Windows, `orunmila intake agent install` writes `orunmila-intake.vbs` into the user's Startup
 * folder (no administrator rights), which runs the keeper hidden, through the starter, with the switches the launch
 * agent keeps. The Startup script and the keeper are checked here on any OS (the platform given); a real Windows login
 * is not run here.
 */

const { spawn } = require('child_process');
const { assert, fs, path, ROOT, tmpDir, rmrf, run, sleep, it, runAll } = require('./helpers');
const { intakePaths, statusOf } = require('../src/opon/intake/server');
const { vbsFor, createStartup, STARTUP_NAME } = require('../src/opon/intake/startup-win');
const { installRuntime } = require('../src/runtime/install');

async function until(cond, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(50);
  }
  return cond();
}

it('W2b: the Startup script runs node on its arguments hidden, each quoted (a quote in a path doubled), with only the switches that are set', () => {
  const x = vbsFor({ node: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\Users\\Jane "J" Doe\\.orunmila\\bin\\orunmila-start.js', 'bin/orunmila.js', 'intake', 'keep'], env: { ORUNMILA_HOME: 'C:\\Users\\Jane "J" Doe\\.orunmila', ORUNMILA_OPON_LIVE: '1', ORUNMILA_PEER_BUSY: '', PATH: 'x', SECRET_TOKEN: 'y' } });
  assert.ok(x.includes('Set sh = CreateObject("WScript.Shell")'), x);
  assert.ok(x.includes('env("ORUNMILA_HOME") = "C:\\Users\\Jane ""J"" Doe\\.orunmila"'), x);
  assert.ok(x.includes('env("ORUNMILA_OPON_LIVE") = "1"'), x);
  assert.ok(!x.includes('ORUNMILA_PEER_BUSY') && !x.includes('PATH') && !x.includes('SECRET_TOKEN'), 'only the intake\'s switches, and only when set');
  assert.ok(x.includes('sh.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\Users\\Jane """"J"""" Doe\\.orunmila\\bin\\orunmila-start.js"" ""bin/orunmila.js"" ""intake"" ""keep""", 0, False'), x);
});

it('W2b: the Startup script is written into the Startup folder and removed, on Windows only; elsewhere it refuses and says what to use', () => {
  const dir = tmpDir();
  try {
    const win = createStartup({ platform: 'win32', dir });
    const r = win.install({ node: 'node.exe', args: ['a.js', 'intake', 'keep'], env: {} });
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.file, path.join(dir, STARTUP_NAME));
    const bytes = fs.readFileSync(r.file);
    assert.deepStrictEqual([bytes[0], bytes[1]], [0xff, 0xfe], 'UTF-16 with its byte-order mark, as Windows Script Host reads a path with any letter');
    assert.ok(bytes.subarray(2).toString('utf16le').includes('sh.Run'));
    assert.deepStrictEqual(win.status(), { ok: true, installed: true, file: r.file });
    assert.deepStrictEqual(win.uninstall(), { ok: true, removed: r.file });
    assert.deepStrictEqual(win.status(), { ok: true, installed: false, file: r.file });
    const mac = createStartup({ platform: 'darwin', dir });
    assert.deepStrictEqual([mac.install({ node: 'n', args: [], env: {} }).ok, /Windows only/.test(mac.install({ node: 'n', args: [], env: {} }).reason)], [false, true]);
  } finally {
    rmrf(dir);
  }
});

it('W2b: intake agent install on Windows writes the Startup script, which runs the keeper through the starter', () => {
  const base = tmpDir();
  try {
    const home = path.join(base, 'h');
    installRuntime({ home, from: ROOT });
    const startup = path.join(base, 'Startup');
    // launchctl and the LaunchAgents folder fenced off too: should the Windows branch ever be skipped, the macOS path
    // must never reach the real launchd (it would replace a real launch agent)
    const env = { ORUNMILA_HOME: home, ORUNMILA_AGENT_PLATFORM: 'win32', ORUNMILA_STARTUP_DIR: startup, ORUNMILA_OPON_LIVE: '1', ORUNMILA_LAUNCHCTL: '/usr/bin/false', ORUNMILA_LAUNCH_AGENTS_DIR: path.join(base, 'LaunchAgents') };
    const r = run('bin/orunmila.js', { args: ['intake', 'agent', 'install'], env });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const vbs = fs.readFileSync(path.join(startup, STARTUP_NAME)).subarray(2).toString('utf16le');
    assert.ok(vbs.includes(`""${path.join(home, 'bin', 'orunmila-start.js')}"" ""bin/orunmila.js"" ""intake"" ""keep""`), vbs);
    assert.ok(vbs.includes('env("ORUNMILA_OPON_LIVE") = "1"'), vbs);
    const st = run('bin/orunmila.js', { args: ['intake', 'agent', 'status'], env });
    assert.deepStrictEqual([st.status, st.stdout.includes('installed')], [0, true], st.stdout);
    const un = run('bin/orunmila.js', { args: ['intake', 'agent', 'uninstall'], env });
    assert.strictEqual(un.status, 0, un.stdout + un.stderr);
    assert.ok(!fs.existsSync(path.join(startup, STARTUP_NAME)));
  } finally {
    rmrf(base);
  }
});

it('W2b: intake keep starts the intake again after a stop no one asked for, and ends when a stop is asked for', async () => {
  if (process.platform === 'win32') return; // a signal to the intake is TE2's macOS and Linux case; the keeper's own loop is the same
  const base = tmpDir();
  const home = path.join(base, 'h');
  const env = { ...process.env, ORUNMILA_HOME: home, ORUNMILA_INTAKE_PORT: '0', ORUNMILA_UPDATES: '' };
  const keeper = spawn(process.execPath, [path.join(ROOT, 'bin', 'orunmila.js'), 'intake', 'keep'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  keeper.stdout.on('data', (d) => (out += d));
  keeper.stderr.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => keeper.on('exit', (code) => resolve(code)));
  const sock = intakePaths(home).sock;
  try {
    assert.ok(await until(async () => (await statusOf(sock, 300)) !== null), 'the kept intake answers: ' + out);
    const first = (await statusOf(sock, 1000)).pid;
    process.kill(first, 'SIGTERM'); // a stop no one asked for: TE2 records it and exits 1
    assert.ok(await until(async () => {
      const st = await statusOf(sock, 300);
      return Boolean(st && st.pid !== first);
    }), 'started again: ' + out);
    assert.ok(out.includes('starting it again'), out);
    const r = run('bin/orunmila.js', { args: ['intake', 'stop'], env: { ORUNMILA_HOME: home } });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(await exited, 0, 'a stop asked for ends the keeper: ' + out);
  } catch (e) {
    keeper.kill('SIGKILL');
    const st = await statusOf(sock, 300);
    if (st) process.kill(st.pid, 'SIGKILL');
    throw e;
  } finally {
    rmrf(base);
  }
});

it('W2b with PM2c3: a kept intake moving onto an update exits 75, and the keeper starts the new version (never a second copy of its own)', async () => {
  const base = tmpDir();
  const home = path.join(base, 'h');
  const first = installRuntime({ home, from: ROOT }).folder;
  const env = { ...process.env, ORUNMILA_HOME: home, ORUNMILA_INTAKE_PORT: '0', ORUNMILA_UPDATES: '', ORUNMILA_UPDATE_POLL_MS: '200', XPC_SERVICE_NAME: '' };
  const keeper = spawn(process.execPath, [path.join(ROOT, 'bin', 'orunmila.js'), 'intake', 'keep'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  keeper.stdout.on('data', (d) => (out += d));
  keeper.stderr.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => keeper.on('exit', (code) => resolve(code)));
  const sock = intakePaths(home).sock;
  try {
    assert.ok(await until(async () => (await statusOf(sock, 300)) !== null), 'the kept intake answers: ' + out);
    const next = '9.9.9_000000000000';
    fs.cpSync(path.join(home, 'runtime', first), path.join(home, 'runtime', next), { recursive: true });
    const pkg = JSON.parse(fs.readFileSync(path.join(home, 'runtime', next, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(home, 'runtime', next, 'package.json'), JSON.stringify({ ...pkg, version: '9.9.9' }));
    fs.writeFileSync(path.join(home, 'runtime', 'current'), next + '\n');
    assert.ok(await until(async () => ((await statusOf(sock, 300)) || {}).version === '9.9.9'), 'the keeper started 9.9.9: ' + out);
    assert.ok(out.includes('exited 75'), out);
    const r = run('bin/orunmila.js', { args: ['intake', 'stop'], env: { ORUNMILA_HOME: home } });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(await exited, 0, 'one intake, kept by one keeper: ' + out);
  } catch (e) {
    keeper.kill('SIGKILL');
    const st = await statusOf(sock, 300);
    if (st) process.kill(st.pid, 'SIGKILL');
    throw e;
  } finally {
    rmrf(base);
  }
});

runAll('intake-keep');
