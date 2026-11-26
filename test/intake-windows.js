// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/intake-windows.js — the intake on Windows, the parts that can be checked on any OS (Phase 5 plan section 7,
 * slice W2a, LD298). On Windows the intake listens on a named pipe, not a Unix socket file: one per Orunmila home,
 * named from it, so two homes never meet; the command-hook sender, which loads no other repository file (LD122),
 * names the same pipe. The rest of W2 (the intake's suites on windows-latest) runs in CI.
 */

const crypto = require('crypto');
const { assert, path, it, runAll } = require('./helpers');
const { intakePaths } = require('../src/opon/intake/server');
const { sockPath } = require('../src/capture/claude-code/intake-send');

it("W2a (LD298): on Windows the intake's address is a named pipe named from its home; elsewhere the socket file in <home>/intake", () => {
  const home = path.resolve('/Users/someone/.orunmila');
  const hex = crypto.createHash('sha256').update(home).digest('hex').slice(0, 16);
  assert.strictEqual(intakePaths(home, 'win32').sock, `\\\\?\\pipe\\orunmila-intake-${hex}`);
  assert.notStrictEqual(intakePaths(path.resolve('/Users/other/.orunmila'), 'win32').sock, intakePaths(home, 'win32').sock, 'two homes, two pipes');
  assert.strictEqual(intakePaths(home, 'darwin').sock, path.join(home, 'intake', 'intake.sock'));
  assert.strictEqual(intakePaths(home, 'linux').sock, path.join(home, 'intake', 'intake.sock'));
});

it("W2a: the command-hook sender and the gate's sender name the same address as the intake, on every platform", () => {
  const gate = require('../src/capture/claude-code/gate-send').sockPath;
  for (const platform of ['win32', 'darwin', 'linux']) {
    const home = path.resolve('/tmp/some home/.orunmila');
    assert.strictEqual(sockPath(home, platform), intakePaths(home, platform).sock, `intake-send ${platform}`);
    assert.strictEqual(gate(home, platform), intakePaths(home, platform).sock, `gate-send ${platform}`);
  }
});

it('W4b (LD343): on Windows a published pipe name (the home\'s, plus 32 hex) is the address for the intake and both senders; one for another home, or of another shape, is ignored', () => {
  const fs = require('fs');
  const { tmpDir, rmrf } = require('./helpers');
  const gate = require('../src/capture/claude-code/gate-send').sockPath;
  const home = tmpDir();
  try {
    const base = intakePaths(home, 'win32').sock;
    fs.mkdirSync(path.join(home, 'intake'));
    const file = path.join(home, 'intake', 'address');
    const fresh = `${base}-${'ab'.repeat(16)}`;
    fs.writeFileSync(file, fresh + '\n');
    const paths = intakePaths(home, 'win32');
    for (const [who, got] of [['intake', paths.sock], ['intake-send', sockPath(home, 'win32')], ['gate-send', gate(home, 'win32')]]) assert.strictEqual(got, fresh, who);
    assert.strictEqual(paths.address, file);
    const other = intakePaths(path.resolve('/Users/other/.orunmila'), 'win32').sock;
    for (const bad of [`${other}-${'ab'.repeat(16)}`, `${base}-xyz`, `${base}-${'AB'.repeat(16)}`, '\\\\?\\pipe\\anything', '']) {
      fs.writeFileSync(file, bad + '\n');
      for (const [who, got] of [['intake', paths.sock], ['intake-send', sockPath(home, 'win32')], ['gate-send', gate(home, 'win32')]]) assert.strictEqual(got, base, `${who}: ${JSON.stringify(bad)} ignored`);
    }
    assert.strictEqual(intakePaths(home, 'darwin').sock, path.join(home, 'intake', 'intake.sock'), 'elsewhere the socket file, whatever is published');
  } finally {
    rmrf(home);
  }
});

runAll('intake-windows');
