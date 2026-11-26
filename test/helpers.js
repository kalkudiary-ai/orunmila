// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/helpers.js
 *
 * Dependency-free shared harness for the orunmila test suite. Same spirit as
 * the original test/run.js: no jest, no mocha, just assert + a tiny runner so
 * `npm install` stays empty. Provides:
 *   - a describe/it style collector with PASS/FAIL output and an exit code
 *   - tmpHome(): an isolated ORUNMILA_HOME so eventlog/turnstate/reports never
 *     touch the developer's real ~/.orunmila
 *   - tmpDir(): a throwaway directory for sentinel/walker/file tests
 *   - run(): execute a hook/CLI script as a child process with stdin + env,
 *     so subprocess coverage is captured by c8 (NODE_V8_COVERAGE propagates).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function freshTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** An isolated ORUNMILA_HOME for one test; sets the env var and returns the dir. */
function tmpHome() {
  const dir = freshTmp('orunmila-home-');
  process.env.ORUNMILA_HOME = dir;
  return dir;
}

/** A throwaway working directory (for sentinel/walker/file-grid tests). */
function tmpDir() {
  return freshTmp('orunmila-work-');
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Run one of the project's node scripts as a child process. stdin is the JSON
 * payload string (hooks read stdin); env overrides are merged. Returns
 * { status, stdout, stderr }. Never throws on non-zero exit — the caller
 * asserts on status explicitly.
 */
function run(relScript, { input = '', env = {}, args = [], cwd } = {}) {
  const script = path.join(ROOT, relScript);
  try {
    const stdout = execFileSync('node', [script, ...args], {
      input,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    };
  }
}

/**
 * Run a long-running script (watch / watch-fs) for a bounded time, then kill it.
 * These commands never exit on their own (setInterval + SIGINT), so we let them
 * run `ms` milliseconds — long enough to print their startup banner and do at
 * least one tick — then SIGTERM them and return whatever they printed. Coverage
 * of the child is still captured (NODE_V8_COVERAGE flushes on the signal handler
 * path the command installs). Synchronous so it fits the sync `it()` collector.
 */
function runUntil(relScript, { env = {}, args = [], cwd, ms = 1200 } = {}) {
  const script = path.join(ROOT, relScript);
  const res = spawnSync('node', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: cwd || process.cwd(),
    timeout: ms,
    killSignal: 'SIGINT', // hit the command's own SIGINT shutdown path
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', signal: res.signal };
}

/** A path with `/` separators, as Orunmila records every path (paths.js, overlap.js): the same string on every OS. */
const slash = (p) => String(p).split(path.sep).join('/');

// --- what cannot be checked on this OS (W3d) ---------------------------------
// Windows has no POSIX file modes, no SIGTERM a process can handle, and no Unix socket files. A check that depends
// on one of those is skipped there, never passed: notOnWindows(what) records it and returns true, and runAll prints
// every skipped check by name, so the count of what did not run is in the output (as secure.js has done since 0.2.2).
const WINDOWS = process.platform === 'win32';
const skipped = [];
function notOnWindows(what) {
  if (!WINDOWS) return false;
  skipped.push(what);
  return true;
}

/**
 * W3g (LD342): a suite of a developer tool of the build machine (scripts/, which ships to no user: package.json
 * `files`), built on POSIX (process groups, setsid, sandbox-exec, launchd, git hooks). On Windows it does not run,
 * and says so with its suite header and why; on macOS and Linux this returns and the suite runs whole.
 */
function buildMachineOnly(suite, what) {
  if (!WINDOWS) return;
  console.log(`\n# ${suite}\n      (not run on Windows: ${what} is a developer tool of the build machine, POSIX by design, and ships to no user: LD342)\n\n0 passed, 0 failed`);
  process.exit(0);
}

// --- tiny test collector ----------------------------------------------------

const tests = [];
function it(name, fn) {
  tests.push({ name, fn });
}

/** Tests may be sync or return a Promise (for real fs.watch / timer paths). */
async function runAll(suiteName) {
  let pass = 0;
  let fail = 0;
  if (suiteName) console.log(`\n# ${suiteName}`);
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`\x1b[32mPASS\x1b[0m  ${t.name}`);
      pass++;
    } catch (err) {
      console.log(`\x1b[31mFAIL\x1b[0m  ${t.name}`);
      console.log(`      ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n      ') : err}`);
      fail++;
    }
  }
  if (skipped.length) {
    console.log(`      (not run on Windows, ${skipped.length} checks:`);
    for (const s of skipped) console.log(`        - ${s}`);
    console.log('      )');
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/** Promise that resolves after `ms` — lets async tests await real fs events. */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait until a watcher on `dir` is really delivering events, before a test's
 * real write (NF65, P2-6). fs.watch can return before the OS delivers events:
 * on macOS a write made at once was measured lost, never late, so no deadline
 * brings it back. Writes probe files into `dir`, a new name every `everyMs`
 * (one name would keep resetting the Sentinel's per-path debounce), until
 * `isSeen(probePath)` holds for one of them. Returns true when seen, false at
 * `deadlineMs`; the caller asserts it, so a dead watcher fails its own test.
 */
async function awaitWatching(dir, isSeen, { everyMs = 250, deadlineMs = 5000 } = {}) {
  const end = Date.now() + deadlineMs;
  const probes = [];
  const seenOne = () => probes.some((p) => isSeen(p));
  while (Date.now() < end) {
    const probe = path.join(dir, `.watch-probe-${probes.length}`);
    probes.push(probe);
    fs.writeFileSync(probe, String(probes.length));
    const next = Math.min(end, Date.now() + everyMs);
    while (Date.now() < next) {
      if (seenOne()) return true;
      await sleep(5);
    }
  }
  return seenOne();
}

/**
 * W3e: wait until the intake of `home` answers its status on its own address (intakePaths: the socket file, or on
 * Windows a named pipe, which has no file to wait for). True when it answers, false at `deadlineMs`.
 */
async function intakeAnswers(home, deadlineMs = 8000) {
  const { intakePaths, statusOf } = require('../src/opon/intake/server');
  const sock = intakePaths(home).sock;
  for (const end = Date.now() + deadlineMs; Date.now() < end; await sleep(50)) if (await statusOf(sock, 300)) return true;
  return Boolean(await statusOf(sock, 300));
}

module.exports = { assert, fs, os, path, ROOT, tmpHome, tmpDir, rmrf, run, runUntil, sleep, awaitWatching, it, runAll, slash, WINDOWS, notOnWindows, intakeAnswers, buildMachineOnly };
