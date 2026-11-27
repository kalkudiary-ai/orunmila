// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/intake-sentinel.js — the Sentinel inside the intake (slice B4, LD145;
 * brief v4 station 1, lines 345-351; N2, N3, NF11, NF14, NF21). Real fs.watch
 * on throwaway folders; made-up file contents only.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll, sleep, awaitWatching, slash, notOnWindows, intakeAnswers } = require('./helpers');
const crypto = require('crypto');
const { createRouter } = require('../src/opon/intake/router');
const { checkLog, verifySession } = require('../src/verify/session');
const { nowMono } = require('../src/opon/intake/mono');

const SRC = path.join(__dirname, '..', 'src');
const KEY = crypto.randomBytes(32);
const sha = (buf) => 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');

function setup({ releaseMs, sentinelMaxPending } = {}) {
  const home = fs.realpathSync(tmpDir());
  const root = fs.realpathSync(tmpDir());
  const router = createRouter({
    home,
    clock: () => ({ mono: nowMono(), wall: new Date().toISOString() }),
    checkSender: () => true,
    codeRoot: SRC,
    orunmilaVersion: '0.0.0-test',
    installKey: KEY,
    hookSettingsFor: () => [],
    sentinel: true,
    releaseMs,
    sentinelMaxPending,
  });
  const dirOf = (id) => path.join(home, 'sessions', id);
  const marks = (id) => checkLog(dirOf(id), 'raw').records.map((r) => r.rec).slice(1);
  const sentinelMarks = (id) => marks(id).filter((m) => m.source === 'sentinel');
  const done = () => {
    router.stop('test over');
    rmrf(home);
    rmrf(root);
  };
  return { home, root, router, dirOf, marks, sentinelMarks, done };
}

const open = (t, id) => t.router.payload({ session_id: id, hook_event_name: 'SessionStart', cwd: t.root }, { channel: 'command' });

it("Q12 (a) (LD212, LD289): with extra folders named (ORUNMILA_WATCH_EXTRA, off by default), the Sentinel watches each for every held session: a write there is a sentinel mark with the file's absolute path, outside the project; with none named, it is not seen", async () => {
  for (const on of [true, false]) {
    const extra = fs.realpathSync(tmpDir());
    const home = fs.realpathSync(tmpDir());
    const root = fs.realpathSync(tmpDir());
    const missing = path.join(extra, 'no-such-folder');
    const router = createRouter({ home, clock: () => ({ mono: nowMono(), wall: new Date().toISOString() }), checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], sentinel: true, watchExtra: on ? [extra, missing] : [] });
    if (on) assert.ok(fs.readFileSync(path.join(home, 'intake', 'errors.jsonl'), 'utf8').includes('no-such-folder'), 'a folder that is not there is named in the error log, not watched');
    const marks = () => checkLog(path.join(home, 'sessions', 'sx'), 'raw').records.map((r) => r.rec).slice(1).filter((m) => m.source === 'sentinel');
    try {
      router.payload({ session_id: 'sx', hook_event_name: 'SessionStart', cwd: root }, { channel: 'command' });
      assert.deepStrictEqual(router.watching(), on ? [extra, root].sort() : [root]);
      const outside = (p) => marks().some((m) => m.target.path === slash(p) && m.target.outside === true); // recorded with `/` on every OS
      if (on) {
        assert.ok(await awaitWatching(extra, outside), 'a write in the extra folder became a sentinel mark naming its absolute path, outside');
        const m = marks().find((x) => x.target.outside);
        assert.strictEqual(m.detail.root, extra, 'the mark names the folder watched');
      } else {
        fs.writeFileSync(path.join(extra, 'not-watched.txt'), 'x');
        await sleep(600);
        assert.deepStrictEqual(marks().filter((x) => x.target.outside), [], 'off: nothing outside the project is watched');
      }
    } finally {
      router.stop('test over');
      rmrf(home);
      rmrf(root);
      rmrf(extra);
    }
  }
});

async function until(cond, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (cond()) return true;
  return cond();
}

/** Wait until the session's watcher delivers, with probe files under `dir`. */
async function watching(t, id, dir = t.root) {
  const ok = await awaitWatching(dir, (p) => t.sentinelMarks(id).some((m) => m.target.path === path.relative(t.root, p).split(path.sep).join('/')));
  assert.ok(ok, 'the watcher delivered a probe write');
}

it('B4: a write under the root becomes a sentinel mark naming its root, with fingerprints, line counts and its diff kept whole', async () => {
  const t = setup();
  try {
    open(t, 's1');
    await watching(t, 's1');
    const p = path.join(t.root, 'a.txt');
    fs.writeFileSync(p, 'one\ntwo\n');
    assert.ok(await until(() => t.sentinelMarks('s1').some((m) => m.target.path === 'a.txt')), 'created mark');
    const c = t.sentinelMarks('s1').find((m) => m.target.path === 'a.txt');
    assert.strictEqual(c.says, 'created');
    assert.strictEqual(c.turn, null);
    assert.strictEqual(c.agent, null);
    assert.strictEqual(c.detail.root, t.root);
    assert.strictEqual(c.detail.fingerprint, sha(Buffer.from('one\ntwo\n')));
    assert.ok(!('fingerprint_before' in c.detail), 'a created mark leaves fingerprint_before out (line 265)');
    assert.strictEqual(c.detail.lines_added, 2);
    fs.writeFileSync(p, 'one\nTWO\nthree\n');
    assert.ok(await until(() => t.sentinelMarks('s1').some((m) => m.target.path === 'a.txt' && m.says === 'modified')), 'modified mark');
    const m = t.sentinelMarks('s1').find((x) => x.target.path === 'a.txt' && x.says === 'modified');
    assert.strictEqual(m.detail.fingerprint_before, c.detail.fingerprint);
    assert.strictEqual(m.detail.lines_added, 2);
    assert.strictEqual(m.detail.lines_removed, 1);
    const diff = fs.readFileSync(path.join(t.dirOf('s1'), 'files', m.detail.diff_ref.slice(7)), 'utf8');
    assert.ok(diff.includes('+TWO') && diff.includes('+three') && diff.includes('-two'), diff);
    fs.rmSync(p);
    assert.ok(await until(() => t.sentinelMarks('s1').some((x) => x.target.path === 'a.txt' && x.says === 'deleted')), 'deleted mark');
    assert.strictEqual(verifySession(t.dirOf('s1')).ok, true, verifySession(t.dirOf('s1')).words);
  } finally {
    t.done();
  }
});

it("B4 (N3): a write in the project's .orunmila/ is seen; node_modules stays out and the header lists it", async () => {
  const t = setup();
  try {
    fs.mkdirSync(path.join(t.root, '.orunmila'));
    fs.mkdirSync(path.join(t.root, 'node_modules'));
    open(t, 's1');
    await watching(t, 's1');
    await watching(t, 's1', path.join(t.root, '.orunmila'));
    fs.writeFileSync(path.join(t.root, 'node_modules', 'x.js'), 'x');
    fs.writeFileSync(path.join(t.root, '.orunmila', 'byproducts'), 'dist/\n');
    assert.ok(await until(() => t.sentinelMarks('s1').some((m) => m.target.path === '.orunmila/byproducts')), '.orunmila/ is watched');
    await sleep(400);
    assert.ok(!t.sentinelMarks('s1').some((m) => m.target.path.startsWith('node_modules')), 'node_modules is not watched');
    const header = checkLog(t.dirOf('s1'), 'raw').records[0].rec;
    assert.ok(header.config.exclusions.includes('node_modules/'), 'what the Sentinel does not watch is in the header');
    assert.ok(!header.config.exclusions.includes('.orunmila/'), '.orunmila/ is not excluded');
  } finally {
    t.done();
  }
});

it('B4 (N2): a folder the Sentinel cannot watch is a gap mark naming it, never only printed', async () => {
  if (process.getuid && process.getuid() === 0) return; // root reads a 000 folder
  if (notOnWindows('intake-sentinel B4 (N2): chmod 000 cannot shut a folder on Windows')) return;
  const t = setup();
  const shut = path.join(t.root, 'shut');
  fs.mkdirSync(shut);
  fs.chmodSync(shut, 0o000);
  try {
    open(t, 's1');
    assert.ok(await until(() => t.marks('s1').some((m) => m.says === 'gap' && m.source === 'process')), 'a gap mark');
    const g = t.marks('s1').find((m) => m.says === 'gap');
    assert.ok(g.detail.lost.includes(shut), g.detail.lost);
    assert.strictEqual(g.detail.root, t.root);
  } finally {
    fs.chmodSync(shut, 0o755);
    t.done();
  }
});

it("B4: two sessions on one root share one watcher, and a write reaches both logs; the watcher stops with its last session", async () => {
  const t = setup({ releaseMs: 0 });
  try {
    open(t, 's1');
    open(t, 's2');
    assert.deepStrictEqual(t.router.watching(), [t.root]);
    await watching(t, 's1');
    fs.writeFileSync(path.join(t.root, 'b.txt'), 'b');
    assert.ok(await until(() => ['s1', 's2'].every((id) => t.sentinelMarks(id).some((m) => m.target.path === 'b.txt'))), 'both logs');
    t.router.poll(); // releaseMs 0: both sessions are released
    assert.deepStrictEqual(t.router.held(), []);
    assert.deepStrictEqual(t.router.watching(), []);
  } finally {
    t.done();
  }
});

it('B4: a file over the diff size limit is marked no_diff too_large, its diff never cut short', async () => {
  const t = setup();
  try {
    open(t, 's1');
    await watching(t, 's1');
    const limit = checkLog(t.dirOf('s1'), 'raw').records[0].rec.config.diff_size_limit_bytes;
    fs.writeFileSync(path.join(t.root, 'big.txt'), 'x'.repeat(limit + 1));
    assert.ok(await until(() => t.sentinelMarks('s1').some((m) => m.target.path === 'big.txt')), 'big mark');
    const m = t.sentinelMarks('s1').find((x) => x.target.path === 'big.txt');
    assert.strictEqual(m.detail.no_diff, 'too_large');
    assert.ok(!('diff_ref' in m.detail));
    assert.strictEqual(m.detail.size, limit + 1);
  } finally {
    t.done();
  }
});

it('B4: without the sentinel option the router watches nothing (the unit tests and old callers)', () => {
  const home = fs.realpathSync(tmpDir());
  const root = fs.realpathSync(tmpDir());
  try {
    const router = createRouter({ home, clock: () => ({ mono: nowMono(), wall: new Date().toISOString() }), checkSender: () => true, codeRoot: SRC, orunmilaVersion: 't', installKey: KEY, hookSettingsFor: () => [] });
    router.payload({ session_id: 's1', hook_event_name: 'SessionStart', cwd: root }, { channel: 'command' });
    assert.deepStrictEqual(router.watching(), []);
    router.stop('over');
  } finally {
    rmrf(home);
    rmrf(root);
  }
});

it('B4 CLI: intake run watches a session\'s root, so a write there reaches its log as a sentinel mark', async () => {
  const { spawn } = require('child_process');
  const net = require('net');
  const home = fs.realpathSync(tmpDir());
  const root = fs.realpathSync(tmpDir());
  const env = { ...process.env, ORUNMILA_HOME: home, ORUNMILA_INTAKE_PORT: '0' };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'orunmila.js'), 'intake', 'run'], { env, stdio: 'ignore' });
  const paths = require('../src/opon/intake/server').intakePaths(home); // W3e, W4b: a named pipe on Windows, its name read at use
  try {
    assert.ok(await intakeAnswers(home), 'the intake listens');
    await new Promise((resolve, reject) => {
      const c = net.createConnection(paths.sock,() => c.end(JSON.stringify({ op: 'payload', payload: { session_id: 'cli1', hook_event_name: 'SessionStart', cwd: root } }) + '\n'));
      c.on('close', resolve);
      c.on('error', reject);
    });
    const raw = path.join(home, 'sessions', 'cli1', 'raw.jsonl');
    assert.ok(await until(() => fs.existsSync(raw)), 'the session log is made');
    const seen = () => checkLog(path.join(home, 'sessions', 'cli1'), 'raw').records.some((r) => r.rec.source === 'sentinel');
    assert.ok(await awaitWatching(root, seen), 'a write under the root reached the log');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    rmrf(home);
    rmrf(root);
  }
});

// T32 (test 32, LD374): a Sentinel flooded past its limit drops what comes after it, and says so in one gap; the
// closeout's rescan (K2, test/closeout.js) is what finds a dropped change. The limit is off unless set.
it('test 32: a Sentinel flooded past its limit (ORUNMILA_SENTINEL_MAX_PENDING) drops what comes after it and writes one gap naming the loss, then recovers; with no limit (the default) every change is a mark', async () => {
  const { createSentinels } = require('../src/opon/intake/sentinel');
  const { unifiedDiff } = require('../src/reconcile/difftool');
  for (const cap of [3, undefined]) {
    const root = fs.realpathSync(tmpDir());
    const out = [];
    const s = createSentinels({ clock: () => ({ mono: nowMono(), wall: new Date().toISOString() }), key: KEY, diffOf: unifiedDiff, emit: (r, m) => out.push(m), debounceMs: 400, maxPending: cap });
    try {
      s.watch(root, 1 << 20);
      assert.ok(await awaitWatching(root, () => out.some((m) => m.source === 'sentinel')), 'the watch is live');
      out.length = 0;
      for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), `v${i}\n`);
      await sleep(1500);
      const files = out.filter((m) => m.source === 'sentinel' && /^f[0-9]+\.txt$/.test(m.target.path)).length; // awaitWatching's probes left out
      const gaps = out.filter((m) => m.says === 'gap');
      if (cap) {
        assert.strictEqual(gaps.length, 1, JSON.stringify(gaps));
        assert.ok(/dropped/.test(gaps[0].detail.lost) && gaps[0].detail.root === root, JSON.stringify(gaps[0]));
        assert.ok(files <= cap, `${files} marks for 20 changes`);
        out.length = 0;
        fs.writeFileSync(path.join(root, 'after.txt'), 'later\n');
        await sleep(1000);
        assert.ok(out.some((m) => m.source === 'sentinel' && m.target.path === 'after.txt'), 'once the flood drained, changes are read again');
        out.length = 0;
        for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, `g${i}.txt`), `w${i}\n`);
        await sleep(1500);
        assert.strictEqual(out.filter((m) => m.says === 'gap').length, 1, 'a second flood is named again');
      } else {
        assert.strictEqual(gaps.length, 0);
        assert.strictEqual(files, 20);
      }
    } finally {
      s.stop();
      rmrf(root);
    }
  }
});

it("test 32 at the router (T32, LD374): with sentinelMaxPending, a flood's gap is in the session's log, which verifies intact", async () => {
  const t = setup({ sentinelMaxPending: 3 });
  try {
    open(t, 'fl1');
    assert.ok(await awaitWatching(t.root, () => t.sentinelMarks('fl1').length > 0), 'the watch is live');
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(t.root, `f${i}.txt`), `v${i}\n`);
    await sleep(1500);
    const gaps = t.marks('fl1').filter((m) => m.says === 'gap' && m.detail.root === t.root && /dropped/.test(m.detail.lost));
    assert.strictEqual(gaps.length, 1, JSON.stringify(t.marks('fl1').map((m) => m.says)));
    assert.strictEqual(verifySession(t.dirOf('fl1')).ok, true);
  } finally {
    t.done();
  }
});

runAll('intake-sentinel');
