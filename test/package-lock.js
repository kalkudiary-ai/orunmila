// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/package-lock.js — CF3 (LD385): an install command's packages, from npm's lock file before and after it. Lock
 * files are hand-built in npm's documented shapes (lockfileVersion 3's `packages`, 1's nested `dependencies`); throwaway
 * folders only.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { installManager, readLock, lockChange, MAX_LISTED } = require('../src/capture/package-lock');

const v3 = (pkgs) => JSON.stringify({ name: 'p', lockfileVersion: 3, requires: true, packages: { '': { name: 'p' }, ...pkgs } });

it('CF3 (LD385): which commands install packages, and with which manager', () => {
  const yes = [['npm install', 'npm'], ['npm i left-pad', 'npm'], ['npm ci', 'npm'], ['cd web && npm add react', 'npm'], ['npm uninstall x', 'npm'], ['npm update', 'npm'], ['npm audit fix', 'npm'], ['CI=1 npm install --no-audit', 'npm'], ['yarn', 'yarn'], ['yarn add x', 'yarn'], ['pnpm i', 'pnpm'], ['pnpm remove x', 'pnpm'], ['bun install', 'bun']];
  for (const [c, m] of yes) assert.strictEqual(installManager(c), m, c);
  for (const c of ['npm test', 'npm run build', 'npm audit', 'echo npm install', 'yarn test', 'pnpm run lint', 'ls node_modules', '']) assert.strictEqual(installManager(c), null, c);
});

it('CF3: the change between two lock files: added, changed, removed, each with its version and install script, sorted', () => {
  const dir = tmpDir();
  try {
    const lock = path.join(dir, 'package-lock.json');
    fs.writeFileSync(lock, v3({ 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '2.0.0' }, 'node_modules/gone': { version: '0.1.0' }, 'packages/ws': { version: '1.0.0' } }));
    const before = readLock(dir);
    fs.writeFileSync(lock, v3({ 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '2.1.0', hasInstallScript: true }, 'node_modules/@s/esb': { version: '0.19.2', hasInstallScript: true }, 'node_modules/b/node_modules/c': { version: '3.0.0' } }));
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '# a stray yarn lock\n');
    const d = lockChange('npm', before, readLock(dir), dir);
    assert.deepStrictEqual(d, {
      manager: 'npm',
      lock: 'package-lock.json',
      added: [{ name: '@s/esb', version: '0.19.2', install_script: true }, { name: 'b/node_modules/c', version: '3.0.0', install_script: false }],
      changed: [{ name: 'b', from: '2.0.0', to: '2.1.0', install_script: true }],
      removed: [{ name: 'gone', version: '0.1.0' }],
      not_read: ['yarn.lock'],
    });
  } finally {
    rmrf(dir);
  }
});

it("CF3: npm's older lock (v1) is read too, its install scripts unknown; npm-shrinkwrap.json wins over package-lock.json, as npm reads it", () => {
  const dir = tmpDir();
  try {
    const v1 = (deps) => JSON.stringify({ name: 'p', lockfileVersion: 1, dependencies: deps });
    fs.writeFileSync(path.join(dir, 'package-lock.json'), v1({ a: { version: '1.0.0' } }));
    const before = readLock(dir);
    fs.writeFileSync(path.join(dir, 'package-lock.json'), v1({ a: { version: '1.0.0', dependencies: { c: { version: '2.0.0' } } } }));
    assert.deepStrictEqual(lockChange('npm', before, readLock(dir), dir).added, [{ name: 'a/node_modules/c', version: '2.0.0', install_script: null }]);
    fs.writeFileSync(path.join(dir, 'npm-shrinkwrap.json'), v3({ 'node_modules/z': { version: '9.0.0' } }));
    assert.strictEqual(readLock(dir).file, 'npm-shrinkwrap.json');
  } finally {
    rmrf(dir);
  }
});

it("CF3: another manager's lock is named, not read; no state before, or a lock that is not JSON, says so; a long list is cut and counted", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    assert.deepStrictEqual(lockChange('pnpm', readLock(dir), readLock(dir), dir), { manager: 'pnpm', lock: null, added: [], changed: [], removed: [], not_read: ['pnpm-lock.yaml'] });
    fs.writeFileSync(path.join(dir, 'package-lock.json'), v3({}));
    assert.strictEqual(lockChange('npm', undefined, readLock(dir), dir).before_unknown, true);
    fs.writeFileSync(path.join(dir, 'package-lock.json'), v3({ 'node_modules/n': { version: '1.0.0' } }));
    assert.deepStrictEqual(lockChange('npm', null, readLock(dir), dir).added, [{ name: 'n', version: '1.0.0', install_script: false }], 'no lock before: all added');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), v3({}));
    const bad = readLock(dir);
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{not json');
    assert.strictEqual(lockChange('npm', bad, readLock(dir), dir).unreadable, true);
    const many = {};
    for (let i = 0; i < MAX_LISTED + 5; i++) many[`node_modules/p${String(i).padStart(4, '0')}`] = { version: '1.0.0' };
    fs.writeFileSync(path.join(dir, 'package-lock.json'), v3({}));
    const empty = readLock(dir);
    fs.writeFileSync(path.join(dir, 'package-lock.json'), v3(many));
    const d = lockChange('npm', empty, readLock(dir), dir);
    assert.deepStrictEqual([d.added.length, d.cut], [MAX_LISTED, 5]);
  } finally {
    rmrf(dir);
  }
});

runAll('package-lock');
