// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/update-auto.js — PM2c2 (LD333; Phase 5 plan section 6, Q33): the daily update check, and the setting that turns
 * it on and off. `orunmila install --with-updates | --without-updates` sets `updates` in Orunmila's switches
 * (ORUNMILA_UPDATES=1 or 0 wins where set); with it on, at most once a day, the starter (on a hook) or the intake
 * starts `orunmila update --auto` on its own, detached, so no hook waits for the network. `update --auto` does nothing
 * with the switch off or while another one runs, and leaves its answer in `runtime/last-update`. Off with no switch at
 * all; a plain install sets it on unless it is set already (UD1). The registry here is an address nothing answers on;
 * nothing reaches the internet.
 */

const { spawn, spawnSync } = require('child_process');
const { assert, fs, path, ROOT, tmpDir, rmrf, run, sleep, it, runAll } = require('./helpers');
const { installRuntime } = require('../src/runtime/install');
const { readSwitches, setUpdates, updatesOn, switchesFile } = require('../src/opon/intake/switches');
const { intakePaths, statusOf } = require('../src/opon/intake/server');

const NOWHERE = 'http://127.0.0.1:9'; // the discard port: nothing answers, so the update is refused at once
async function until(cond, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(50);
  }
  return cond();
}
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const lastCheck = (home) => path.join(home, 'runtime', 'last-check');
const lastUpdate = (home) => path.join(home, 'runtime', 'last-update');
const env = (home, extra = {}) => ({ ...process.env, ORUNMILA_HOME: home, ORUNMILA_REGISTRY: NOWHERE, ORUNMILA_UPDATES: '', ORUNMILA_INTAKE_PORT: '0', ...extra });

it('PM2c2: the updates switch is off with no file, on and off as written, other switches kept; the environment wins where set', () => {
  const home = tmpDir();
  try {
    assert.deepStrictEqual(updatesOn({}, home), { on: false, from: 'default' });
    fs.mkdirSync(path.join(home, 'intake'), { recursive: true });
    fs.writeFileSync(switchesFile(home), JSON.stringify({ judge: true }));
    setUpdates(home, true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(switchesFile(home), 'utf8')), { judge: true, updates: true });
    assert.deepStrictEqual(readSwitches(home).judge, true, 'the judge kept');
    assert.deepStrictEqual(updatesOn({}, home), { on: true, from: 'switch' });
    assert.deepStrictEqual(updatesOn({ ORUNMILA_UPDATES: '0' }, home), { on: false, from: 'environment' });
    setUpdates(home, false);
    assert.deepStrictEqual(updatesOn({ ORUNMILA_UPDATES: '1' }, home), { on: true, from: 'environment' });
    fs.writeFileSync(switchesFile(home), JSON.stringify({ updates: 'yes' }));
    assert.deepStrictEqual(updatesOn({}, home), { on: false, from: 'default' }, 'neither true nor false: off');
  } finally {
    rmrf(home);
  }
});

it('PM2c2: install --with-updates turns the daily check on and says what it sends; --without-updates turns it off; no hook is installed', () => {
  const base = tmpDir();
  const home = path.join(base, 'h');
  const project = path.join(base, 'p');
  fs.mkdirSync(project, { recursive: true });
  try {
    const on = run('bin/orunmila.js', { args: ['install', '--with-updates'], env: env(home), cwd: project });
    assert.strictEqual(on.status, 0, on.stdout + on.stderr);
    assert.ok(on.stdout.includes('Daily updates are on'), on.stdout);
    assert.ok(on.stdout.includes("only the package's name"), on.stdout);
    assert.deepStrictEqual(updatesOn({}, home), { on: true, from: 'switch' });
    assert.ok(!fs.existsSync(path.join(project, '.claude')), 'no hook written');
    const off = run('bin/orunmila.js', { args: ['install', '--without-updates'], env: env(home), cwd: project });
    assert.ok(off.stdout.includes('Daily updates are off'), off.stdout);
    assert.deepStrictEqual(updatesOn({}, home), { on: false, from: 'switch' });
  } finally {
    rmrf(base);
  }
});

// UD1 (O's word, 2026-11-27, with MR7 and Q38; Q33's plan): a user's install turns the daily check on, unless the
// switch is already set either way; the fallback with no switch at all stays off, so a home no install made never
// asks the registry.
it('UD1: a plain install turns the daily check on when the switch is unset, and says how to turn it off; a switch already set is kept', () => {
  const base = tmpDir();
  try {
    for (const [name, before, after] of [
      ['unset', null, true],
      ['off', false, false],
      ['on', true, true],
    ]) {
      const home = path.join(base, name, 'h');
      const project = path.join(base, name, 'p');
      fs.mkdirSync(project, { recursive: true });
      if (before !== null) setUpdates(home, before);
      const r = run('bin/orunmila.js', { args: ['install'], env: env(home), cwd: project });
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      assert.deepStrictEqual(updatesOn({}, home), { on: after, from: 'switch' }, name);
      const said = r.stdout.includes('Daily updates are on: once a day Orunmila asks the npm registry for its latest version');
      assert.strictEqual(said, before === null, `${name}: ${r.stdout}`);
      if (said) assert.ok(r.stdout.includes('Turn them off with: orunmila install --without-updates'), r.stdout);
    }
  } finally {
    rmrf(base);
  }
});

/** A home with a runtime copy and the starter (PM2b); the prompt hook run through the starter. */
function homeWithCopy(base) {
  const home = path.join(base, 'h');
  installRuntime({ home, from: ROOT });
  return home;
}
const hook = (home, e) => spawnSync(process.execPath, [path.join(home, 'bin', 'orunmila-start.js'), 'src/capture/claude-code/user-prompt-submit.js'], { input: JSON.stringify({ session_id: 'pm2c2', transcript_path: '/none', cwd: path.dirname(home), hook_event_name: 'UserPromptSubmit', prompt: 'x' }), env: e, encoding: 'utf8' });

it('PM2c2: with the switch on, a hook through the starter starts one update in the background, at most once a day; off, or checked within the day, it starts none; the hook runs either way', async () => {
  const base = tmpDir();
  try {
    const home = homeWithCopy(base);
    const none = hook(home, env(home));
    assert.strictEqual(none.status, 0, none.stderr);
    assert.strictEqual(read(lastCheck(home)), null, 'no switch: no check');
    setUpdates(home, false);
    const off = hook(home, env(home));
    assert.strictEqual(off.status, 0, off.stderr);
    assert.strictEqual(read(lastCheck(home)), null, 'switched off: no check');
    setUpdates(home, true);
    const t0 = Date.now();
    const on = hook(home, env(home));
    assert.strictEqual(on.status, 0, on.stderr);
    assert.ok(Date.now() - t0 < 10000, 'the hook does not wait for the update');
    assert.ok(read(lastCheck(home)), 'checked now');
    assert.ok(await until(() => read(lastUpdate(home)) !== null), 'the update ran in the background');
    assert.ok(read(lastUpdate(home)).includes('refused'), read(lastUpdate(home)));
    fs.rmSync(lastUpdate(home));
    hook(home, env(home));
    await sleep(1500);
    assert.strictEqual(read(lastUpdate(home)), null, 'checked within the day: none started');
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString() + '\n';
    fs.writeFileSync(lastCheck(home), old);
    hook(home, env(home, { ORUNMILA_UPDATES: '0' }));
    await sleep(1500);
    assert.deepStrictEqual([read(lastUpdate(home)), read(lastCheck(home))], [null, old], 'the environment turns it off: not even marked');
  } finally {
    rmrf(base);
  }
});

it('PM2c2: update --auto does nothing with the switch off or while another runs; on, it records its answer in last-update', () => {
  const base = tmpDir();
  try {
    const home = homeWithCopy(base);
    const off = run('bin/orunmila.js', { args: ['update', '--auto'], env: env(home) });
    assert.deepStrictEqual([off.status, read(lastUpdate(home))], [0, null], off.stdout);
    setUpdates(home, true);
    fs.writeFileSync(path.join(home, 'runtime', 'update.lock'), String(process.pid));
    const locked = run('bin/orunmila.js', { args: ['update', '--auto'], env: env(home) });
    assert.deepStrictEqual([locked.status, read(lastUpdate(home))], [0, null], 'another update holds the lock');
    fs.rmSync(path.join(home, 'runtime', 'update.lock'));
    const on = run('bin/orunmila.js', { args: ['update', '--auto'], env: env(home) });
    assert.strictEqual(on.status, 0, on.stdout + on.stderr);
    assert.ok(/^\S+Z refused: /.test(read(lastUpdate(home))), read(lastUpdate(home)));
    assert.ok(!fs.existsSync(path.join(home, 'runtime', 'update.lock')), 'the lock is let go');
  } finally {
    rmrf(base);
  }
});

it('PM2c2: intake run says whether the daily check is on, and with it on starts the update itself', async () => {
  const base = tmpDir();
  const home = homeWithCopy(base);
  setUpdates(home, true);
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'orunmila.js'), 'intake', 'run'], { env: env(home, { ORUNMILA_UPDATE_POLL_MS: '200' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    assert.ok(await until(async () => (await statusOf(intakePaths(home).sock, 300)) !== null), 'the intake answers: ' + out);
    assert.ok(await until(() => out.includes('the daily update check is on')), out);
    assert.ok(await until(() => read(lastUpdate(home)) !== null), 'the intake started the update: ' + out);
    const r = run('bin/orunmila.js', { args: ['intake', 'stop'], env: { ORUNMILA_HOME: home } });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(await exited, 0);
  } catch (e) {
    child.kill('SIGKILL');
    await exited;
    throw e;
  } finally {
    rmrf(base);
  }
});

runAll('update-auto');
