// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/intake-send.js — the hooks' sender (Phase 1 slice B2, LD133; LD122; test
 * 85; NF17). The sender is run as Claude Code runs a command hook: a child
 * process with the payload on stdin. The intake, when there is one, is a real
 * server on a throwaway home. Nothing here reads recorded data.
 */

const net = require('net');
const { spawn } = require('child_process');
const { assert, fs, path, ROOT, tmpDir, rmrf, run, sleep, it, runAll } = require('./helpers');
const { createRouter } = require('../src/opon/intake/router');
const { createServer, intakePaths } = require('../src/opon/intake/server');
const { nowMono } = require('../src/opon/intake/mono');

const SENDER = path.join(ROOT, 'src', 'capture', 'claude-code', 'intake-send.js');
const SRC = path.join(ROOT, 'src');
const clock = () => ({ mono: nowMono(), wall: new Date().toISOString() });

/** Run the sender with `input` on stdin; resolves { code, stdout, stderr, ms, reach }. */
function send(home, input, { reach = false } = {}) {
  return new Promise((resolve) => {
    const out = reach ? path.join(home, '..', `reach-${Date.now()}-${Math.random()}.json`) : null;
    const argv = reach ? ['-r', path.join(ROOT, 'scripts', 'hook-reach-preload.js'), SENDER] : [SENDER];
    const env = { ...process.env, ORUNMILA_HOME: home, ...(reach ? { HOOK_REACH_ROOT: ROOT, HOOK_REACH_OUT: out } : {}) };
    const t0 = Date.now();
    const c = spawn(process.execPath, argv, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    // A sender that outlives 5 s is killed and reported as code null, so a hang fails its test, never the run.
    const guard = setTimeout(() => c.kill('SIGKILL'), 5000);
    c.on('close', (code) => {
      clearTimeout(guard);
      resolve({ code, stdout, stderr, ms: Date.now() - t0, reach: out && fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null });
    });
    c.stdin.on('error', () => {}); // a sender that exits before reading it all: its exit code is the evidence
    c.stdin.end(input);
  });
}

function withHome(fn) {
  return async () => {
    const base = tmpDir();
    const home = path.join(base, 'h');
    const project = path.join(base, 'p');
    fs.mkdirSync(project, { recursive: true });
    const servers = [];
    const serve = async () => {
      const router = createRouter({ home, clock, checkSender: () => false, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: Buffer.alloc(32, 7), hookSettingsFor: () => [] });
      const s = createServer({ home, router, pollMs: 10 });
      servers.push(s);
      const r = await s.start();
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      return s;
    };
    try {
      await fn({ base, home, project, serve, p: intakePaths(home) });
    } finally {
      for (const s of servers) await s.stop('test over');
      rmrf(base);
    }
  };
}

const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l)) : []);
async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}
const payload = (project, more) => JSON.stringify({ session_id: 'ses_b2', transcript_path: '/tmp/t.jsonl', cwd: project, ...more });

it(
  'test 85: with no intake running the sender returns at once, exit 0, prints nothing, and writes nothing',
  withHome(async ({ home, project }) => {
    const r = await send(home, payload(project, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }));
    assert.deepStrictEqual([r.code, r.stdout, r.stderr], [0, '', '']);
    assert.ok(r.ms < 1000, `returned in ${r.ms} ms`);
    assert.ok(!fs.existsSync(path.join(home, 'sessions')), 'no session log without an intake');
  }),
);

it(
  'B2: with an intake running, the sender\'s payloads reach the session log on channel command, and it prints nothing',
  withHome(async ({ home, project, serve }) => {
    await serve();
    const a = await send(home, payload(project, { hook_event_name: 'SessionStart', source: 'startup' }));
    const b = await send(home, payload(project, { hook_event_name: 'UserPromptSubmit', prompt: 'through the sender' }));
    for (const r of [a, b]) assert.deepStrictEqual([r.code, r.stdout, r.stderr], [0, '', '']);
    const raw = path.join(home, 'sessions', 'ses_b2', 'raw.jsonl');
    assert.ok(await until(() => lines(raw).length === 2));
    const mark = lines(raw)[1];
    assert.deepStrictEqual([mark.says, mark.detail.channel, mark.detail.prompt], ['prompted', 'command', 'through the sender']);
  }),
);

it(
  'test 85: a listener that never takes the line does not block the sender past its deadline',
  withHome(async ({ base, home, project, p }) => {
    fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
    const held = [];
    const stuck = net.createServer((c) => {
      held.push(c);
      c.pause(); // never reads
    });
    await new Promise((res) => stuck.listen(p.sock, res));
    try {
      const big = payload(project, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { stdout: 'y'.repeat(8 * 1024 * 1024) } });
      const r = await send(home, big);
      assert.strictEqual(r.code, 0);
      assert.ok(r.ms < 2500, `returned in ${r.ms} ms`);
    } finally {
      for (const c of held) c.destroy();
      stuck.close();
    }
    void base;
  }),
);

it(
  'B2: a payload that is not JSON still reaches the intake, which records it in its error log, never dropped',
  withHome(async ({ home, serve, p }) => {
    await serve();
    const r = await send(home, 'this is not json');
    assert.strictEqual(r.code, 0);
    assert.ok(await until(() => lines(p.errors).length === 1), 'one error row');
  }),
);

it(
  "LD122, LD133: the sender loads no repo file but itself, so today's 30 hook-loaded files stay apart from it",
  withHome(async ({ home, project }) => {
    const r = await send(home, payload(project, { hook_event_name: 'Stop' }), { reach: true });
    assert.strictEqual(r.code, 0);
    assert.deepStrictEqual(r.reach, ['src/capture/claude-code/intake-send.js']);
  }),
);

it('H2 CLI: install --intake registers HTTP hooks for UserPromptSubmit, PreToolUse, PostToolUse and Stop, the sender for SessionStart, PostToolUseFailure and SessionEnd; an old all-command install moves over; a second run adds nothing', () => {
  const base = tmpDir();
  try {
    const work = path.join(base, 'w');
    fs.mkdirSync(path.join(work, '.claude'), { recursive: true });
    const cfg = path.join(work, '.claude', 'settings.json');
    const sender = `node "${path.join(__dirname, '..', 'src', 'capture', 'claude-code', 'intake-send.js')}"`;
    const old = { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo mine' }] }] } };
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd']) {
      old.hooks[ev] = [...(old.hooks[ev] || []), { matcher: '*', hooks: [{ type: 'command', command: sender }] }]; // what B2 installed
    }
    fs.writeFileSync(cfg, JSON.stringify(old));
    const env = { ORUNMILA_HOME: path.join(base, 'h'), ORUNMILA_INTAKE_PORT: '47999' };
    const first = run('bin/orunmila.js', { args: ['install', '--intake'], env, cwd: work });
    assert.strictEqual(first.status, 0, first.stdout + first.stderr);
    assert.ok(first.stdout.includes('orunmila intake start'), 'says the intake must be started');
    const after = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    const hooksOf = (ev) => (after.hooks[ev] || []).flatMap((e) => e.hooks.map((h) => ({ matcher: e.matcher, ...h })));
    const isSender = (h) => h.type === 'command' && String(h.command).includes('intake-send.js');
    for (const ev of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
      const hs = hooksOf(ev);
      assert.deepStrictEqual(hs.filter((h) => h.type === 'http'), [{ matcher: '*', type: 'http', url: 'http://127.0.0.1:47999/hook', timeout: 2 }], `${ev}: one HTTP hook to the intake`);
      assert.strictEqual(hs.filter(isSender).length, 0, `${ev}: the command sender is gone (one channel per event)`);
    }
    for (const ev of ['SessionStart', 'PostToolUseFailure', 'SessionEnd']) {
      const hs = hooksOf(ev);
      assert.strictEqual(hs.filter(isSender).length, 1, `${ev}: one sender`);
      assert.strictEqual(hs.filter((h) => h.type === 'http').length, 0, `${ev}: no HTTP hook`);
      assert.strictEqual(hs.find(isSender).matcher, '*');
    }
    assert.ok(after.hooks.Stop.some((e) => e.hooks.some((h) => h.command === 'echo mine')), 'existing hooks kept');
    assert.ok(!JSON.stringify(after).includes('post-tool-use.js'), 'the old capture hooks are not added by --intake');
    const second = run('bin/orunmila.js', { args: ['install', '--intake'], env, cwd: work });
    assert.strictEqual(second.status, 0, second.stdout + second.stderr);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')), after, 'nothing added twice');
  } finally {
    rmrf(base);
  }
});

it('OW1: the help no longer says capture does not write the session logs (the intake does, B4/H2)', () => {
  const r = run('bin/orunmila.js', { args: [] });
  assert.strictEqual(r.status, 0);
  assert.ok(!r.stdout.includes('capture does not write it yet'), 'stale help text');
  assert.ok(r.stdout.includes('the per-session logs the intake writes'), r.stdout);
});

it("OW2: orunmila --version prints the package's version, as SECURITY.md asks reporters to give it", () => {
  const r = run('bin/orunmila.js', { args: ['--version'] });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(r.stdout.trim(), require('../package.json').version);
});

runAll('intake-send');
