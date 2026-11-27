// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/launch-agent.js — the per-user launch agent that keeps one intake
 * running (slice LA, LD143; design D-I 4.1; LD141). Every launchctl call goes
 * to a fake that records it; the plist goes to a throwaway folder. No real
 * launch agent is touched.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll, notOnWindows } = require('./helpers');
const { createLaunchAgent, plistFor, LABEL } = require('../src/opon/intake/launch-agent');

function fake(answers = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const a = answers[args[0]];
    return typeof a === 'function' ? a(args) : a || { status: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

const withDir = (fn) => () => {
  const dir = tmpDir();
  try {
    fn(dir);
  } finally {
    rmrf(dir);
  }
};

const BASE = { node: '/opt/node/bin/node', script: '/repo/bin/orunmila.js', home: '/u/.orunmila' };

it('LA: the plist runs `intake run` with the absolute node and script, at load, kept alive only after a failed exit', () => {
  const x = plistFor({ ...BASE, env: {} });
  assert.ok(x.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist'), 'an XML property list');
  assert.ok(x.includes(`<key>Label</key>\n  <string>${LABEL}</string>`));
  assert.ok(x.includes('<key>ProgramArguments</key>\n  <array>\n    <string>/opt/node/bin/node</string>\n    <string>/repo/bin/orunmila.js</string>\n    <string>intake</string>\n    <string>run</string>\n  </array>'));
  assert.ok(x.includes('<key>RunAtLoad</key>\n  <true/>'));
  assert.ok(x.includes('<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>'), 'restarted only after a failed exit: a stop asked for exits 0 and stays stopped (a signal no one asked for exits 1, TE2)');
  assert.ok(x.includes('<key>ThrottleInterval</key>\n  <integer>10</integer>'));
  assert.ok(x.includes('<key>StandardOutPath</key>\n  <string>/u/.orunmila/intake/intake.out</string>'));
  assert.ok(x.includes('<key>StandardErrorPath</key>\n  <string>/u/.orunmila/intake/intake.out</string>'));
  assert.ok(!x.includes('EnvironmentVariables'), 'no environment when none was set');
});

it('LA: the plist carries ORUNMILA_HOME and ORUNMILA_INTAKE_PORT only when set, and escapes XML', () => {
  const x = plistFor({ ...BASE, script: '/a&b/<c>/orunmila.js', env: { ORUNMILA_HOME: '/h', ORUNMILA_INTAKE_PORT: '47391', PATH: '/bin', SECRET_TOKEN: 'x' } });
  assert.ok(x.includes('<string>/a&amp;b/&lt;c&gt;/orunmila.js</string>'));
  assert.ok(x.includes('<key>EnvironmentVariables</key>\n  <dict>\n    <key>ORUNMILA_HOME</key>\n    <string>/h</string>\n    <key>ORUNMILA_INTAKE_PORT</key>\n    <string>47391</string>\n  </dict>'));
  assert.ok(!x.includes('PATH') && !x.includes('SECRET_TOKEN'), 'no other variable is copied');
});

it('LA2 (Q7, LD219): the plist carries ORUNMILA_OPON_LIVE when set, so an agent installed with the live flag keeps it across restarts and logins; unset, none', () => {
  const on = plistFor({ ...BASE, env: { ORUNMILA_OPON_LIVE: '1' } });
  assert.ok(on.includes('<key>EnvironmentVariables</key>\n  <dict>\n    <key>ORUNMILA_OPON_LIVE</key>\n    <string>1</string>\n  </dict>'), on);
  assert.ok(!plistFor({ ...BASE, env: { ORUNMILA_OPON_LIVE: '' } }).includes('ORUNMILA_OPON_LIVE'));
});

it("LA3 (LD290): the plist carries every flag the intake reads (the judge's, the log guard's, the extra folders), so an agent installed with them keeps them across restarts; unset, none", () => {
  const env = { ORUNMILA_JUDGE_LIVE: '1', ORUNMILA_LOG_GUARD: '1', ORUNMILA_WATCH_EXTRA: '/a:/b', ORUNMILA_ASYNC_START: '1', ORUNMILA_PEER_BUSY: '1', ORUNMILA_UPDATES: '1', ORUNMILA_REGISTRY: 'https://registry.example/', ORUNMILA_VCS_MARKS: '1', ORUNMILA_SENTINEL_MAX_PENDING: '5000' }; // SN1 (LD294), AT1b (LD330), PM2c2 (LD333), VC1 (LD372), T32 (LD374) too
  const on = plistFor({ ...BASE, env });
  for (const [k, v] of Object.entries(env)) assert.ok(on.includes(`<key>${k}</key>\n    <string>${v}</string>`), `${k}: ${on}`);
  const off = plistFor({ ...BASE, env: { ORUNMILA_JUDGE_LIVE: '', ORUNMILA_LOG_GUARD: '', ORUNMILA_WATCH_EXTRA: '' } });
  assert.ok(!off.includes('EnvironmentVariables'), off);
});

it(
  'LA: install writes the plist 0644 and bootstraps it after booting out any earlier one',
  withDir((dir) => {
    const f = fake({ bootout: { status: 3, stdout: '', stderr: 'Boot-out failed: 3: No such process' } });
    const a = createLaunchAgent({ platform: 'darwin', uid: 501, dir, run: f.run });
    const r = a.install({ ...BASE, env: {} });
    assert.strictEqual(r.ok, true, r.reason);
    const p = path.join(dir, `${LABEL}.plist`);
    assert.strictEqual(r.plist, p);
    assert.strictEqual(fs.readFileSync(p, 'utf8'), plistFor({ ...BASE, env: {} }));
    if (!notOnWindows('launch-agent: the plist is written 0644; Windows has no POSIX modes')) assert.strictEqual(fs.statSync(p).mode & 0o777, 0o644);
    assert.deepStrictEqual(f.calls, [
      ['bootout', `gui/501/${LABEL}`],
      ['bootstrap', 'gui/501', p],
    ]);
  }),
);

it(
  'LA: a second install replaces the first (one plist, booted out then bootstrapped again)',
  withDir((dir) => {
    const f = fake();
    const a = createLaunchAgent({ platform: 'darwin', uid: 501, dir, run: f.run });
    a.install({ ...BASE, env: {} });
    const r = a.install({ ...BASE, node: '/other/node', env: {} });
    assert.strictEqual(r.ok, true);
    assert.ok(fs.readFileSync(r.plist, 'utf8').includes('<string>/other/node</string>'));
    assert.deepStrictEqual(fs.readdirSync(dir), [`${LABEL}.plist`]);
    assert.strictEqual(f.calls.filter((c) => c[0] === 'bootstrap').length, 2);
  }),
);

it(
  'LA: a failed bootstrap is reported with launchctl\'s words, and the plist is removed again',
  withDir((dir) => {
    const f = fake({ bootstrap: { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' } });
    const a = createLaunchAgent({ platform: 'darwin', uid: 501, dir, run: f.run });
    const r = a.install({ ...BASE, env: {} });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes('Bootstrap failed: 5'), r.reason);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  }),
);

it(
  'LA: uninstall boots it out and removes the plist; with none installed it says so',
  withDir((dir) => {
    const f = fake();
    const a = createLaunchAgent({ platform: 'darwin', uid: 501, dir, run: f.run });
    a.install({ ...BASE, env: {} });
    f.calls.length = 0;
    const r = a.uninstall();
    assert.deepStrictEqual(r, { ok: true, removed: path.join(dir, `${LABEL}.plist`) });
    assert.deepStrictEqual(f.calls, [['bootout', `gui/501/${LABEL}`]]);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
    const again = a.uninstall();
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.removed, null);
  }),
);

it(
  "LA: status reads launchctl's pid and state; not loaded when launchctl knows no such service",
  withDir((dir) => {
    const printed = `${'gui/501/' + LABEL} = {\n\tactive count = 1\n\tstate = running\n\tpid = 4242\n\tprogram = /opt/node/bin/node\n}\n`;
    const a = createLaunchAgent({ platform: 'darwin', uid: 501, dir, run: fake({ print: { status: 0, stdout: printed, stderr: '' } }).run });
    assert.deepStrictEqual(a.status(), { ok: true, loaded: true, state: 'running', pid: 4242, plist: null });
    const b = createLaunchAgent({ platform: 'darwin', uid: 501, dir, run: fake({ print: { status: 113, stdout: '', stderr: 'Could not find service' } }).run });
    assert.deepStrictEqual(b.status(), { ok: true, loaded: false, state: null, pid: null, plist: null });
  }),
);

it(
  'LA: on another platform every action refuses and says why, and nothing is written or run',
  withDir((dir) => {
    const f = fake();
    const a = createLaunchAgent({ platform: 'linux', uid: 1000, dir, run: f.run });
    for (const r of [a.install({ ...BASE, env: {} }), a.uninstall(), a.status()]) {
      assert.strictEqual(r.ok, false);
      assert.ok(r.reason.includes('macOS only'), r.reason);
    }
    assert.deepStrictEqual(f.calls, []);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  }),
);

it(
  'LA CLI: intake agent install writes the plist for this node and this CLI, and names how to remove it',
  withDir((dir) => {
    if (process.platform !== 'darwin') return; // the command refuses elsewhere (tested above)
    const { spawnSync } = require('child_process');
    const calls = path.join(dir, 'calls.txt');
    const fakeCtl = path.join(dir, 'launchctl');
    fs.writeFileSync(fakeCtl, `#!/bin/sh\necho "$@" >> '${calls}'\nexit 0\n`, { mode: 0o755 });
    const agents = path.join(dir, 'LaunchAgents');
    const home = path.join(dir, 'home');
    const cli = path.join(__dirname, '..', 'bin', 'orunmila.js');
    const env = { ...process.env, ORUNMILA_LAUNCHCTL: fakeCtl, ORUNMILA_LAUNCH_AGENTS_DIR: agents, ORUNMILA_HOME: home };
    delete env.ORUNMILA_INTAKE_PORT;
    delete env.ORUNMILA_UPDATES; // UD1: test/helpers.js sets it to 0 for every test; this plist is the one with no switch set
    const r = spawnSync(process.execPath, [cli, 'intake', 'agent', 'install'], { encoding: 'utf8', env });
    assert.strictEqual(r.status, 0, r.stderr);
    const p = path.join(agents, `${LABEL}.plist`);
    assert.strictEqual(fs.readFileSync(p, 'utf8'), plistFor({ node: process.execPath, script: cli, home, env: { ORUNMILA_HOME: home } }));
    assert.ok(r.stdout.includes(`launchctl bootout gui/${process.getuid()}/${LABEL}`), r.stdout);
    const u = spawnSync(process.execPath, [cli, 'intake', 'agent', 'uninstall'], { encoding: 'utf8', env });
    assert.strictEqual(u.status, 0, u.stderr);
    assert.ok(!fs.existsSync(p));
    assert.deepStrictEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), [
      `bootout gui/${process.getuid()}/${LABEL}`,
      `bootstrap gui/${process.getuid()} ${p}`,
      `bootout gui/${process.getuid()}/${LABEL}`,
    ]);
  }),
);

runAll('launch-agent');
