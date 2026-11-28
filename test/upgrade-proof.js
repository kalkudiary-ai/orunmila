// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/upgrade-proof.js — EU2's permanent half (LD371, LD379): scripts/upgrade-proof.js installs an earlier Orunmila,
 * uses it, upgrades it to this build and checks every step. CI runs it from the published 0.2.4 on Windows, Linux and
 * macOS (the `upgrade` job, which needs the network); here it runs offline from a tarball of this repository, and once
 * with a hook naming a different copy planted in the project, which install must refuse, so the proof must fail.
 */

const { assert, fs, path, ROOT, it, runAll } = require('./helpers');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(ROOT, 'scripts', 'upgrade-proof.js');
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 600000, env: { ...process.env, ORUNMILA_INTAKE_PORT: '0' } });
const steps = (out) => out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));

it('EU2: from an earlier copy to this build: every step passes (installed, used, upgraded, hooks moved and none added, capture continues, old log kept, status, the kept commands)', () => {
  const r = run(['--from', 'self']);
  const s = steps(r.stdout);
  const names = s.map((x) => x.step);
  for (const want of ['installed', 'used', 'upgraded', 'install-again', 'hooks-moved', 'capture-continues', 'old-log-kept', 'status', 'kept-commands']) assert.ok(names.includes(want), `${want}: ${r.stdout}${r.stderr}`);
  assert.deepStrictEqual(s.filter((x) => x.step !== 'done' && !x.ok).map((x) => x.step), [], r.stdout + r.stderr);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

it('EU2: a hook naming a different copy, planted before the upgrade, is refused by install, and the proof fails on it', () => {
  const r = run(['--from', 'self', '--plant-foreign-hook']);
  const again = steps(r.stdout).find((x) => x.step === 'install-again');
  assert.ok(again && again.ok === false, r.stdout + r.stderr);
  assert.strictEqual(r.status, 1);
});

it("EU2: CI runs the proof from the published 0.2.4 on Windows, Linux and macOS", () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = ci.slice(ci.indexOf('\n  upgrade:'), ci.indexOf('\n  gates:'));
  assert.ok(job.includes('os: [ubuntu-latest, macos-latest, windows-latest]'), job);
  assert.ok(job.includes('node scripts/upgrade-proof.js --from orunmila@0.2.4'), job);
});

runAll('upgrade-proof');
