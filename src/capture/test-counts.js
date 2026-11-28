// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/capture/test-counts.js — CF2 (LD385): a test runner's own pass, fail and skip counts, read from the output of a
 * command that runs one (src/laws/facts.js's runners). The runner's testimony in its own words: a count is what the
 * runner printed, never proof of which tests exist. Plain code, no model; the same answer on every OS.
 *
 *   testCounts(command, output) -> [{ format, unit, passed, failed, skipped, summaries }]
 *     one entry per runner whose summary the output holds, in this order: node:test (its spec and TAP reporters), jest,
 *     vitest, mocha, pytest, cargo, go. A runner's summaries in one output are summed (`summaries` says how many).
 *     `skipped` is every test the runner neither passed nor failed: skipped, todo, pending, ignored, xfailed. pytest's
 *     errors count as failed, its xpassed as passed. go without -v names packages, not tests (`unit: 'packages'`; a
 *     package with no test files is skipped). Empty when the command runs no test runner or no summary is found.
 */

const { isTestRun } = require('../laws/facts');

// eslint-disable-next-line no-control-regex -- strips a runner's colour codes
const ANSI = /\x1b\[[0-9;]*m/g;

const n = (s) => Number(s);

/** Each format: read every line, return { passed, failed, skipped, summaries, unit } or null when none is there. */
const FORMATS = [
  {
    format: 'node:test',
    read(lines) {
      const keys = { pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0 };
      let summaries = 0;
      for (const l of lines) {
        const m = /^(?:ℹ|#)\s+(tests|pass|fail|skipped|todo|cancelled)\s+(\d+)\s*$/.exec(l);
        if (!m) continue;
        if (m[1] === 'tests') summaries++;
        else keys[m[1]] += n(m[2]);
      }
      return summaries ? { passed: keys.pass, failed: keys.fail + keys.cancelled, skipped: keys.skipped + keys.todo, summaries } : null;
    },
  },
  {
    format: 'jest',
    read(lines) {
      const t = { passed: 0, failed: 0, skipped: 0, summaries: 0 };
      for (const l of lines) {
        const m = /^\s*Tests:\s+(.*\d+\s+total)\s*$/.exec(l);
        if (!m) continue;
        t.summaries++;
        for (const [, c, w] of m[1].matchAll(/(\d+)\s+(passed|failed|skipped|todo)/g)) t[w === 'todo' ? 'skipped' : w] += n(c);
      }
      return t.summaries ? t : null;
    },
  },
  {
    format: 'vitest',
    read(lines) {
      const t = { passed: 0, failed: 0, skipped: 0, summaries: 0 };
      for (const l of lines) {
        const m = /^\s*Tests\s{2,}(.+?)\s+\(\d+\)\s*$/.exec(l);
        if (!m) continue;
        t.summaries++;
        for (const [, c, w] of m[1].matchAll(/(\d+)\s+(passed|failed|skipped|todo)/g)) t[w === 'todo' ? 'skipped' : w] += n(c);
      }
      return t.summaries ? t : null;
    },
  },
  {
    format: 'mocha',
    read(lines) {
      const t = { passed: 0, failed: 0, skipped: 0, summaries: 0 };
      for (const l of lines) {
        const m = /^\s*(\d+)\s+(passing|failing|pending)(?:\s+\(\d+(?:\.\d+)?m?s\))?\s*$/.exec(l);
        if (!m) continue;
        if (m[2] === 'passing') {
          t.summaries++;
          t.passed += n(m[1]);
        } else t[m[2] === 'failing' ? 'failed' : 'skipped'] += n(m[1]);
      }
      return t.summaries ? t : null;
    },
  },
  {
    format: 'pytest',
    read(lines) {
      const t = { passed: 0, failed: 0, skipped: 0, summaries: 0 };
      const MAP = { passed: 'passed', xpassed: 'passed', failed: 'failed', error: 'failed', errors: 'failed', skipped: 'skipped', xfailed: 'skipped' };
      for (const l of lines) {
        const m = /^=*\s*((?:\d+\s+(?:passed|failed|skipped|xfailed|xpassed|errors?|deselected|warnings?)(?:,\s*)?)+)\s+in\s+[\d.]+s\b.*?=*\s*$/.exec(l);
        if (!m) continue;
        t.summaries++;
        for (const [, c, w] of m[1].matchAll(/(\d+)\s+(passed|failed|skipped|xfailed|xpassed|errors?)/g)) t[MAP[w]] += n(c);
      }
      return t.summaries ? t : null;
    },
  },
  {
    format: 'cargo',
    read(lines) {
      const t = { passed: 0, failed: 0, skipped: 0, summaries: 0 };
      for (const l of lines) {
        const m = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/.exec(l);
        if (!m) continue;
        t.summaries++;
        t.passed += n(m[1]);
        t.failed += n(m[2]);
        t.skipped += n(m[3]);
      }
      return t.summaries ? t : null;
    },
  },
  {
    format: 'go',
    read(lines) {
      const tests = { passed: 0, failed: 0, skipped: 0 };
      const pkgs = { passed: 0, failed: 0, skipped: 0 };
      let seenTests = false;
      let seenPkgs = false;
      for (const l of lines) {
        const t = /^\s*--- (PASS|FAIL|SKIP): /.exec(l);
        if (t) {
          seenTests = true;
          tests[{ PASS: 'passed', FAIL: 'failed', SKIP: 'skipped' }[t[1]]]++;
          continue;
        }
        if (/^ok\s+\S+\s+(?:[\d.]+s|\(cached\))/.test(l)) (seenPkgs = true), pkgs.passed++;
        else if (/^FAIL\s+\S+\s+[\d.]+s/.test(l)) (seenPkgs = true), pkgs.failed++;
        else if (/^\?\s+\S+\s+\[no test files\]/.test(l)) (seenPkgs = true), pkgs.skipped++;
      }
      if (seenTests) return { ...tests, summaries: 1 };
      if (seenPkgs) return { ...pkgs, summaries: 1, unit: 'packages' };
      return null;
    },
  },
];

function testCounts(command, output) {
  if (typeof command !== 'string' || !isTestRun(command)) return [];
  const lines = String(output || '').replace(ANSI, '').split(/\r?\n/);
  const found = [];
  for (const f of FORMATS) {
    const r = f.read(lines);
    if (r) found.push({ format: f.format, unit: r.unit || 'tests', passed: r.passed, failed: r.failed, skipped: r.skipped, summaries: r.summaries });
  }
  return found;
}

module.exports = { testCounts };
