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

runAll('intake-windows');
