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
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/** Promise that resolves after `ms` — lets async tests await real fs events. */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { assert, fs, os, path, ROOT, tmpHome, tmpDir, rmrf, run, runUntil, sleep, it, runAll };
