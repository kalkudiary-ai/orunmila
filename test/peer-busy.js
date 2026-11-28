// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/peer-busy.js — AT1b (LD330; LD300 (3); O approved Q45): the live intake notes, in each session's own log, when a
 * peer sharing its folder is working (the `overlapped` mark's `busy`), on by default since PB1 (O's word, 2026-11-27;
 * off by default before it, Leopard rule 2), ORUNMILA_PEER_BUSY=0 turning it off. A peer is busy from its prompt to its turn's end, and for the rest of its session once it leaves
 * work running (a background command) or the Glove records it outside a turn. Live and replay read the notes alike
 * (AT1a), so a change during this session's command, while the peer is idle, is credited here. Hand-built logs and
 * payloads in throwaway folders, labelled so (brief line 761); made-up paths.
 */

const { spawn } = require('child_process');
const { assert, fs, path, ROOT, tmpDir, rmrf, run, sleep, it, runAll } = require('./helpers');
const { makeLog, M, ns, wall, as } = require('./helpers-opon');
const { createLive } = require('../src/opon/intake/live');
const { createRouter } = require('../src/opon/intake/router');
const { replayFolder } = require('../src/opon/replay');
const { intakePaths, statusOf } = require('../src/opon/intake/server');

const KEY = Buffer.alloc(32, 7);
const SRC = path.join(__dirname, '..', 'src');
const rawRecords = (dir) => fs.readFileSync(path.join(dir, 'raw.jsonl'), 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));
const notes = (dir) => rawRecords(dir).filter((m) => m.says === 'overlapped').map((m) => [m.detail.session, m.detail.ended, 'busy' in m.detail ? m.detail.busy : 'none']);
const cmd = (text) => ({ kind: 'command', text });

/** A runs `make` from 4 s to 8 s and a change is seen at 5 s; B does what `b` says, each [ms, mark]. Returns both folders and A's odù of the change. */
function pairRun(base, name, b, { peerBusy = true } = {}) {
  const sub = path.join(base, name);
  fs.mkdirSync(sub);
  let now = 0;
  const st = {};
  const logs = {};
  const live = createLive({ key: KEY, peerBusy, clock: () => ({ mono: ns(now), wall: wall(now) }), receive: (m) => logs[m.session_id].append(m), error: (r) => assert.fail(r) });
  logs.ses_a = makeLog(sub, {}, { sessionId: 'ses_a', onRecord: (r) => st.a && live.feed(st.a, r) });
  logs.ses_b = makeLog(sub, {}, { sessionId: 'ses_b', root: logs.ses_a.root, onRecord: (r) => st.b && live.feed(st.b, r) });
  st.a = live.open(logs.ses_a.dir, logs.ses_a.sealedHeader, null);
  live.pair(st.a);
  st.b = live.open(logs.ses_b.dir, logs.ses_b.sealedHeader, null);
  live.pair(st.b);
  const a = [[4000, M.started(4000, 'c1', cmd('make'), 'Bash')], [5000, M.disk(5000, 'src/made.ts')], [8000, M.exited(8000, 'c1', 'make')], [8000, M.turnEnded(8000)], [20000, M.tick(20000)]];
  const events = [...b.map(([ms, m]) => [ms, 'ses_b', m]), ...a.map(([ms, m]) => [ms, 'ses_a', m])].sort((x, y) => x[0] - y[0]);
  for (const [ms, who, m] of events) {
    now = ms;
    logs[who].append(as(who, m));
  }
  const odu = fs.readFileSync(path.join(logs.ses_a.dir, 'odu.jsonl'), 'utf8');
  const replayed = replayFolder(logs.ses_a.dir);
  assert.strictEqual(replayed.ok, true, replayed.words);
  assert.strictEqual(replayed.odu, odu, `${name}: replay gives the live odù log (guarantee 3)`);
  const made = odu.split('\n').slice(1, -1).map((l) => JSON.parse(l)).find((o) => o.target && o.target.path === 'src/made.ts');
  return { a: logs.ses_a.dir, b: logs.ses_b.dir, made };
}
const blame = (o) => [o.attribution, o.cause, o.conflicts.map((c) => [c.kind, c.sessions])];
const both = [['concurrent_sessions', ['ses_a', 'ses_b']]];
const background = (ms, call) => ({ ...M.exited(ms, call, 'sleep 60 &'), detail: { tool: 'Bash', exit_status: 'unknown', background: true, output_excerpt: '' } });

it('AT1b: B prompts and its turn ends before A\'s command: A\'s log notes B busy, then idle, and the change during A\'s command is A\'s (step 3, medium); both witnesses joined; live equals replay', () => {
  const base = tmpDir();
  try {
    const r = pairRun(base, 'idle', [[100, M.prompted(100)], [200, M.claimed(200)], [200, M.turnEnded(200)], [20000, M.tick(20000)]]);
    assert.deepStrictEqual(notes(r.a), [['ses_b', false, false], ['ses_b', false, true], ['ses_b', false, false]], 'named idle at its start, busy at its prompt, idle at its turn\'s end');
    assert.deepStrictEqual(blame(r.made), ['explained', { kind: 'agent_command', ref: 'c1' }, []]);
    assert.deepStrictEqual([r.made.confidence, r.made.witness_status.glove.status, r.made.witness_status.sentinel.status], ['medium', 'saw_nothing', 'saw']);
    assert.deepStrictEqual(notes(r.b).map((n) => n[2]), [false, true, false], 'B\'s log notes A too: A\'s first call opened its turn, its end closed it');
  } finally {
    rmrf(base);
  }
});

it('AT1b: while B is working (its prompt at 4.5 s), the change is not credited to A: a concurrent_sessions conflict names both (test 37\'s rule)', () => {
  const base = tmpDir();
  try {
    const r = pairRun(base, 'busy', [[4500, M.prompted(4500)], [20000, M.tick(20000)]]);
    assert.deepStrictEqual(notes(r.a), [['ses_b', false, false], ['ses_b', false, true]]);
    assert.deepStrictEqual(blame(r.made), ['unexplained', null, both]);
  } finally {
    rmrf(base);
  }
});

it('AT1b: B leaves a command running in the background, or the Glove records it outside a turn: B stays busy for the rest of its session, and the change is not credited to A', () => {
  const base = tmpDir();
  try {
    const bg = pairRun(base, 'background', [[100, M.prompted(100)], [150, M.started(150, 'bg1', cmd('sleep 60 &'), 'Bash')], [160, background(160, 'bg1')], [200, M.turnEnded(200)], [20000, M.tick(20000)]]);
    assert.deepStrictEqual(notes(bg.a), [['ses_b', false, false], ['ses_b', false, true]], 'no idle note after a command left running');
    assert.deepStrictEqual(blame(bg.made), ['unexplained', null, both]);
    const outside = pairRun(base, 'outside', [[100, M.prompted(100)], [200, M.turnEnded(200)], [3500, M.started(3500, 's1', cmd('ls'), 'Bash', 't2')], [3600, M.turnEnded(3600, 't2')], [20000, M.tick(20000)]]);
    assert.deepStrictEqual(notes(outside.a).map((n) => n[2]), [false, true, false, true], 'busy again at the call outside a turn, and its next turn\'s end leaves it busy');
    assert.deepStrictEqual(blame(outside.made), ['unexplained', null, both]);
  } finally {
    rmrf(base);
  }
});

it('AT1b: with the switch off nothing changes: the overlapped marks carry no busy note and the change is read as before AT1', () => {
  const base = tmpDir();
  try {
    const r = pairRun(base, 'off', [[100, M.prompted(100)], [200, M.turnEnded(200)], [20000, M.tick(20000)]], { peerBusy: false });
    assert.deepStrictEqual(notes(r.a), [['ses_b', false, 'none']]);
    assert.deepStrictEqual(blame(r.made), ['unexplained', null, both]);
  } finally {
    rmrf(base);
  }
});

it('AT1b: after a restart, a pair already named is told the peer\'s state again when it changed while the intake was down, and not when it did not', () => {
  const base = tmpDir();
  try {
    let now = 0;
    const st = {};
    const logs = {};
    let live = null;
    const make = () => createLive({ key: KEY, peerBusy: true, clock: () => ({ mono: ns(now), wall: wall(now) }), receive: (m) => logs[m.session_id].append(m), error: (r) => assert.fail(r) });
    live = make();
    logs.ses_a = makeLog(base, {}, { sessionId: 'ses_a', onRecord: (r) => st.a && live.feed(st.a, r) });
    logs.ses_b = makeLog(base, {}, { sessionId: 'ses_b', root: logs.ses_a.root, onRecord: (r) => st.b && live.feed(st.b, r) });
    st.a = live.open(logs.ses_a.dir, logs.ses_a.sealedHeader, null);
    live.pair(st.a);
    st.b = live.open(logs.ses_b.dir, logs.ses_b.sealedHeader, null);
    live.pair(st.b);
    st.a = null; // the intake stops
    st.b = null;
    now = 1000;
    logs.ses_b.append(as('ses_b', M.prompted(1000))); // B's prompt while it was down (as a restart's catch-up would write it)
    now = 2000;
    live = make();
    const resume = (log) => live.resume(log.dir, log.sealedHeader, null, rawRecords(log.dir).slice(1));
    st.a = resume(logs.ses_a);
    st.b = resume(logs.ses_b);
    live.pair(st.a);
    live.pair(st.b);
    assert.deepStrictEqual(notes(logs.ses_a.dir).map((n) => n[2]), [false, true], 'A is told B is busy now');
    assert.deepStrictEqual(notes(logs.ses_b.dir).map((n) => n[2]), [false], 'B is not told A again: A is still idle');
  } finally {
    rmrf(base);
  }
});

function fakeClock() {
  let mono = 5000n * 1000000n;
  let w = Date.UTC(2026, 10, 26, 1, 0, 0, 0);
  const clock = () => ({ mono: mono.toString(), wall: new Date(w).toISOString() });
  clock.advance = (ms) => {
    mono += BigInt(ms) * 1000000n;
    w += ms;
  };
  return clock;
}

it('AT1b: the router passes its peerBusy option to the live path; without it, no busy note', () => {
  const base = tmpDir();
  try {
    for (const on of [true, false]) {
      const sub = path.join(base, String(on));
      const home = path.join(sub, 'home');
      const project = path.join(sub, 'project');
      fs.mkdirSync(project, { recursive: true });
      const clock = fakeClock();
      const router = createRouter({ home, clock, checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: true, ...(on ? { peerBusy: true } : {}) });
      const ev = (sid, x) => ({ session_id: sid, transcript_path: '/tmp/t.jsonl', cwd: project, ...x });
      const send = (x) => assert.strictEqual(router.payload(x, { channel: 'command' }).ok, true, x.hook_event_name);
      send(ev('ses_ra', { hook_event_name: 'UserPromptSubmit', prompt: 'one' }));
      clock.advance(100);
      send(ev('ses_rb', { hook_event_name: 'UserPromptSubmit', prompt: 'two' }));
      clock.advance(100);
      send(ev('ses_rb', { hook_event_name: 'Stop', last_assistant_message: 'Nothing to do.' }));
      const got = notes(path.join(home, 'sessions', 'ses_ra'));
      if (on) {
        assert.ok(got.length >= 2 && got.some((n) => n[2] === true), JSON.stringify(got));
        assert.strictEqual(got[got.length - 1][2], false, 'B idle after its Stop: ' + JSON.stringify(got));
      } else assert.deepStrictEqual(got, [['ses_rb', false, 'none']]);
    }
  } finally {
    rmrf(base);
  }
});

async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(20);
  }
  return cond();
}
const req = (payload) => JSON.stringify({ op: 'payload', payload }) + '\n';
function send(sock, text) {
  return new Promise((resolve, reject) => {
    const c = require('net').createConnection(sock);
    c.on('error', reject);
    c.on('close', () => resolve());
    c.on('connect', () => c.end(text));
  });
}

/** `orunmila intake run` in a throwaway home with `env`; two sessions in one project, B's turn ended; returns the output and A's notes. */
async function intakeRun(home, env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'orunmila.js'), 'intake', 'run'], { env: { ...process.env, ORUNMILA_PEER_BUSY: '', ...env, ORUNMILA_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    const at = intakePaths(home); // W4b: at.sock read at each use (on Windows each start publishes a fresh pipe name)
    assert.ok(await until(async () => (await statusOf(at.sock, 300)) !== null), 'the intake answers: ' + out);
    assert.ok(await until(() => /ORUNMILA_PEER_BUSY/.test(out)), 'a line about the busy notes: ' + out);
    const project = path.join(home, '..', 'p');
    fs.mkdirSync(project, { recursive: true });
    const ev = (sid, x) => req({ session_id: sid, transcript_path: '/tmp/t.jsonl', cwd: project, ...x });
    await send(at.sock, ev('ses_ia', { hook_event_name: 'UserPromptSubmit', prompt: 'one' }));
    const rawA = path.join(home, 'sessions', 'ses_ia', 'raw.jsonl');
    assert.ok(await until(() => fs.existsSync(rawA) && fs.readFileSync(rawA, 'utf8').includes('"prompted"')), 'A begun');
    await send(at.sock, ev('ses_ib', { hook_event_name: 'UserPromptSubmit', prompt: 'two' }));
    await send(at.sock, ev('ses_ib', { hook_event_name: 'Stop', last_assistant_message: 'Nothing to do.' }));
    const rawB = path.join(home, 'sessions', 'ses_ib', 'raw.jsonl');
    assert.ok(await until(() => fs.existsSync(rawB) && fs.readFileSync(rawB, 'utf8').includes('"claimed"')), 'B\'s Stop written');
    const r = run('bin/orunmila.js', { args: ['intake', 'stop'], env: { ORUNMILA_HOME: home } });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(await exited, 0);
    return { out, notes: notes(path.join(home, 'sessions', 'ses_ia')) };
  } catch (e) {
    child.kill('SIGKILL');
    await exited;
    throw e;
  }
}

it('AT1b, PB1: intake run writes the busy notes by default (unset or empty) and with ORUNMILA_PEER_BUSY=1, and says so; with 0 it says so and writes none', async () => {
  const base = tmpDir();
  try {
    const env = { ORUNMILA_INTAKE_PORT: '0', ORUNMILA_OPON_LIVE: '1' }; // never the real port (LD140); the live path pairs sessions
    // PB1 (O's word, 2026-11-27, with MR7 and Q38): on by default; intakeRun passes ORUNMILA_PEER_BUSY '' unless given.
    const dflt = await intakeRun(path.join(base, 'default', 'h'), env);
    assert.ok(dflt.out.includes("orunmila intake: each session's log notes when a peer sharing its folder is working (on by default; ORUNMILA_PEER_BUSY=0 turns it off)"), dflt.out);
    assert.ok(dflt.notes.some((n) => n[2] === true) && dflt.notes[dflt.notes.length - 1][2] === false, JSON.stringify(dflt.notes));
    const on = await intakeRun(path.join(base, 'on', 'h'), { ...env, ORUNMILA_PEER_BUSY: '1' });
    assert.ok(on.out.includes("orunmila intake: each session's log notes when a peer sharing its folder is working (ORUNMILA_PEER_BUSY=1)"), on.out);
    assert.ok(on.notes.some((n) => n[2] === true) && on.notes[on.notes.length - 1][2] === false, JSON.stringify(on.notes));
    const off = await intakeRun(path.join(base, 'off', 'h'), { ...env, ORUNMILA_PEER_BUSY: '0' });
    assert.ok(off.out.includes("orunmila intake: a peer's busy time is not noted (ORUNMILA_PEER_BUSY=0)"), off.out);
    assert.deepStrictEqual(off.notes, [['ses_ib', false, 'none']]);
  } finally {
    rmrf(base);
  }
});

it('PB1: peerBusyOn is on unless ORUNMILA_PEER_BUSY is 0, and says where its answer came from', () => {
  const { peerBusyOn } = require('../src/opon/intake/switches');
  assert.deepStrictEqual(peerBusyOn({}), { on: true, from: 'default' });
  assert.deepStrictEqual(peerBusyOn({ ORUNMILA_PEER_BUSY: '' }), { on: true, from: 'default' });
  assert.deepStrictEqual(peerBusyOn({ ORUNMILA_PEER_BUSY: '1' }), { on: true, from: 'environment' });
  assert.deepStrictEqual(peerBusyOn({ ORUNMILA_PEER_BUSY: '0' }), { on: false, from: 'environment' });
  assert.deepStrictEqual(peerBusyOn({ ORUNMILA_PEER_BUSY: 'no' }), { on: true, from: 'default' }, 'only 0 turns it off');
});

runAll('peer-busy');
