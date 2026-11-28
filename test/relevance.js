// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/relevance.js — R50 (Phase 7, test 50's odù, conflict and verdict half): scripts/relevance.js compares a stripped
 * fixture with its raw recording by the odù records, conflicts and verdicts each gives. The events below are hand-built
 * in today's shapes with made-up values; no recorded data. The run on O's machine is recorded in the ledger.
 */

const { assert, fs, os, path, it, runAll } = require('./helpers');
const { stripEvents } = require('../src/opon/fixtures/strip');
const { outcomes, compare } = require('../scripts/relevance');

const H = (c) => c.repeat(64);
const ev = (s, over) => ({ ts: `2026-11-16T09:00:${String(s).padStart(2, '0')}.000Z`, session_id: 'sess-made-up', turn_id: 't1', agent: 'claude-code', ...over });
const hook = (s, call, over) => ev(s, { source: 'hook', failed: false, call_id: call, ...over });
const RAW = [
  ev(0, { type: 'user_prompt', text: 'fix the rate in the made-up module' }),
  hook(1, 'c1', { type: 'file_read', path: '/home/u/proj/src/rate.ts', hash: H('a'), bytes: 40, read_kind: 'full' }),
  hook(2, 'c2', { type: 'file_write', path: '/home/u/proj/src/rate.ts', diff: '--- a\n+++ b\n@@ -1 +1 @@\n-const rate = 1;\n+const rate = 2;\n' }),
  ev(3, { session_id: null, turn_id: null, agent: 'fs-sentinel', source: 'fs-sentinel', type: 'file_write', path: '/home/u/proj/src/rate.ts', rel_path: 'src/rate.ts', change_kind: 'modify', hash_before: H('b'), hash_after: H('c'), binary: false, diff: '-const rate = 1;\n+const rate = 2;\n', failed: false }),
  hook(4, 'c3', { type: 'command_run', command: 'npm test', exit_code: null, stdout_excerpt: 'ok', output_path: null }),
  ev(5, { session_id: null, turn_id: null, agent: 'fs-sentinel', source: 'fs-sentinel', type: 'file_write', path: '/home/u/proj/notes.txt', rel_path: 'notes.txt', change_kind: 'create', hash_before: null, hash_after: H('d'), binary: false, diff: '+a note\n', failed: false }),
  ev(6, { type: 'turn_claim', text: 'Done, and the tests pass.' }),
  ev(6, { type: 'turn_end' }),
];

function withScratch(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orunmila-rel-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

it('R50 test 50: a stripped fixture gives the same odù records, conflicts and verdicts as its raw events', () => {
  withScratch((dir) => {
    const a = outcomes(RAW, 'relevance-check', dir);
    const b = outcomes(stripEvents(RAW).events, 'relevance-check', dir);
    assert.ok(!a.error && !b.error, `${a.error} ${b.error}`);
    assert.ok(a.odu.length > 0 && a.verdicts.length > 0 && a.session.length === 1, JSON.stringify(a));
    assert.deepStrictEqual(compare(a, b), []);
  });
});

it('R50: a planted difference is caught: a dropped Sentinel row, and a changed exit status', () => {
  withScratch((dir) => {
    const a = outcomes(RAW, 'relevance-check', dir);
    const stripped = stripEvents(RAW).events;
    const noDisk = stripped.filter((e, i) => i !== 5);
    assert.notDeepStrictEqual(compare(a, outcomes(noDisk, 'relevance-check', dir)), [], 'a Sentinel row dropped');
    const failed = stripped.map((e, i) => (i === 4 ? { ...e, failed: true, exit_code: 1 } : e));
    assert.notDeepStrictEqual(compare(a, outcomes(failed, 'relevance-check', dir)), [], 'an exit status changed');
  });
});

// F29 (LD375), a stated limit held here so it cannot go unnoticed: the stripper masks a claim's text, so a claim that
// names the file it changed no longer names it once stripped, and the change reads as one the agent never mentioned.
// The one real fixture (c5426624) holds relevance; a fixture whose claims name their files may not.
it('R50 (F29, a stated limit): a claim naming its changed file, once stripped, reads as a silent change', () => {
  withScratch((dir) => {
    const named = RAW.map((e) => (e.type === 'turn_claim' ? { ...e, text: 'Updated src/rate.ts and the tests pass.' } : e));
    const diff = compare(outcomes(named, 'relevance-check', dir), outcomes(stripEvents(named).events, 'relevance-check', dir));
    assert.ok(diff.some((d) => d.startsWith('conflicts:')), JSON.stringify(diff));
  });
});

runAll('relevance');
