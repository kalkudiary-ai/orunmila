// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/judge-switch.js — the Babaláwo, the judge, is an install option, off by default, like the Closeout Gate (Phase 6
 * slice BJ1, LD300 (4), LD326; O: "not everyone will appreciate the feature, especially coders"). `orunmila install
 * --with-judge` turns it on in Orunmila's home and `--without-judge` turns it off; `orunmila lenses` and `status` name
 * it beside the other two lenses; `orunmila intake run` reads the switch at its start, and the environment
 * (ORUNMILA_JUDGE_LIVE=1 or 0) still wins where it is set. A throwaway home and project; nothing real is touched.
 */

const { spawn } = require('child_process');
const { assert, fs, path, ROOT, tmpDir, rmrf, run, sleep, it, runAll } = require('./helpers');
const { switchesFile, readSwitches, setJudge, judgeOn } = require('../src/opon/intake/switches');
const { intakePaths, statusOf } = require('../src/opon/intake/server');

async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(20);
  }
  return cond();
}

it('BJ1: the switch is off with no file; on and off as written; a damaged file is off and says why; the environment wins where it is set', () => {
  const home = tmpDir();
  try {
    assert.deepStrictEqual(readSwitches(home), { judge: false, problem: null });
    assert.deepStrictEqual(judgeOn({}, home), { on: false, from: 'default' });
    const file = setJudge(home, true);
    assert.strictEqual(file, switchesFile(home));
    assert.strictEqual(file, path.join(home, 'intake', 'switches.json'));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { judge: true });
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'owner-only, as the rest of the intake folder (file modes do not apply on Windows)');
    assert.deepStrictEqual(judgeOn({}, home), { on: true, from: 'switch' });
    assert.deepStrictEqual(judgeOn({ ORUNMILA_JUDGE_LIVE: '0' }, home), { on: false, from: 'environment' });
    fs.writeFileSync(file, JSON.stringify({ judge: true, later: 'kept' }));
    setJudge(home, false);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { judge: false, later: 'kept' }, 'other switches are kept');
    assert.deepStrictEqual(judgeOn({}, home), { on: false, from: 'switch' });
    assert.deepStrictEqual(judgeOn({ ORUNMILA_JUDGE_LIVE: '1' }, home), { on: true, from: 'environment' });
    fs.writeFileSync(file, '{ not json');
    const bad = readSwitches(home);
    assert.strictEqual(bad.judge, false);
    assert.ok(/could not be read as JSON/.test(bad.problem), bad.problem);
    fs.writeFileSync(file, JSON.stringify({ judge: 'yes' }));
    assert.ok(/neither true nor false/.test(readSwitches(home).problem), 'a judge that is not true or false is off, and says so');
    assert.strictEqual(readSwitches(home).judge, false);
  } finally {
    rmrf(home);
  }
});

it('BJ1: install --with-judge turns the judge on and says what it does; lenses and status name it; --without-judge turns it off', () => {
  const base = tmpDir();
  const home = path.join(base, 'h');
  const project = path.join(base, 'p');
  fs.mkdirSync(project, { recursive: true });
  const env = { ORUNMILA_HOME: home, ORUNMILA_JUDGE_LIVE: '' };
  try {
    const off = run('bin/orunmila.js', { args: ['lenses'], env, cwd: project });
    assert.strictEqual(off.status, 0, off.stdout + off.stderr);
    assert.ok(off.stdout.includes('three lenses'), off.stdout);
    assert.ok(/The Babaláwo\s+\S*· not installed/.test(off.stdout), off.stdout);
    assert.ok(off.stdout.includes('orunmila install --with-judge'), off.stdout);

    const on = run('bin/orunmila.js', { args: ['install', '--with-judge'], env, cwd: project });
    assert.strictEqual(on.status, 0, on.stdout + on.stderr);
    assert.ok(on.stdout.includes('The Babaláwo is on'), on.stdout);
    assert.ok(on.stdout.includes('never stops the agent'), on.stdout);
    assert.ok(on.stdout.includes('next start'), 'it says when it takes effect: ' + on.stdout);
    assert.deepStrictEqual(readSwitches(home), { judge: true, problem: null });
    assert.ok(!fs.existsSync(path.join(project, '.claude', 'settings.json')), 'no hook is installed by --with-judge');

    const lensesOn = run('bin/orunmila.js', { args: ['lenses'], env, cwd: project });
    assert.ok(/The Babaláwo\s+\S*✓ installed/.test(lensesOn.stdout) && !/The Babaláwo\s+\S*· not installed/.test(lensesOn.stdout), lensesOn.stdout);
    const status = run('bin/orunmila.js', { args: ['status'], env, cwd: project });
    assert.ok(/Babaláwo \S*on/.test(status.stdout), status.stdout);

    const without = run('bin/orunmila.js', { args: ['install', '--without-judge'], env, cwd: project });
    assert.strictEqual(without.status, 0, without.stdout + without.stderr);
    assert.ok(without.stdout.includes('The Babaláwo is off'), without.stdout);
    assert.deepStrictEqual(readSwitches(home), { judge: false, problem: null });
    const statusOff = run('bin/orunmila.js', { args: ['status'], env, cwd: project });
    assert.ok(/Babaláwo \S*off/.test(statusOff.stdout), statusOff.stdout);
  } finally {
    rmrf(base);
  }
});

const req = (payload) => JSON.stringify({ op: 'payload', payload }) + '\n';
function send(sock, text) {
  return new Promise((resolve, reject) => {
    const c = require('net').createConnection(sock);
    c.on('error', reject);
    c.on('close', () => resolve());
    c.on('connect', () => c.end(text));
  });
}

/**
 * `orunmila intake run` in a throwaway home; one session begun, so its header shows whether the judge is on (with it on,
 * the rules are copied into the header at session start, BB6); then a stop asked for. Returns the output and the header.
 */
async function startLine(env, sid) {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'orunmila.js'), 'intake', 'run'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    assert.ok(await until(async () => (await statusOf(intakePaths(env.ORUNMILA_HOME).sock, 300)) !== null), 'the intake answers: ' + out);
    assert.ok(await until(() => /judge/.test(out)), 'a line about the judge: ' + out);
    const project = path.join(env.ORUNMILA_HOME, '..', 'p');
    fs.mkdirSync(path.join(project, '.orunmila'), { recursive: true });
    fs.writeFileSync(path.join(project, '.orunmila', 'rules'), '# the default rules\n'); // copied into the header only with the judge on (header.js)
    await send(intakePaths(env.ORUNMILA_HOME).sock, req({ session_id: sid, transcript_path: '/tmp/t.jsonl', cwd: project, hook_event_name: 'UserPromptSubmit', prompt: 'go' }));
    const raw = path.join(env.ORUNMILA_HOME, 'sessions', sid, 'raw.jsonl');
    assert.ok(await until(() => fs.existsSync(raw) && fs.readFileSync(raw, 'utf8').includes('"prompted"')), 'the session is begun');
    const header = JSON.parse(fs.readFileSync(raw, 'utf8').split('\n')[0]);
    const r = run('bin/orunmila.js', { args: ['intake', 'stop'], env });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(await exited, 0);
    return { out, header };
  } catch (e) {
    child.kill('SIGKILL');
    await exited;
    throw e;
  }
}

it('BJ1: intake run follows the switch at its start and says so; the environment wins over it', async () => {
  const base = tmpDir();
  const home = path.join(base, 'h');
  const env = { ORUNMILA_HOME: home, ORUNMILA_INTAKE_PORT: '0', ORUNMILA_JUDGE_LIVE: '', ORUNMILA_OPON_LIVE: '1' }; // never the real port (LD140); the judge reads the live odù log
  try {
    const none = await startLine(env, 'ses_none');
    assert.ok(none.out.includes('the judge is off'), 'no switch: off');
    assert.strictEqual(none.header.config.rules, undefined, 'the judge off: no rules in the header');
    setJudge(home, true);
    const on = await startLine(env, 'ses_on');
    assert.ok(on.out.includes(`the judge is on (the switch in ${switchesFile(home)})`), on.out);
    assert.strictEqual(typeof on.header.config.rules, 'string', 'the judge on: the rules copied into the header at session start (BB6)');
    const envOff = await startLine({ ...env, ORUNMILA_JUDGE_LIVE: '0' }, 'ses_env_off');
    assert.ok(envOff.out.includes('the judge is off (ORUNMILA_JUDGE_LIVE=0)'), envOff.out);
    assert.strictEqual(envOff.header.config.rules, undefined, 'the environment wins over the switch');
  } finally {
    rmrf(base);
  }
});

runAll('judge-switch');
