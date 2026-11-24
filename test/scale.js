'use strict';

/**
 * test/scale.js — Phase 5's large-session half (slice LR2a, LD251; brief v4 line 616): the engine's work per mark
 * must not grow with the session's length, so a restart's replay of a long session stays proportional to it. Timed
 * as a ratio, four times the session against the session, so the machine's speed cancels out: linear work gives
 * about 4, work that walks the whole session at every turn gives about 16. Hand-built marks in memory.
 */

const { assert, it, runAll } = require('./helpers');
const { M } = require('./helpers-opon');
const { createOpon } = require('../src/opon/settle/engine');

const CONFIG = { quiet_window_ms: 1500, lag_grace_ms: 3000, ceiling_ms: 120000, exclusions: [] };

/** T turns, each a prompt, four commands (started, exited), a claim and the turn's end. */
function marks(T) {
  const out = [];
  let ms = 0;
  let seq = 0;
  const put = (m) => out.push({ ...m, seq: ++seq });
  for (let t = 1; t <= T; t++) {
    const turn = `t${t}`;
    ms += 1000;
    put(M.prompted(ms, turn));
    for (let k = 0; k < 4; k++) {
      const c = `c${t}_${k}`;
      ms += 200;
      put(M.started(ms, c, { kind: 'command', text: 'echo x' }, 'Bash', turn));
      ms += 50;
      put(M.exited(ms, c, 'echo x', 'pass', turn));
    }
    ms += 100;
    put({ ...M.claimed(ms, turn), detail: { text: 'Ran it.' } });
    put(M.turnEnded(ms, turn));
  }
  return out;
}

/** The fastest of three runs of the engine over T turns, in ms. */
function time(T) {
  const ms = marks(T);
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const o = createOpon({ sessionId: 'ses_replay_test', config: CONFIG, root: '/r' });
    const t0 = process.hrtime.bigint();
    for (const m of ms) o.push(m);
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return best;
}

// A timing test with a stated margin: the engine as fixed measured 4 to 6.4 here (a growing heap's collection adds to
// linear work), the walk of every past call 11.7; the limit, 9, sits between. A first limit of 6 failed once at 6.4.
it('LR2a (LD251): the engine\'s time grows in proportion to the session: four times the turns take under nine times as long (a walk of every past call at each turn\'s end took about twelve here, sixteen in the limit)', () => {
  time(500); // warm up
  const small = time(4000);
  const large = time(16000);
  assert.ok(large / small < 9, `4,000 turns ${Math.round(small)} ms, 16,000 turns ${Math.round(large)} ms: ratio ${(large / small).toFixed(1)}`);
});

/**
 * LR2b (LD252): a raw log is read a line at a time. A log over V8's longest string (about 512 MB; a 1,000,000-mark
 * log measured 586 MB) could not be read whole, so it could not be verified, replayed or reopened after a restart.
 * Here any Buffer made into a string longer than 1 MB throws, and a log of about 2 MB must still verify, replay and
 * reopen. Hand-built marks, sealed into a valid chain in a throwaway folder.
 */
it('LR2b (LD252): a raw log is checked a line at a time, never made into one string: a 2 MB log verifies, replays and reopens while no string over 1 MB can be made from a Buffer', () => {
  const fs = require('fs');
  const path = require('path');
  const { tmpDir, rmrf } = require('./helpers');
  const { makeLog } = require('./helpers-opon');
  const { seal } = require('../src/verify/chain');
  const { canonicalize } = require('../src/verify/canonical');
  const { verifySession, checkLog } = require('../src/verify/session');
  const { replayFolder } = require('../src/opon/replay');
  const { openSessionLog } = require('../src/opon/ledger/session-log');
  const base = tmpDir();
  const toString = Buffer.prototype.toString;
  try {
    const log = makeLog(base);
    const file = path.join(log.dir, 'raw.jsonl');
    let last = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
    const lines = [];
    for (const m of marks(1200)) {
      last = seal({ ...m, seq: last.seq + 1 }, last.hash);
      lines.push(canonicalize(last));
    }
    fs.appendFileSync(file, lines.join('\n') + '\n');
    assert.ok(fs.statSync(file).size > 2 * 1024 * 1024, `the log is ${fs.statSync(file).size} bytes`);
    const want = replayFolder(log.dir).odu; // made before the guard
    Buffer.prototype.toString = function guarded(enc, start, end) {
      const s = start === undefined ? 0 : start;
      const e = end === undefined ? this.length : end;
      if (e - s > 1024 * 1024) throw new Error(`a string of ${e - s} bytes was made from a Buffer`);
      return toString.call(this, enc, start, end);
    };
    const v = verifySession(log.dir);
    assert.ok(v.ok, v.words);
    assert.strictEqual(v.counts.marks, lines.length);
    assert.strictEqual(checkLog(log.dir, 'raw').records.length, lines.length + 1);
    assert.strictEqual(replayFolder(log.dir).odu, want);
    assert.strictEqual(openSessionLog(log.dir).last().seq, last.seq, 'reopened where it stopped');
  } finally {
    Buffer.prototype.toString = toString;
    rmrf(base);
  }
});

it('LR2c (LD253): the baseline snapshot allocates its read buffer once, not once per file (a 1 MiB buffer zero-filled for each of 100,000 files was half its time), and fingerprints every file as before', () => {
  const fs = require('fs');
  const path = require('path');
  const { tmpDir, rmrf } = require('./helpers');
  const { snapshot } = require('../src/opon/net/baseline');
  const base = tmpDir();
  const alloc = Buffer.alloc;
  try {
    for (let i = 0; i < 50; i++) {
      fs.mkdirSync(path.join(base, 'src', `d${i % 5}`), { recursive: true });
      fs.writeFileSync(path.join(base, 'src', `d${i % 5}`, `f${i}.ts`), `export const v${i} = ${i};\n`.repeat(i)); // made up
    }
    const want = snapshot(base, { exclusions: [], key: Buffer.alloc(32, 7), chunkBytes: 64 });
    let big = 0;
    Buffer.alloc = function counted(n, ...rest) {
      if (n >= 64) big++;
      return alloc.call(Buffer, n, ...rest);
    };
    const got = snapshot(base, { exclusions: [], key: Buffer.alloc(32, 7), chunkBytes: 64 });
    Buffer.alloc = alloc;
    assert.ok(big <= 1, `${big} read buffers for 50 files`);
    assert.deepStrictEqual([got.text, got.fingerprint, got.files], [want.text, want.fingerprint, 50], 'the same snapshot, every file fingerprinted, files over one chunk included');
  } finally {
    Buffer.alloc = alloc;
    rmrf(base);
  }
});

/**
 * F15 and the one-string odù log (LD287): with any string over 1 MB made from a Buffer, or from a whole file read as
 * text, throwing, `orunmila json`'s generated_at (the raw log's latest observed_at) is still read, and the live Ọpọ́n
 * still resumes a session after a restart: its odù log written whole when none is on disk, and completed when a crash
 * cut it mid-line. Hand-built marks sealed into a valid chain in a throwaway home.
 */
function noLongStrings(fn) {
  const fs = require('fs');
  const toString = Buffer.prototype.toString;
  const readFileSync = fs.readFileSync;
  Buffer.prototype.toString = function guarded(enc, start, end) {
    const s = start === undefined ? 0 : start;
    const e = end === undefined ? this.length : end;
    if (e - s > 1024 * 1024) throw new Error(`a string of ${e - s} bytes was made from a Buffer`);
    return toString.call(this, enc, start, end);
  };
  fs.readFileSync = function guardedRead(file, opts) {
    const enc = typeof opts === 'string' ? opts : opts && opts.encoding;
    if (enc && typeof file === 'string' && fs.statSync(file).size > 1024 * 1024) throw new Error(`${file} was read whole as one string`);
    return readFileSync.call(fs, file, opts);
  };
  try {
    return fn();
  } finally {
    Buffer.prototype.toString = toString;
    fs.readFileSync = readFileSync;
  }
}

function bigSession(home, T) {
  const fs = require('fs');
  const path = require('path');
  const { makeLog } = require('./helpers-opon');
  const { seal } = require('../src/verify/chain');
  const { canonicalize } = require('../src/verify/canonical');
  const log = makeLog(path.join(home, 'sessions'));
  const file = path.join(log.dir, 'raw.jsonl');
  let last = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
  const lines = [];
  for (const m of marks(T)) {
    const { seq, ...rest } = m;
    void seq;
    last = seal({ ...rest, seq: last.seq + 1 }, last.hash);
    lines.push(canonicalize(last));
  }
  fs.appendFileSync(file, lines.join('\n') + '\n');
  return { dir: log.dir, last };
}

it("F15 (LD287): orunmila json's generated_at, the raw log's latest observed_at, is read a line at a time", () => {
  const { tmpDir, rmrf } = require('./helpers');
  const fs = require('fs');
  const path = require('path');
  const { latestObservedAt } = require('../src/verify/session');
  const home = tmpDir();
  try {
    const { dir, last } = bigSession(home, 300);
    assert.ok(fs.statSync(path.join(dir, 'raw.jsonl')).size > 1024 * 1024);
    assert.strictEqual(noLongStrings(() => latestObservedAt(dir)), last.observed_at);
  } finally {
    rmrf(home);
  }
});

it('the one-string odù log (LD287): after a restart the live Ọpọ́n resumes a long session with no string of its odù log: written whole when none is on disk, completed when a crash cut it mid-line', () => {
  const { tmpDir, rmrf } = require('./helpers');
  const fs = require('fs');
  const path = require('path');
  const { replayFolder } = require('../src/opon/replay');
  const { createRouter } = require('../src/opon/intake/router');
  for (const cut of [false, true]) {
    const home = tmpDir();
    try {
      const { dir } = bigSession(home, 900);
      const want = replayFolder(dir).odu;
      assert.ok(Buffer.byteLength(want) > 2.2 * 1024 * 1024, `the odù log is ${Buffer.byteLength(want)} bytes, so its cut half is over the 1 MB guard`);
      const oduFile = path.join(dir, 'odu.jsonl');
      if (cut) fs.writeFileSync(oduFile, want.slice(0, Math.floor(want.length / 2))); // a crash mid-line
      fs.mkdirSync(path.join(home, 'intake'), { recursive: true });
      fs.writeFileSync(path.join(home, 'intake', 'held.json'), JSON.stringify(['ses_replay_test']));
      let mono = 10n ** 15n;
      const clock = () => ({ mono: mono.toString(), wall: '2026-11-24T12:00:00.000Z' });
      const router = createRouter({ home, clock, checkSender: () => true, codeRoot: path.join(__dirname, '..', 'src'), orunmilaVersion: '0.0.0-test', installKey: Buffer.alloc(32, 7), hookSettingsFor: () => [], baseline: true });
      noLongStrings(() => router.resume());
      mono += 1n;
      const got = fs.readFileSync(oduFile);
      assert.ok(got.subarray(0, Buffer.byteLength(want)).equals(Buffer.from(want)), `${cut ? 'completed' : 'written'}: the start of replay's, byte for byte`);
      router.stop('over');
    } finally {
      rmrf(home);
    }
  }
});

runAll('scale');
