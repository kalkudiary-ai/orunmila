// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/crash.js — tests 12 and 18 on a real install (Phase 5 slice CR1, LD250; brief v4 lines 616, 763, 779, 785):
 * the intake, a real process started by the CLI with the live flag, is killed with SIGKILL (12) or stopped (18)
 * mid-session, then started again. The session's log gets one gap covering the downtime (84), the live odù log
 * equals replay of the raw log (guarantee 3), and the verifier reports the gap. Hand-built payloads in the shapes
 * Claude Code sends, in a throwaway home and project; nothing here reads recorded data.
 */

const net = require('net');
const { assert, fs, path, tmpDir, rmrf, run, sleep, it, runAll } = require('./helpers');
const { intakePaths } = require('../src/opon/intake/server');
const { replayFolder } = require('../src/opon/replay');
const { verifySession } = require('../src/verify/session');

const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l)) : []);

function send(sock, text) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    c.on('error', reject);
    c.on('close', () => resolve());
    c.on('connect', () => c.end(text));
  });
}
const req = (payload) => JSON.stringify({ op: 'payload', payload }) + '\n';

async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}

function cc(project, sid) {
  const base = { session_id: sid, transcript_path: '/tmp/t.jsonl', cwd: project };
  return {
    start: () => ({ ...base, hook_event_name: 'SessionStart', source: 'startup' }),
    prompt: (prompt) => ({ ...base, hook_event_name: 'UserPromptSubmit', prompt }),
    pre: (id, command) => ({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: id }),
    post: (id, command) => ({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'ok', stderr: '', interrupted: false }, tool_use_id: id }),
    stop: (text) => ({ ...base, hook_event_name: 'Stop', last_assistant_message: text }),
    end: () => ({ ...base, hook_event_name: 'SessionEnd', reason: 'exit' }),
  };
}

/** One turn: a prompt, a command before and after, a stop. */
const turn = (p, n) => [p.prompt(`turn ${n}`), p.pre(`c${n}`, `echo ${n}`), p.post(`c${n}`, `echo ${n}`), p.stop(`Ran echo ${n}.`)].map(req).join('');

/**
 * A session over a real intake, cut in the middle by `cut(pid)`: two turns, the cut, the intake started again, two
 * more turns, then a planned stop. Returns the session folder, its raw records and when the cut happened.
 */
async function cutSession(base, sid, cut) {
  const home = path.join(base, 'h');
  const project = path.join(base, 'p');
  fs.mkdirSync(project, { recursive: true });
  const env = { ORUNMILA_HOME: home, ORUNMILA_INTAKE_PORT: '0', ORUNMILA_OPON_LIVE: '1' }; // never the real port (LD140)
  const paths = intakePaths(home);
  const dir = path.join(home, 'sessions', sid);
  const p = cc(project, sid);
  const done = cc(project, `${sid}_done`); // test 84: a session that ended before the cut is not active at the intake's last tick
  const start = () => {
    const r = run('bin/orunmila.js', { args: ['intake', 'start'], env });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  };
  try {
    start();
    await send(paths.sock, req(p.start()) + turn(p, 1) + turn(p, 2) + req(done.start()) + turn(done, 1) + req(done.end()));
    assert.ok(await until(() => lines(path.join(dir, 'raw.jsonl')).filter((m) => m.says === 'ended').length === 2), 'two turns written');
    const doneDir = path.join(home, 'sessions', `${sid}_done`);
    assert.ok(await until(() => lines(path.join(doneDir, 'raw.jsonl')).some((m) => m.says === 'ended' && m.target && m.target.kind === 'session')), 'the other session ended');
    const pid = Number(fs.readFileSync(paths.lock, 'utf8').trim());
    assert.ok(Number.isInteger(pid) && pid > 0, `the lock names the intake's pid: ${pid}`);
    const cutAt = new Date().toISOString();
    cut(pid);
    assert.ok(await until(() => run('bin/orunmila.js', { args: ['intake', 'status'], env }).status !== 0), 'the intake is gone');
    await sleep(300); // the downtime
    start();
    await send(paths.sock, turn(p, 3) + turn(p, 4));
    assert.ok(await until(() => lines(path.join(dir, 'raw.jsonl')).filter((m) => m.says === 'ended').length === 4), 'four turns written');
    return { dir, raw: lines(path.join(dir, 'raw.jsonl')), doneRaw: lines(path.join(doneDir, 'raw.jsonl')), sid, cutAt };
  } finally {
    run('bin/orunmila.js', { args: ['intake', 'stop'], env });
  }
}

/** The intake's downtime gaps: gap marks with `since` (84). */
const downtime = (raw) => raw.filter((m) => m.says === 'gap' && m.detail && m.detail.since);

for (const [name, test, cut, planned] of [
  ['test 12', 'killed with SIGKILL', (pid) => process.kill(pid, 'SIGKILL'), false],
  ['test 18', 'stopped (SIGTERM)', (pid) => process.kill(pid, 'SIGTERM'), true],
]) {
  it(`CR1 ${name} (LD250): the intake ${test} mid-session and started again: one gap covering the downtime, the live odù log equal to replay of the raw log, and verify reports the gap`, async () => {
    const base = tmpDir();
    try {
      const { dir, raw, doneRaw, sid, cutAt } = await cutSession(base, `ses_${name.replace(' ', '')}`, cut);
      const gaps = downtime(raw);
      assert.strictEqual(gaps.length, 1, JSON.stringify(gaps));
      const g = gaps[0];
      // Test 84 (line 851): the gap names the sessions active at the intake's last tick: this one, never one that had ended.
      assert.deepStrictEqual(g.detail.sessions, [sid], JSON.stringify(g.detail));
      assert.deepStrictEqual(downtime(doneRaw), [], 'a session that ended before the cut gets no downtime gap');
      const before = raw.filter((m) => m.seq < g.seq && m.says !== 'gap');
      const last = before[before.length - 1];
      // A kill leaves no note: the gap runs from the last record before the cut. A planned stop writes its closing note at
      // the signal (LD56), so the gap runs from that note, just after the cut.
      if (planned) assert.deepStrictEqual([last.says, last.target.name], ['exited', 'intake'], 'the closing note comes first');
      else assert.ok(g.detail.since.observed_at <= cutAt, `the gap starts before the kill: ${JSON.stringify(g.detail)}`);
      assert.ok(g.detail.until.observed_at > cutAt, `the gap ends after the cut: ${JSON.stringify(g.detail)}`);
      assert.strictEqual(g.detail.since.mono_ns, last.mono_ns, 'from the last record before it');
      assert.deepStrictEqual(raw.filter((m) => m.seq > g.seq && m.says === 'prompted').length, 2, 'the two later turns after it');
      assert.strictEqual(fs.readFileSync(path.join(dir, 'odu.jsonl'), 'utf8'), replayFolder(dir).odu, 'live equals replay');
      const v = verifySession(dir);
      assert.ok(v.ok, v.words);
      assert.ok(v.words.includes(`the intake was down from ${g.detail.since.observed_at} to ${g.detail.until.observed_at} (line ${g.seq + 1} of the raw log)`), v.words);
      assert.deepStrictEqual(v.gaps, { downtime: [{ seq: g.seq, since: g.detail.since.observed_at, until: g.detail.until.observed_at }], other: 0 });
    } finally {
      rmrf(base);
    }
  });
}

it('CR1 (LD250): verify counts a capture gap that is not the intake\'s downtime, names none as downtime, and the record stays intact', () => {
  const { makeLog, M } = require('./helpers-opon');
  const base = tmpDir();
  try {
    const log = makeLog(base); // hand-built, made-up session
    log.append(M.prompted(0));
    log.append(M.gap(500, 'hook payloads dropped'));
    const v = verifySession(log.dir);
    assert.ok(v.ok, v.words);
    assert.deepStrictEqual([v.gaps, v.words.includes('1 other capture gap recorded'), v.words.includes('the intake was down')], [{ downtime: [], other: 1 }, true, false]);
  } finally {
    rmrf(base);
  }
});

runAll('crash');
