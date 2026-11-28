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

it("F24: in a Cursor project, status and lenses read Cursor's hooks file: the Stain Map on, for Cursor; a Cursor hook whose script is gone is named; a folder with no agent's hooks reads as before", () => {
  const project = fs.realpathSync(tmpDir());
  const home = tmpDir();
  try {
    const here = path.join(project, 'kept', 'src', 'capture');
    fs.mkdirSync(here, { recursive: true });
    fs.writeFileSync(path.join(here, 'connector.js'), '// there\n');
    const cmd = (p, phase) => `node "${p}" cursor ${phase}`;
    fs.mkdirSync(path.join(project, '.cursor'));
    fs.writeFileSync(path.join(project, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { postToolUse: [{ command: cmd(path.join(here, 'connector.js'), 'postTool') }], afterAgentResponse: [{ command: cmd(path.join(project, 'gone', 'connector.js'), 'stop') }] } }));
    const st = run('bin/orunmila.js', { args: ['status'], env: { ORUNMILA_HOME: home }, cwd: project });
    assert.ok(st.stdout.includes('Lenses (Cursor): Stain Map \x1b[32mon\x1b[0m'), st.stdout);
    assert.ok(!st.stdout.includes('Lenses: Stain Map'), 'no Claude Code line for a folder with only Cursor hooks');
    assert.ok(st.stdout.includes(`[afterAgentResponse] ${path.join(project, 'gone', 'connector.js')}`), st.stdout);
    assert.strictEqual(st.status, 1, 'a hook naming a missing script exits 1');
    const ln = run('bin/orunmila.js', { args: ['lenses'], env: { ORUNMILA_HOME: home }, cwd: project });
    assert.ok(ln.stdout.includes(path.join(project, '.cursor', 'hooks.json')), ln.stdout);
    assert.ok(/The Stain Map\s+.\[32m✓ installed/.test(ln.stdout), ln.stdout); // . is the colour code's escape character
    const asked = run('bin/orunmila.js', { args: ['status', '--agent', 'claude-code'], env: { ORUNMILA_HOME: home }, cwd: project });
    assert.ok(asked.stdout.includes('Lenses: Stain Map \x1b[2moff\x1b[0m'), '--agent still names the one asked for: ' + asked.stdout);
    const empty = fs.realpathSync(tmpDir());
    try {
      const none = run('bin/orunmila.js', { args: ['status'], env: { ORUNMILA_HOME: home }, cwd: empty });
      assert.ok(none.stdout.includes('Lenses: Stain Map \x1b[2moff\x1b[0m'), none.stdout);
    } finally {
      rmrf(empty);
    }
  } finally {
    rmrf(project);
    rmrf(home);
  }
});

it("F42: status counts sessions by their ids only: the Sentinel's rows, which name no session, are not a session", () => {
  const project = fs.realpathSync(tmpDir());
  const home = tmpDir();
  try {
    const ev = (o) => JSON.stringify({ ts: '2026-11-28T09:00:00.000Z', ...o });
    fs.writeFileSync(path.join(home, 'events.jsonl'), [ev({ session_id: 's-one', turn_id: 't1', type: 'user_prompt', text: 'go' }), ev({ session_id: null, source: 'fs-sentinel', type: 'file_write', path: '/p/a.js' }), ev({ session_id: null, source: 'fs-sentinel', type: 'file_write', path: '/p/b.js' })].join('\n') + '\n');
    fs.writeFileSync(path.join(home, 'log-state.json'), JSON.stringify({ schema: 2 }));
    const st = run('bin/orunmila.js', { args: ['status'], env: { ORUNMILA_HOME: home }, cwd: project });
    assert.ok(st.stdout.includes('Sessions seen: 1\n'), st.stdout);
  } finally {
    rmrf(project);
    rmrf(home);
  }
});

runAll('status-hooks');
