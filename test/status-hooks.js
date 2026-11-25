// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/status-hooks.js — `orunmila status` names every hook whose script is missing (Phase 5 plan section 6, slice PM3,
 * LD291). An install made through a package runner's cache (npx, pnpm dlx) writes hooks that name files inside that
 * cache; when the cache is cleared they name files that are gone, and the agent's hooks then capture nothing. Status
 * says so, per hook, and exits 1. A throwaway project and home; made-up paths.
 */

const { assert, fs, path, tmpDir, rmrf, run, it, runAll } = require('./helpers');

it('PM3 (LD291): status names each hook whose script is missing, with its event and path, and exits 1; with every script there it names none and exits 0', () => {
  const project = fs.realpathSync(tmpDir());
  const home = tmpDir();
  try {
    const here = path.join(project, 'kept', 'src', 'capture', 'claude-code');
    fs.mkdirSync(here, { recursive: true });
    fs.writeFileSync(path.join(here, 'stop.js'), '// a script that is there\n');
    const gone = path.join(project, '.npm', '_npx', 'abc123', 'node_modules', 'orunmila', 'src', 'capture', 'claude-code', 'post-tool-use.js');
    const settings = {
      hooks: {
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${gone}"` }] }],
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: `node "${path.join(here, 'stop.js')}"` }] },
          { matcher: '*', hooks: [{ type: 'command', command: `node ${path.join(here, 'law-gate.js')} --marks` }] },
        ],
        UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'http', url: 'http://127.0.0.1:47390/' }] }],
      },
    };
    fs.mkdirSync(path.join(project, '.claude'));
    fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify(settings));
    const r = run('bin/orunmila.js', { args: ['status'], env: { ORUNMILA_HOME: home }, cwd: project });
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.ok(r.stdout.includes(`[PostToolUse] ${gone}`), r.stdout);
    assert.ok(r.stdout.includes(`[Stop] ${path.join(here, 'law-gate.js')}`), r.stdout);
    assert.ok(!r.stdout.includes(`[Stop] ${path.join(here, 'stop.js')}`), 'a script that is there is not named');
    assert.ok(/2 hooks name a script that is not there/.test(r.stdout), r.stdout);
    fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: settings.hooks.Stop.slice(0, 1) } }));
    const ok = run('bin/orunmila.js', { args: ['status'], env: { ORUNMILA_HOME: home }, cwd: project });
    assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
    assert.ok(!/not there/.test(ok.stdout), ok.stdout);
  } finally {
    rmrf(project);
    rmrf(home);
  }
});

runAll('status-hooks');
