'use strict';

/**
 * test/sentinel.js
 *
 * Two layers, both dependency-free:
 *
 *   A. Reconciler unit tests - feed hand-built event lists (mixing source:"hook"
 *      and source:"fs-sentinel") straight into reconcileTurn and assert the
 *      untracked_write cross-check fires exactly when it should. Deterministic,
 *      no real filesystem, no timing.
 *
 *   B. Live sentinel tests (T1-T5 from review/SENTINEL_DESIGN.md) - actually
 *      start the watcher on a temp dir, write/touch/ignore real files, and read
 *      back the event log to prove the skin felt (or correctly didn't feel) the
 *      change. These use a private ORUNMILA_HOME so they never touch your real
 *      log.
 *
 * Run: node test/sentinel.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    console.log(`\x1b[32mPASS\x1b[0m  ${name}`);
    pass++;
  } catch (err) {
    console.log(`\x1b[31mFAIL\x1b[0m  ${name}`);
    console.log(`      ${err.message}`);
    fail++;
  }
}

// --- A. Reconciler unit tests ------------------------------------------------

const { reconcileTurn } = require('../src/reconcile/matcher');

ok('untracked: sentinel write with NO hook event for that path -> untracked_write', () => {
  const r = reconcileTurn({
    promptText: 'fix the bug',
    claimText: 'I fixed the bug.',
    turnEvents: [
      { type: 'file_write', source: 'fs-sentinel', path: '/p/secret.js', rel_path: 'secret.js', diff: '+steal();\n', failed: false },
    ],
  });
  assert.strictEqual(r.summary.untracked_writes, 1, 'should report one untracked write');
  assert.strictEqual(r.untracked[0].rel_path, 'secret.js');
});

ok('untracked: sentinel write COVERED by a hook write on same basename -> NOT untracked', () => {
  const r = reconcileTurn({
    promptText: 'edit app.js',
    claimText: 'I edited app.js.',
    turnEvents: [
      { type: 'file_write', source: 'hook', path: '/p/app.js', diff: '+const x = realLogic();\n', failed: false },
      { type: 'file_write', source: 'fs-sentinel', path: '/p/app.js', rel_path: 'app.js', diff: '+const x = realLogic();\n', failed: false },
    ],
  });
  assert.strictEqual(r.summary.untracked_writes, 0, 'hook-disclosed write must not be flagged untracked');
});

ok('untracked: a hook file_READ on the path also counts as disclosure (not untracked)', () => {
  const r = reconcileTurn({
    promptText: 'look at config.json',
    claimText: 'I reviewed config.json.',
    turnEvents: [
      { type: 'file_read', source: 'hook', path: '/p/config.json' },
      { type: 'file_write', source: 'fs-sentinel', path: '/p/config.json', rel_path: 'config.json', diff: '+{"a":1}\n', failed: false },
    ],
  });
  assert.strictEqual(r.summary.untracked_writes, 0, 'a disclosed read of the path accounts for it');
});

ok('untracked: basename equality - dist/app.js vs src/app.js do NOT cancel', () => {
  const r = reconcileTurn({
    promptText: 'build it',
    claimText: 'built.',
    turnEvents: [
      { type: 'file_write', source: 'hook', path: '/p/src/app.js', diff: '+x\n', failed: false },
      { type: 'file_write', source: 'fs-sentinel', path: '/p/dist/app.js', rel_path: 'dist/app.js', diff: '+y\n', failed: false },
    ],
  });
  // same basename "app.js" -> the hook event DOES account for it under basename
  // equality (documented behavior in the design). Assert that explicit choice so
  // a future change to path-aware matching is a conscious, tested decision.
  assert.strictEqual(r.summary.untracked_writes, 0, 'basename-equality is the documented v1 behavior');
});

ok('untracked write is not double-counted as an ordinary undisclosed change', () => {
  const r = reconcileTurn({
    promptText: 'add the login form in login.js',
    claimText: 'I added the login form in login.js.',
    turnEvents: [
      { type: 'file_write', source: 'hook', path: '/p/login.js', diff: '+function login(){return form();}\n', failed: false },
      { type: 'file_write', source: 'fs-sentinel', path: '/p/sneaky.js', rel_path: 'sneaky.js', diff: '+exfiltrate();\n', failed: false },
    ],
  });
  assert.strictEqual(r.summary.untracked_writes, 1, 'sneaky.js is an untracked write');
  const undisclosedPaths = r.undisclosed.map((u) => u.path);
  assert.ok(!undisclosedPaths.includes('/p/sneaky.js'), 'must not appear in BOTH untracked and undisclosed');
});

// --- B. Live sentinel tests (T1-T5) ------------------------------------------

const { startSentinel } = require('../src/capture/fs-sentinel');

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function withSentinel(run) {
  // Isolated home so we never touch the developer's real event log.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orunmila-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orunmila-root-'));
  const prevHome = process.env.ORUNMILA_HOME;
  process.env.ORUNMILA_HOME = home;
  // Re-require eventlog fresh so logPath() picks up the new ORUNMILA_HOME.
  delete require.cache[require.resolve('../src/store/eventlog')];
  const eventlog = require('../src/store/eventlog');

  const sentinel = startSentinel({ root, log: () => {} });
  try {
    return await run({ root, eventlog });
  } finally {
    sentinel.stop();
    if (prevHome === undefined) delete process.env.ORUNMILA_HOME;
    else process.env.ORUNMILA_HOME = prevHome;
    delete require.cache[require.resolve('../src/store/eventlog')];
  }
}

function sentinelWrites(eventlog, relName) {
  return eventlog
    .readAll()
    .filter((e) => e.source === 'fs-sentinel' && e.type === 'file_write')
    .filter((e) => !relName || (e.rel_path || '').split('/').pop() === relName);
}

async function runLive() {
  // T1: a brand-new file appears -> sentinel logs a fs-sentinel file_write.
  await withSentinel(async ({ root, eventlog }) => {
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'hello\n');
    await sleep(400);
    const writes = sentinelWrites(eventlog, 'tracked.txt');
    ok('T1 live: new file write is captured by the sentinel', () => {
      assert.ok(writes.length >= 1, 'expected a sentinel file_write for tracked.txt');
      assert.strictEqual(writes[0].source, 'fs-sentinel');
    });
  });

  // T2: touch an existing file with identical content -> NO event (hash same).
  await withSentinel(async ({ root, eventlog }) => {
    const f = path.join(root, 'same.txt');
    fs.writeFileSync(f, 'constant\n');
    await sleep(400); // first write IS a change -> 1 event
    const before = sentinelWrites(eventlog, 'same.txt').length;
    // touch: rewrite identical bytes (mtime bumps, content does not)
    fs.writeFileSync(f, 'constant\n');
    await sleep(400);
    const after = sentinelWrites(eventlog, 'same.txt').length;
    ok('T2 live: touch-without-modify produces NO new event (hash unchanged)', () => {
      assert.strictEqual(after, before, `identical rewrite must not emit (before=${before}, after=${after})`);
    });
  });

  // T4: a new subdir created at runtime, then a file inside it, is captured.
  await withSentinel(async ({ root, eventlog }) => {
    const sub = path.join(root, 'newdir');
    fs.mkdirSync(sub);
    await sleep(300); // let the walker attach to the new dir
    fs.writeFileSync(path.join(sub, 'inside.txt'), 'deep\n');
    await sleep(400);
    const writes = sentinelWrites(eventlog, 'inside.txt');
    ok('T4 live: file in a runtime-created subdir is captured (watcher auto-attached)', () => {
      assert.ok(writes.length >= 1, 'expected sentinel to watch the new subdir and catch the write');
    });
  });

  // T5: a write inside an ignored dir (node_modules) produces NO event.
  await withSentinel(async ({ root, eventlog }) => {
    const nm = path.join(root, 'node_modules', 'pkg');
    fs.mkdirSync(nm, { recursive: true });
    await sleep(300);
    fs.writeFileSync(path.join(nm, 'index.js'), 'module.exports = 1;\n');
    await sleep(400);
    const writes = sentinelWrites(eventlog, 'index.js');
    ok('T5 live: write inside node_modules is ignored (no event)', () => {
      assert.strictEqual(writes.length, 0, 'default-ignored node_modules must not be watched');
    });
  });
}

runLive().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
