'use strict';

/**
 * test/version.js — issue 2 (0.2.4): `orunmila --version` (and `-v`, `version`) prints the installed version
 * and exits 0; before 0.2.4 it printed the 49-line usage text and exited 1.
 */

const { assert, path, ROOT, it, runAll } = require('./helpers');
const { spawnSync } = require('child_process');

const BIN = path.join(ROOT, 'bin', 'orunmila.js');
const { version } = require('../package.json');

it('issue 2: --version, -v and version print the package version, one line, exit 0', () => {
  for (const flag of ['--version', '-v', 'version']) {
    const r = spawnSync(process.execPath, [BIN, flag], { encoding: 'utf8' });
    assert.deepStrictEqual([r.status, r.stdout, r.stderr], [0, `${version}\n`, ''], flag);
  }
});

it('an unknown command still prints the usage and exits 1; no command prints it and exits 0', () => {
  const bad = spawnSync(process.execPath, [BIN, 'no-such-command'], { encoding: 'utf8' });
  const none = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
  assert.deepStrictEqual([bad.status, bad.stdout.startsWith('orunmila - '), none.status, none.stdout.startsWith('orunmila - ')], [1, true, 0, true]);
});

runAll('version');
