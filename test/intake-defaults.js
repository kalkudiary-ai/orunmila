// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/intake-defaults.js — DF1 (O's word, 2026-11-28, on R5's five switches; LD395): two of the intake's switches on
 * by default for 1.0.0, each turned off by its variable set to 0, as MR7 and PB1 did for the log guard and a peer's
 * busy notes: git, pull-request and CI state on a command's mark (VC1, LD372, test 60) and the command facts (CF1-CF5,
 * LD385). The real `orunmila intake run` in a throwaway home: a `git status -sb` and a `curl` sent over its socket,
 * then the session's own log read. Hand-built payloads in the shapes Claude Code sends; made-up hosts; the tripwire
 * fingerprints this machine's own start-up files (keyed, never their content) as any user's intake would.
 */

const { spawn } = require('child_process');
const { assert, fs, path, ROOT, tmpDir, rmrf, run, sleep, it, runAll } = require('./helpers');
const { intakePaths, statusOf } = require('../src/opon/intake/server');

async function until(cond, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(20);
  }
  return cond();
}

function send(sock, payload) {
  return new Promise((resolve, reject) => {
    const c = require('net').createConnection(sock);
    c.on('error', reject);
    c.on('close', () => resolve());
    c.on('connect', () => c.end(JSON.stringify({ op: 'payload', payload }) + '\n'));
  });
}

const records = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l)) : []);

/** `orunmila intake run` with `env`; one session runs `git status -sb`, then a curl; returns the output, header and exited marks. */
async function intakeRun(home, env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'orunmila.js'), 'intake', 'run'], {
    env: { ...process.env, ORUNMILA_VCS_MARKS: '', ORUNMILA_COMMAND_FACTS: '', ORUNMILA_INTAKE_PORT: '0', ...env, ORUNMILA_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    const at = intakePaths(home); // W4b: at.sock read at each use (on Windows each start publishes a fresh pipe name)
    assert.ok(await until(async () => (await statusOf(at.sock, 300)) !== null), 'the intake answers: ' + out);
    assert.ok(await until(() => out.includes('ORUNMILA_VCS_MARKS') && out.includes('ORUNMILA_COMMAND_FACTS')), 'a line about each switch: ' + out);
    const project = path.join(home, '..', 'p');
    fs.mkdirSync(project, { recursive: true });
    const base = { session_id: 'ses_df', transcript_path: path.join(home, '..', 'no-transcript.jsonl'), cwd: project };
    const call = (id, command, stdout) => [
      { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: id },
      { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '' }, tool_use_id: id },
    ];
    for (const p of [{ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'status, then the hook' }, ...call('g1', 'git status -sb', '## main...origin/main\n'), ...call('c1', 'curl -fsS https://deploy.example/hook', 'ok')]) await send(at.sock, p);
    const raw = path.join(home, 'sessions', 'ses_df', 'raw.jsonl');
    assert.ok(await until(() => records(raw).filter((m) => m.says === 'exited').length === 2), 'both commands written: ' + JSON.stringify(records(raw).map((m) => m.says)));
    const r = run('bin/orunmila.js', { args: ['intake', 'stop'], env: { ORUNMILA_HOME: home } });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(await exited, 0);
    const all = records(raw);
    const ex = all.filter((m) => m.says === 'exited');
    return { out, header: all[0], git: ex.find((m) => m.cause_hint === 'g1'), curl: ex.find((m) => m.cause_hint === 'c1') };
  } catch (e) {
    child.kill('SIGKILL');
    await exited;
    throw e;
  }
}

const VCS = [{ type: 'git_state', head_sha: null, branch: 'main' }];

it('DF1 test 60: intake run with neither switch set puts git state and the command facts on the marks, holds the tripwire in the header, and says each is on by default', async () => {
  const base = tmpDir();
  try {
    const r = await intakeRun(path.join(base, 'h'), {});
    assert.ok(r.out.includes("orunmila intake: a git or gh command's mark carries the git, pull-request and CI state its output shows (on by default; ORUNMILA_VCS_MARKS=0 turns it off)"), r.out);
    assert.ok(r.out.includes("orunmila intake: command facts are on: each command's hosts and a sudo, a test run's counts, an install's packages, the outside tripwire and the transcript check (on by default; ORUNMILA_COMMAND_FACTS=0 turns it off)"), r.out);
    assert.deepStrictEqual(r.git.detail.vcs, VCS, 'VC1 on by default');
    assert.deepStrictEqual(r.curl.detail.hosts, ['deploy.example'], 'CF1 on by default');
    assert.ok(r.header.tripwire && typeof r.header.tripwire === 'object' && Object.keys(r.header.tripwire).length > 0, 'CF4 on by default: ' + JSON.stringify(r.header.tripwire));
  } finally {
    rmrf(base);
  }
});

it('DF1: with each set to 1 the same, and the printout names the variable', async () => {
  const base = tmpDir();
  try {
    const r = await intakeRun(path.join(base, 'h'), { ORUNMILA_VCS_MARKS: '1', ORUNMILA_COMMAND_FACTS: '1' });
    assert.ok(r.out.includes("orunmila intake: a git or gh command's mark carries the git, pull-request and CI state its output shows (ORUNMILA_VCS_MARKS=1)"), r.out);
    assert.ok(r.out.includes("orunmila intake: command facts are on: each command's hosts and a sudo, a test run's counts, an install's packages, the outside tripwire and the transcript check (ORUNMILA_COMMAND_FACTS=1)"), r.out);
    assert.deepStrictEqual([r.git.detail.vcs, r.curl.detail.hosts], [VCS, ['deploy.example']]);
    assert.ok(r.header.tripwire && Object.keys(r.header.tripwire).length > 0);
  } finally {
    rmrf(base);
  }
});

it('DF1: with each set to 0, no git state, no command facts and no tripwire, and the printout says each is off', async () => {
  const base = tmpDir();
  try {
    const r = await intakeRun(path.join(base, 'h'), { ORUNMILA_VCS_MARKS: '0', ORUNMILA_COMMAND_FACTS: '0' });
    assert.ok(r.out.includes('orunmila intake: git, pull-request and CI state is not put on a command\'s mark (ORUNMILA_VCS_MARKS=0)'), r.out);
    assert.ok(r.out.includes('orunmila intake: command facts are off (ORUNMILA_COMMAND_FACTS=0)'), r.out);
    assert.deepStrictEqual([r.git.detail.vcs, r.curl.detail.hosts, r.header.tripwire], [undefined, undefined, undefined]);
  } finally {
    rmrf(base);
  }
});

it('DF1: vcsMarksOn and commandFactsOn are on unless their variable is 0, and say where their answer came from', () => {
  const { vcsMarksOn, commandFactsOn } = require('../src/opon/intake/switches');
  for (const [fn, name] of [[vcsMarksOn, 'ORUNMILA_VCS_MARKS'], [commandFactsOn, 'ORUNMILA_COMMAND_FACTS']]) {
    assert.deepStrictEqual(fn({}), { on: true, from: 'default' }, name);
    assert.deepStrictEqual(fn({ [name]: '' }), { on: true, from: 'default' }, name);
    assert.deepStrictEqual(fn({ [name]: '1' }), { on: true, from: 'environment' }, name);
    assert.deepStrictEqual(fn({ [name]: '0' }), { on: false, from: 'environment' }, name);
    assert.deepStrictEqual(fn({ [name]: 'no' }), { on: true, from: 'default' }, `${name}: only 0 turns it off`);
  }
  assert.deepStrictEqual(vcsMarksOn({ ORUNMILA_COMMAND_FACTS: '0' }), { on: true, from: 'default' }, 'each reads its own variable');
  assert.deepStrictEqual(commandFactsOn({ ORUNMILA_VCS_MARKS: '0' }), { on: true, from: 'default' }, 'each reads its own variable');
});

runAll('intake-defaults');
