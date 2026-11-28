// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/test-counts.js — CF2 (LD385): a test runner's own pass, fail and skip counts, read from its output. The node:test
 * outputs are this machine's Node 24 run of a five-test file (2 pass, 1 fail, 1 skip, 1 todo) under both reporters; the
 * others follow each runner's documented summary line (jest, vitest, mocha, pytest, go, cargo: none installed here).
 */

const { assert, it, runAll } = require('./helpers');
const { testCounts } = require('../src/capture/test-counts');

const NODE_SPEC = 'ℹ tests 5\nℹ suites 0\nℹ pass 2\nℹ fail 1\nℹ cancelled 0\nℹ skipped 1\nℹ todo 1\nℹ duration_ms 73.326458\n';
const NODE_TAP = '1..5\n# tests 5\n# suites 0\n# pass 2\n# fail 1\n# cancelled 0\n# skipped 1\n# todo 1\n# duration_ms 61.039708\n';

it('CF2 (LD385): each runner\'s own summary gives its pass, fail and skip counts', () => {
  const cases = [
    ['node --test', NODE_SPEC, { format: 'node:test', unit: 'tests', passed: 2, failed: 1, skipped: 2, summaries: 1 }],
    ['npm test', NODE_TAP, { format: 'node:test', unit: 'tests', passed: 2, failed: 1, skipped: 2, summaries: 1 }],
    ['npx jest', 'Test Suites: 1 failed, 2 passed, 3 total\nTests:       1 failed, 1 skipped, 1 todo, 3 passed, 6 total\nSnapshots:   0 total\n', { format: 'jest', unit: 'tests', passed: 3, failed: 1, skipped: 2, summaries: 1 }],
    ['npx vitest run', ' Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 3 passed | 1 skipped (5)\n', { format: 'vitest', unit: 'tests', passed: 3, failed: 1, skipped: 1, summaries: 1 }],
    ['npx mocha', '  3 passing (8ms)\n  1 pending\n  1 failing\n', { format: 'mocha', unit: 'tests', passed: 3, failed: 1, skipped: 1, summaries: 1 }],
    ['pytest', '===== 1 failed, 2 passed, 1 skipped, 1 xfailed, 1 error in 0.10s =====\n', { format: 'pytest', unit: 'tests', passed: 2, failed: 2, skipped: 2, summaries: 1 }],
    ['python -m pytest -q', '3 passed, 1 skipped in 0.05s\n', { format: 'pytest', unit: 'tests', passed: 3, failed: 0, skipped: 1, summaries: 1 }],
    ['cargo test', 'test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out\n', { format: 'cargo', unit: 'tests', passed: 4, failed: 1, skipped: 1, summaries: 2 }],
    ['go test -v ./...', '=== RUN   TestA\n--- PASS: TestA (0.00s)\n--- SKIP: TestB (0.00s)\n    --- FAIL: TestC/sub (0.00s)\n--- FAIL: TestC (0.00s)\nFAIL\n', { format: 'go', unit: 'tests', passed: 1, failed: 2, skipped: 1, summaries: 1 }],
    ['go test ./...', 'ok  \texample.com/m\t0.002s\nFAIL\texample.com/n\t0.003s\n?   \texample.com/x\t[no test files]\nFAIL\n', { format: 'go', unit: 'packages', passed: 1, failed: 1, skipped: 1, summaries: 1 }],
  ];
  for (const [command, output, want] of cases) assert.deepStrictEqual(testCounts(command, output), [want], command);
});

it('CF2: two runs of node:test in one output are summed; two runners give one entry each', () => {
  assert.deepStrictEqual(testCounts('npm test', NODE_SPEC + 'more\n' + NODE_SPEC), [{ format: 'node:test', unit: 'tests', passed: 4, failed: 2, skipped: 4, summaries: 2 }]);
  const both = testCounts('npm test && pytest', NODE_TAP + '2 passed in 0.01s\n');
  assert.deepStrictEqual(both.map((e) => e.format), ['node:test', 'pytest']);
});

it('CF2: colour codes are read through; no summary, or a command that is not a test run, gives none', () => {
  assert.deepStrictEqual(testCounts('npx jest', '\x1b[1mTests:\x1b[22m       \x1b[32m4 passed\x1b[39m, 4 total\n'), [{ format: 'jest', unit: 'tests', passed: 4, failed: 0, skipped: 0, summaries: 1 }]);
  assert.deepStrictEqual(testCounts('npm test', 'all good\n'), []);
  assert.deepStrictEqual(testCounts('cat ci.log', NODE_TAP), [], 'a log shown by cat is not a run');
  assert.deepStrictEqual(testCounts('npm test', ''), []);
  assert.deepStrictEqual(testCounts('npm test', null), []);
});

runAll('test-counts');
