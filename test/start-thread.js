'use strict';

/**
 * test/start-thread.js — a session's start off the intake's thread (Phase 6 slice SN1, LD294; F16). With `asyncStart`
 * (ORUNMILA_ASYNC_START=1, off by default) the baseline snapshot and the Sentinel's first read run in a worker thread;
 * the session's payloads wait in a queue meanwhile, each with its arrival time and the file facts measured then, and
 * are written in order once its log exists. The earliest observation of a file wins: a queued PreToolUse's measured
 * state replaces the baseline's entry for that file, so an agent write that lands before the worker reads the file is
 * still a change. The test holds the worker's answer back (`prepare`) to make every step exact; one test runs the real
 * worker thread. Throwaway folders; made-up file contents.
 */

const crypto = require('crypto');
const { assert, fs, path, tmpDir, rmrf, sleep, it, runAll } = require('./helpers');
const { createRouter } = require('../src/opon/intake/router');
const { prepare } = require('../src/opon/intake/start-worker');
const { replayFolder } = require('../src/opon/replay');

const SRC = path.join(__dirname, '..', 'src');
const KEY = Buffer.alloc(32, 7);
const sha = (s) => 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l)) : []);

function setup({ held }) {
  const home = fs.realpathSync(tmpDir());
  const project = fs.realpathSync(tmpDir());
  let mono = 7000n * 1000000n;
  const clock = () => {
    mono += 1000000n; // every reading a millisecond later
    return { mono: mono.toString(), wall: new Date(Date.UTC(2026, 10, 24) + Number(mono / 1000000n)).toISOString() };
  };
  const jobs = [];
  const prepareHeld = (job) => new Promise((resolve) => jobs.push(() => resolve(prepare(job))));
  const router = createRouter({ home, clock, checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: true, asyncStart: true, ...(held ? { prepare: prepareHeld } : {}) });
  const base = { session_id: 'ses_async', transcript_path: '/tmp/t.jsonl', cwd: project };
  const send = (x) => router.payload({ ...base, ...x }, { channel: 'command' });
  const dir = path.join(home, 'sessions', 'ses_async');
  const done = () => {
    router.stop('over');
    rmrf(home);
    rmrf(project);
  };
  const monoNow = () => mono;
  const advance = (ms) => (mono += BigInt(ms) * 1000000n);
  return { home, project, router, send, dir, jobs, done, monoNow, advance };
}

it("SN1 (LD294): a new session's payloads are queued at once while its start runs off the thread, then written in order, each with the time it arrived and the file facts measured then", async () => {
  const t = setup({ held: true });
  try {
    const file = path.join(t.project, 'a.txt');
    fs.writeFileSync(file, 'A\n');
    const r = t.send({ hook_event_name: 'UserPromptSubmit', prompt: 'edit a' });
    assert.deepStrictEqual([r.ok, r.queued], [true, true], JSON.stringify(r));
    assert.ok(!fs.existsSync(path.join(t.dir, 'raw.jsonl')), 'no log yet: the start is still running');
    t.send({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'B\n' }, tool_use_id: 'w1' });
    fs.writeFileSync(file, 'B\n'); // the agent's write, before the worker read the file
    t.send({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'B\n' }, tool_response: {}, tool_use_id: 'w1' });
    fs.writeFileSync(file, 'C\n'); // later still: no payload of the queue saw it
    assert.strictEqual(t.jobs.length, 1, 'one start for the session');
    const released = t.monoNow();
    t.jobs[0]();
    for (let i = 0; i < 50 && !fs.existsSync(path.join(t.dir, 'raw.jsonl')); i++) await sleep(10);
    const raw = lines(path.join(t.dir, 'raw.jsonl'));
    const marks = raw.slice(1);
    assert.deepStrictEqual(marks.map((m) => m.says), ['prompted', 'started', 'modified']);
    const w = marks[2];
    assert.deepStrictEqual([w.detail.fingerprint_before, w.detail.fingerprint], [sha('A\n'), sha('B\n')], 'facts as measured when each payload arrived');
    assert.ok(marks.every((m, i) => i === 0 || BigInt(m.mono_ns) > BigInt(marks[i - 1].mono_ns)), 'arrival order');
    assert.ok(marks.every((m) => BigInt(m.mono_ns) <= released), 'each stamped when it arrived, before the start finished');
    const releasedWall = Date.UTC(2026, 10, 24) + Number(released / 1000000n);
    assert.ok(marks.every((m) => Date.parse(m.observed_at) <= releasedWall), 'its wall time too (observed_at)');
    assert.ok(BigInt(raw[0].mono_ns) < BigInt(marks[0].mono_ns), 'the header is the session start, when its first payload arrived');
    const baseline = fs.readFileSync(path.join(t.dir, 'baseline.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.strictEqual(baseline.find((e) => e.path === 'a.txt').fingerprint, sha('A\n'), "the earliest observation wins: the queued PreToolUse's state, not the worker's later read");
    assert.strictEqual(raw[0].baseline.fingerprint, sha(fs.readFileSync(path.join(t.dir, 'baseline.jsonl'))), 'the header names the baseline kept');
    const again = t.send({ hook_event_name: 'Stop', last_assistant_message: 'I wrote a.txt.' });
    assert.strictEqual(again.queued, undefined, 'once the log exists, payloads are written at once');
    assert.strictEqual(lines(path.join(t.dir, 'raw.jsonl')).length, raw.length + 2);
  } finally {
    t.done();
  }
});

it("SN2 (LD295): the closeout's rescan runs off the thread: its started mark at once, the session's own payloads queued meanwhile, then the rescan's marks and exited, then the queued payloads", async () => {
  const t = setup({ held: true });
  try {
    const hand = path.join(t.project, 'hand.txt');
    fs.writeFileSync(hand, 'old\n');
    t.send({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    t.jobs[0]();
    for (let i = 0; i < 50 && !fs.existsSync(path.join(t.dir, 'raw.jsonl')); i++) await sleep(10);
    t.send({ hook_event_name: 'Stop', last_assistant_message: 'Nothing changed.' });
    t.send({ hook_event_name: 'SessionEnd', reason: 'exit' });
    fs.writeFileSync(hand, 'by hand\n'); // the rescan must find it
    t.advance(4000);
    t.router.poll(); // the lag grace has passed: the closeout begins
    const says = () => lines(path.join(t.dir, 'raw.jsonl')).slice(1).map((m) => `${m.says}${m.target && m.target.name ? ':' + m.target.name : ''}`);
    assert.deepStrictEqual(says().slice(-1), ['started:closeout'], 'its started mark at once');
    assert.strictEqual(t.jobs.length, 2, 'the rescan went to the worker');
    const late = t.send({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'true' }, tool_use_id: 'late1', error: 'x' });
    assert.strictEqual(late.queued, true, "the session's own payload waits for its sweep");
    t.jobs[1]();
    for (let i = 0; i < 50 && !says().includes('exited:closeout'); i++) await sleep(10);
    const after = says();
    const start = after.lastIndexOf('started:closeout');
    const end = after.indexOf('exited:closeout');
    assert.ok(start >= 0 && end > start, after.join(' '));
    assert.ok(after.slice(start + 1, end).includes('fingerprinted'), "the rescan's mark for the hand edit, inside the sweep");
    assert.ok(end < after.length - 1 && after[after.length - 1] === 'exited', `the queued payload (a failed command: exited) after the sweep's exited: ${after.join(' ')}`);
    assert.ok(fs.existsSync(path.join(t.dir, 'footer.json')), 'the footer at the closeout');
  } finally {
    t.done();
  }
});

it('SN1: the real worker thread: the session starts, its baseline names every file, and the live odù log equals replay', async () => {
  const t = setup({ held: false });
  try {
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(t.project, `f${i}.txt`), `file ${i}\n`);
    assert.strictEqual(t.send({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }).queued, true);
    for (let i = 0; i < 300 && !fs.existsSync(path.join(t.dir, 'raw.jsonl')); i++) await sleep(10);
    for (let i = 0; i < 300 && lines(path.join(t.dir, 'raw.jsonl')).length < 2; i++) await sleep(10);
    const raw = lines(path.join(t.dir, 'raw.jsonl'));
    assert.deepStrictEqual(raw.slice(1).map((m) => m.says), ['prompted']);
    assert.strictEqual(fs.readFileSync(path.join(t.dir, 'baseline.jsonl'), 'utf8').split('\n').filter(Boolean).length, 50);
    assert.strictEqual(fs.readFileSync(path.join(t.dir, 'odu.jsonl'), 'utf8'), replayFolder(t.dir).odu);
  } finally {
    t.done();
  }
});

it('SN1: without asyncStart (the default) a new session starts at once in the intake thread, as before', () => {
  const home = fs.realpathSync(tmpDir());
  const project = fs.realpathSync(tmpDir());
  try {
    const router = createRouter({ home, clock: () => ({ mono: '7000000000000', wall: '2026-11-24T00:00:07.000Z' }), checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: true });
    const r = router.payload({ session_id: 's', transcript_path: '/tmp/t.jsonl', cwd: project, hook_event_name: 'UserPromptSubmit', prompt: 'go' }, { channel: 'command' });
    assert.strictEqual(r.queued, undefined);
    assert.ok(fs.existsSync(path.join(home, 'sessions', 's', 'raw.jsonl')));
    router.stop('over');
  } finally {
    rmrf(home);
    rmrf(project);
  }
});

runAll('start-thread');
