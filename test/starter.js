// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/starter.js — PM2b (LD331; Phase 5 plan section 6, Q33): every hook `orunmila install` writes names one fixed
 * starter in Orunmila's home (`<home>/bin/orunmila-start.js`), and the starter runs the script of the version named in
 * `<home>/runtime/current`, a copy of the package kept in `<home>/runtime/<version>_<fingerprint>/`. So a hook never
 * names a path inside a package runner's cache, and still runs once that cache is cleared. A copy of this repository
 * under a fake npx cache folder, a throwaway project and a throwaway home; nothing real is touched.
 */

const { spawnSync } = require('child_process');
const { assert, fs, path, ROOT, tmpDir, rmrf, it, runAll } = require('./helpers');

const SHIPPED = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files;

/** A copy of what this package ships, under `<base>/npm-cache/_npx/<hash>/node_modules/orunmila`, as npx leaves it. */
function npxCopy(base) {
  const pkg = path.join(base, 'npm-cache', '_npx', '0123456789abcdef', 'node_modules', 'orunmila');
  fs.mkdirSync(pkg, { recursive: true });
  for (const f of [...SHIPPED, 'package.json']) fs.cpSync(path.join(ROOT, f), path.join(pkg, f), { recursive: true });
  return pkg;
}

const env = (base) => ({ ...process.env, HOME: path.join(base, 'user'), USERPROFILE: path.join(base, 'user'), ORUNMILA_HOME: path.join(base, 'orunmila home'), ORUNMILA_LAWS: '' });
const commands = (project) => {
  const s = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'));
  return Object.entries(s.hooks).flatMap(([event, entries]) => entries.flatMap((e) => (e.hooks || []).filter((h) => h.type === 'command').map((h) => ({ event, command: h.command }))));
};
const shell = (command, { input = '', env: e, cwd }) => spawnSync(command, { shell: true, input, env: e, cwd, encoding: 'utf8', timeout: 60000 });

function installed(base, args = []) {
  const pkg = npxCopy(base);
  const project = path.join(base, 'a project');
  fs.mkdirSync(project, { recursive: true });
  for (const d of ['user', 'orunmila home']) fs.mkdirSync(path.join(base, d), { recursive: true });
  const r = spawnSync(process.execPath, [path.join(pkg, 'bin', 'orunmila.js'), 'install', ...args], { env: env(base), cwd: project, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  return { pkg, project, home: path.join(base, 'orunmila home'), out: r.stdout };
}

it('PM2b: installed from npx\'s cache, every hook names the starter in Orunmila\'s home, and none names a path inside the cache', () => {
  const base = fs.realpathSync(tmpDir());
  try {
    const { project, home } = installed(base, ['--with-gate']);
    const all = commands(project);
    assert.ok(all.length >= 6, JSON.stringify(all));
    const starter = path.join(home, 'bin', 'orunmila-start.js');
    for (const c of all) {
      assert.ok(!c.command.includes('_npx') && !c.command.includes('npm-cache'), `${c.event}: ${c.command}`);
      assert.ok(c.command.startsWith(`node "${starter}" src/capture/`), `${c.event}: ${c.command}`);
    }
    assert.ok(fs.existsSync(starter), 'the starter is in the home');
    const current = fs.readFileSync(path.join(home, 'runtime', 'current'), 'utf8').trim();
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    assert.ok(new RegExp(`^${version.replace(/\./g, '\\.')}_[0-9a-f]{12}$`).test(current), current);
    for (const f of SHIPPED) assert.ok(fs.existsSync(path.join(home, 'runtime', current, f)), `the copy holds ${f}`);
  } finally {
    rmrf(base);
  }
});

it('PM2b: with the cache cleared, each hook still runs as written through the shell and records the prompt', () => {
  const base = fs.realpathSync(tmpDir());
  try {
    const { pkg, project, home } = installed(base);
    rmrf(path.join(base, 'npm-cache')); // npm cache clean, or a newer npx run under another hash
    assert.ok(!fs.existsSync(pkg));
    const prompt = commands(project).find((c) => c.event === 'UserPromptSubmit');
    const r = shell(prompt.command, { input: JSON.stringify({ session_id: 'pm2b-session', transcript_path: path.join(base, 't.jsonl'), cwd: project, hook_event_name: 'UserPromptSubmit', prompt: 'hello from the starter' }), env: env(base), cwd: project });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const events = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(events.some((e) => e.session_id === 'pm2b-session' && e.text === 'hello from the starter'), JSON.stringify(events.slice(-2)));
  } finally {
    rmrf(base);
  }
});

it('PM2b: installing the same bytes again keeps one copy and one current version; the copy is owner-only', () => {
  const base = fs.realpathSync(tmpDir());
  try {
    const { pkg, project, home } = installed(base);
    const first = fs.readFileSync(path.join(home, 'runtime', 'current'), 'utf8');
    fs.rmSync(path.join(project, '.claude'), { recursive: true });
    const again = spawnSync(process.execPath, [path.join(pkg, 'bin', 'orunmila.js'), 'install'], { env: env(base), cwd: project, encoding: 'utf8' });
    assert.strictEqual(again.status, 0, again.stdout + again.stderr);
    assert.strictEqual(fs.readFileSync(path.join(home, 'runtime', 'current'), 'utf8'), first);
    assert.deepStrictEqual(fs.readdirSync(path.join(home, 'runtime')).sort(), ['current', first.trim()].sort(), 'one copy, no leftovers');
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(path.join(home, 'runtime', first.trim())).mode & 0o777, 0o700, 'owner-only, as the rest of the home (modes do not apply on Windows)');
      assert.strictEqual(fs.statSync(path.join(home, 'bin', 'orunmila-start.js')).mode & 0o777, 0o600);
    }
  } finally {
    rmrf(base);
  }
});

/** A home holding only the starter and a version folder of `files` (made up), `current` naming it. */
function fakeHome(base, files, current = 'v1') {
  const home = path.join(base, 'h');
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src', 'runtime', 'orunmila-start.js'), path.join(home, 'bin', 'orunmila-start.js'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(home, 'runtime', 'v1', rel)), { recursive: true });
    fs.writeFileSync(path.join(home, 'runtime', 'v1', rel), text);
  }
  if (current !== null) fs.writeFileSync(path.join(home, 'runtime', 'current'), current + '\n');
  return home;
}
const start = (home, args, input = '') => spawnSync(process.execPath, [path.join(home, 'bin', 'orunmila-start.js'), ...args], { input, encoding: 'utf8' });

it('PM2b: the starter passes the payload, the arguments, the output and the exit code through, unchanged', () => {
  const base = tmpDir();
  try {
    const script = "let s='';process.stdin.on('data',(d)=>(s+=d));process.stdin.on('end',()=>{process.stdout.write('out:'+s+':'+process.argv.slice(2).join(','));process.stderr.write('err');process.exit(3);});";
    const home = fakeHome(base, { 'src/capture/connector.js': script });
    const r = start(home, ['src/capture/connector.js', 'codex', 'postTool'], '{"x":1}');
    assert.deepStrictEqual([r.status, r.stdout, r.stderr], [3, 'out:{"x":1}:codex,postTool', 'err']);
  } finally {
    rmrf(base);
  }
});

it('PM2b: the starter refuses, loudly and with exit 1, a script not Orunmila\'s, no current version, a current that is not a plain name, and a version without the script', () => {
  const base = tmpDir();
  try {
    const home = fakeHome(base, { 'src/capture/connector.js': 'process.exit(0);' });
    const cases = [
      [['src/other.js'], 'runs only Orunmila\'s own scripts'],
      [['../../etc/x.js'], 'runs only Orunmila\'s own scripts'],
      [['src/capture/claude-code/stop.js'], 'has no src/capture/claude-code/stop.js'],
    ];
    for (const [args, words] of cases) {
      const r = start(home, args);
      assert.strictEqual(r.status, 1, args.join(' '));
      assert.ok(r.stderr.includes(words), `${args}: ${r.stderr}`);
    }
    fs.writeFileSync(path.join(home, 'runtime', 'current'), '../v1\n');
    const bad = start(home, ['src/capture/connector.js']);
    assert.deepStrictEqual([bad.status, bad.stderr.includes('is not a version folder\'s name')], [1, true], bad.stderr);
    fs.rmSync(path.join(home, 'runtime', 'current'));
    const none = start(home, ['src/capture/connector.js']);
    assert.deepStrictEqual([none.status, none.stderr.includes('orunmila install')], [1, true], none.stderr);
  } finally {
    rmrf(base);
  }
});

it('PM2b: orunmila status names a hook whose starter is gone, or whose current version lacks its script, and exits 1', () => {
  const base = fs.realpathSync(tmpDir());
  try {
    const { pkg, project, home } = installed(base);
    const status = () => spawnSync(process.execPath, [path.join(pkg, 'bin', 'orunmila.js'), 'status'], { env: env(base), cwd: project, encoding: 'utf8' });
    const ok = status();
    assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
    const current = fs.readFileSync(path.join(home, 'runtime', 'current'), 'utf8').trim();
    fs.rmSync(path.join(home, 'runtime', current, 'src', 'capture', 'claude-code', 'stop.js'));
    const lacking = status();
    assert.strictEqual(lacking.status, 1, lacking.stdout);
    assert.ok(lacking.stdout.includes(`[Stop] ${path.join(home, 'runtime', current, 'src', 'capture', 'claude-code', 'stop.js')}`), lacking.stdout);
    fs.rmSync(path.join(home, 'bin', 'orunmila-start.js'));
    const gone = status();
    assert.strictEqual(gone.status, 1, gone.stdout);
    assert.ok(gone.stdout.includes(`[UserPromptSubmit] ${path.join(home, 'bin', 'orunmila-start.js')}`), gone.stdout);
  } finally {
    rmrf(base);
  }
});

runAll('starter');
