// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/gate-marks.js — the law gate's checks as `law_gate` marks through the
 * intake (slice B5, LD146; brief v4 lines 199, 242; test 61; NF16, NF6). The
 * hook runs as a child with a throwaway ORUNMILA_HOME and a fake intake socket;
 * made-up prose only.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createRouter } = require('../src/opon/intake/router');
const { checkLog } = require('../src/verify/session');
const { nowMono } = require('../src/opon/intake/mono');
const { intakePaths } = require('../src/opon/intake/server');

const SRC = path.join(__dirname, '..', 'src');
const HOOK = path.join(SRC, 'capture', 'claude-code', 'law-gate.js');

function setup() {
  const home = fs.realpathSync(tmpDir());
  const root = fs.realpathSync(tmpDir());
  const router = createRouter({ home, clock: () => ({ mono: nowMono(), wall: new Date().toISOString() }), checkSender: () => true, codeRoot: SRC, orunmilaVersion: 't', installKey: crypto.randomBytes(32), hookSettingsFor: () => [] });
  const marks = (id) => checkLog(path.join(home, 'sessions', id), 'raw').records.map((r) => r.rec).slice(1);
  const quarantined = (id) => checkLog(path.join(home, 'sessions', id), 'quarantine').records.slice(1);
  return { home, root, router, marks, quarantined, done: () => (router.stop('over'), rmrf(home), rmrf(root)) };
}

const check = (t, c, extra = {}) => t.router.payload({ session_id: 's1', hook_event_name: 'OrunmilaLawCheck', cwd: t.root, check: c, ...extra }, { channel: 'command' });

it("test 61: a check that passed, one that blocked and one skipped are one `checked` mark each, naming the turn, with result, laws and quoted text", () => {
  const t = setup();
  try {
    t.router.payload({ session_id: 's1', hook_event_name: 'UserPromptSubmit', cwd: t.root, prompt: 'go' }, { channel: 'command' });
    check(t, { findings: [] });
    check(t, { findings: [{ law_id: 'no-green-without-command', severity: 'block', evidence: { text: 'All tests pass.' } }], blocked: true });
    t.router.payload({ session_id: 's1', hook_event_name: 'Stop', cwd: t.root, last_assistant_message: 'All tests pass.' }, { channel: 'command' });
    check(t, { skipped: 'could not confirm the current turn' }); // after the Stop closed the turn: still that turn
    const checks = t.marks('s1').filter((m) => m.source === 'law_gate');
    assert.strictEqual(checks.length, 3);
    for (const m of checks) {
      assert.strictEqual(m.says, 'checked');
      assert.strictEqual(m.turn, 't1');
      assert.deepStrictEqual(m.target, { kind: 'turn', id: 't1' });
    }
    assert.deepStrictEqual(checks.map((m) => m.detail.result), ['passed', 'blocked', 'skipped']);
    assert.deepStrictEqual(checks[1].detail.findings, [{ law: 'no-green-without-command', severity: 'block', quote: 'All tests pass.' }]);
    assert.strictEqual(checks[2].detail.reason, 'could not confirm the current turn');
    assert.deepStrictEqual(t.quarantined('s1'), []);
  } finally {
    t.done();
  }
});

it('B5 (NF6): a check made over a malformed law file records the loader\'s words; a check with no turn yet is quarantined, never dropped', () => {
  const t = setup();
  try {
    check(t, { findings: [], lawErrors: ['/p/.orunmila/laws.json: not valid JSON (Unexpected token)'] });
    assert.strictEqual(t.marks('s1').filter((m) => m.source === 'law_gate').length, 0, 'no turn yet: not a mark');
    assert.strictEqual(t.quarantined('s1').length, 1);
    t.router.payload({ session_id: 's1', hook_event_name: 'UserPromptSubmit', cwd: t.root, prompt: 'go' }, { channel: 'command' });
    check(t, { findings: [], lawErrors: ['/p/.orunmila/laws.json: not valid JSON (Unexpected token)'] });
    const m = t.marks('s1').find((x) => x.source === 'law_gate');
    assert.deepStrictEqual(m.detail.law_errors, ['/p/.orunmila/laws.json: not valid JSON (Unexpected token)']);
    assert.strictEqual(m.detail.result, 'passed');
  } finally {
    t.done();
  }
});

/** Run the gate hook with a fake intake listening; returns { stdout, lines }. */
async function runHook({ flag, payload, home, cwd, args = [] }) {
  fs.mkdirSync(path.join(home, 'intake'), { recursive: true });
  const sock = intakePaths(home).sock; // W3e: the intake's own address, a named pipe on Windows (W2a)
  const lines = [];
  const server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => (buf += d));
    c.on('end', () => lines.push(...buf.split('\n').filter(Boolean)));
  });
  await new Promise((r) => server.listen(sock, r));
  const env = { ...process.env, ORUNMILA_HOME: home };
  delete env.ORUNMILA_LAWS;
  if (flag) env.ORUNMILA_GATE_MARKS = '1';
  else delete env.ORUNMILA_GATE_MARKS;
  const child = spawn(process.execPath, [HOOK, ...args], { env, cwd });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stdin.end(JSON.stringify(payload));
  const code = await new Promise((r) => child.on('exit', r));
  await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => server.close(r));
  return { code, stdout, lines };
}

it('B5 hook: with ORUNMILA_GATE_MARKS=1 the gate sends its decision to the intake, and its own output is unchanged', async () => {
  const home = fs.realpathSync(tmpDir());
  const cwd = fs.realpathSync(tmpDir());
  try {
    const payload = { session_id: 'h1', hook_event_name: 'Stop', last_assistant_message: 'I ran the tests and all tests pass.' };
    const off = await runHook({ flag: false, payload, home, cwd });
    const on = await runHook({ flag: true, payload, home, cwd });
    assert.strictEqual(off.code, 0);
    assert.strictEqual(on.code, 0);
    assert.deepStrictEqual(off.lines, [], 'flag off: nothing is sent');
    assert.strictEqual(on.lines.length, 1);
    const sent = JSON.parse(on.lines[0]);
    assert.strictEqual(sent.op, 'payload');
    assert.strictEqual(sent.payload.hook_event_name, 'OrunmilaLawCheck');
    assert.strictEqual(sent.payload.session_id, 'h1');
    assert.strictEqual(sent.payload.cwd, cwd);
    assert.ok(Array.isArray(sent.payload.check.findings), JSON.stringify(sent.payload.check));
    // The gate's answer to Claude Code is the same with the flag on or off (it blocks the
    // second time only because the first run spent nothing: the budget is per prompt).
    assert.strictEqual(typeof on.stdout, 'string');
    assert.strictEqual(JSON.parse(off.stdout).decision, 'block', off.stdout);
    assert.ok(sent.payload.check.blocked === true, 'the blocking decision is what is sent');
  } finally {
    rmrf(home);
    rmrf(cwd);
  }
});

it('B5 hook: a Stop with no final text is sent as a skip', async () => {
  const home = fs.realpathSync(tmpDir());
  const cwd = fs.realpathSync(tmpDir());
  try {
    const on = await runHook({ flag: true, payload: { session_id: 'h2', hook_event_name: 'Stop' }, home, cwd });
    assert.strictEqual(on.code, 0);
    assert.strictEqual(on.stdout, '');
    const sent = JSON.parse(on.lines[0]);
    assert.ok(/could not confirm the current turn/.test(sent.payload.check.skipped), sent.payload.check.skipped);
  } finally {
    rmrf(home);
    rmrf(cwd);
  }
});

it('B5 hook: with no intake running the gate still answers and exits 0 at once', async () => {
  const home = fs.realpathSync(tmpDir());
  const cwd = fs.realpathSync(tmpDir());
  try {
    const env = { ...process.env, ORUNMILA_HOME: home, ORUNMILA_GATE_MARKS: '1' };
    const t0 = Date.now();
    const child = spawn(process.execPath, [HOOK], { env, cwd });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stdin.end(JSON.stringify({ session_id: 'h3', hook_event_name: 'Stop', last_assistant_message: 'I ran the tests and all tests pass.' }));
    const code = await new Promise((r) => child.on('exit', r));
    assert.strictEqual(code, 0);
    assert.strictEqual(JSON.parse(stdout).decision, 'block');
    assert.ok(Date.now() - t0 < 3000, 'no wait for an intake that is not there');
  } finally {
    rmrf(home);
    rmrf(cwd);
  }
});

it('BB5b: `--marks` on the hook\'s command line sends the decision as ORUNMILA_GATE_MARKS=1 does, on every system (no environment prefix)', async () => {
  const home = fs.realpathSync(tmpDir());
  const cwd = fs.realpathSync(tmpDir());
  try {
    const on = await runHook({ flag: false, args: ['--marks'], payload: { session_id: 'h4', hook_event_name: 'Stop', last_assistant_message: 'Done.' }, home, cwd });
    assert.strictEqual(on.code, 0);
    assert.strictEqual(on.lines.length, 1, 'sent with the argument alone');
    assert.strictEqual(JSON.parse(on.lines[0]).payload.hook_event_name, 'OrunmilaLawCheck');
  } finally {
    rmrf(home);
    rmrf(cwd);
  }
});

it("BB5b, line 678: install --intake turns on the gate's marks where the gate is installed, once; with no gate it says the record will be incomplete and installs none", () => {
  const { run } = require('./helpers');
  const project = fs.realpathSync(tmpDir());
  const bare = fs.realpathSync(tmpDir());
  const home = fs.realpathSync(tmpDir());
  const env = { HOME: home, ORUNMILA_HOME: path.join(home, '.orunmila'), ORUNMILA_INTAKE_PORT: '0' };
  const gates = (dir) => {
    const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
    return (s.hooks.Stop || []).flatMap((e) => e.hooks || []).map((h) => h.command || '').filter((c) => c.includes('law-gate.js'));
  };
  try {
    assert.strictEqual(run('bin/orunmila.js', { args: ['install', '--with-gate'], env, cwd: project }).status, 0);
    assert.ok(gates(project).every((c) => !c.includes('--marks')), 'the gate alone sends no marks');
    const r = run('bin/orunmila.js', { args: ['install', '--intake'], env, cwd: project });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.deepStrictEqual(gates(project).map((c) => c.endsWith(' --marks')), [true]);
    assert.ok(r.stdout.includes("the Closeout Gate's checks go to the intake too"), r.stdout);
    run('bin/orunmila.js', { args: ['install', '--intake'], env, cwd: project });
    assert.deepStrictEqual(gates(project).map((c) => c.split(' --marks').length - 1), [1], 'never twice');
    const b = run('bin/orunmila.js', { args: ['install', '--intake'], env, cwd: bare });
    assert.strictEqual(b.status, 0, b.stdout + b.stderr);
    assert.deepStrictEqual(gates(bare), [], 'the gate is never installed by --intake');
    assert.ok(b.stdout.includes('law gate silent'), b.stdout);
  } finally {
    rmrf(project);
    rmrf(bare);
    rmrf(home);
  }
});

runAll('gate-marks');
