// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/acceptance.js — R3 (Phase 7; brief v4 lines 740, 763; LD364): the acceptance map covers every one of the
 * brief's tests, names only suites that exist and run, and judges as the brief says: a test is done only when it
 * passes, is done by real use, or is deferred with O's written approval; a missing case, a failing case or a part not
 * shown is not done. The two-run comparison itself is scripts/acceptance.js's own run, attached to the release report.
 */

const { assert, fs, path, ROOT, it, runAll } = require('./helpers');
const { MAP, IDS, parse, judge, suitesOf, DONE } = require('../scripts/acceptance');

it("R3: the map has exactly the brief's tests, 1 to 85 and 4b, each of a known kind", () => {
  assert.strictEqual(IDS.length, 86);
  assert.deepStrictEqual(Object.keys(MAP).sort(), [...IDS].sort());
  for (const id of IDS) assert.ok(['auto', 'manual', 'deferred', 'open'].includes(MAP[id].kind), id);
  for (const id of IDS.filter((i) => MAP[i].kind === 'deferred')) assert.ok(/^LD[0-9]+: O,/.test(MAP[id].approval), `${id} names O's written approval`);
});

it('R3: every suite the map names is a test file that npm test runs', () => {
  const all = fs.readFileSync(path.join(ROOT, 'test', 'all.js'), 'utf8');
  for (const s of suitesOf(MAP)) {
    assert.ok(fs.existsSync(path.join(ROOT, 'test', `${s}.js`)), s);
    assert.ok(all.includes(`'${s}.js'`), `${s} is in test/all.js`);
  }
});

it('R3: a passing case passes; a failing case, a prefix that matches nothing, a part not shown, an open test and a test not run are not done', () => {
  const out = { s: parse('\x1b[32mPASS\x1b[0m  alpha one\nPASS  alpha two\nFAIL  beta one\n') };
  const map = { ...MAP };
  for (const id of IDS) map[id] = { kind: 'deferred', approval: 'LD1: O, test' };
  map['1'] = { kind: 'auto', cases: [['s', 'alpha']] };
  map['2'] = { kind: 'auto', cases: [['s', 'beta']] };
  map['3'] = { kind: 'auto', cases: [['s', 'gamma']] };
  map['4'] = { kind: 'auto', cases: [['s', 'alpha one']], unshown: 'the rest' };
  map['5'] = { kind: 'open', why: "O's" };
  map['6'] = { kind: 'manual', record: 'not yet run' };
  map['7'] = { kind: 'manual', record: 'done: once' };
  const rows = Object.fromEntries(judge(map, out).map((r) => [r.id, r]));
  assert.deepStrictEqual([rows['1'].status, rows['1'].detail], ['passes', '2 cases']);
  assert.strictEqual(rows['2'].status, 'FAIL');
  assert.ok(rows['3'].status === 'FAIL' && rows['3'].detail.includes('no case of s starts "gamma"'));
  assert.strictEqual(rows['4'].status, 'passes, part not shown');
  assert.deepStrictEqual(['open', 'not run (real use)', 'done (real use)'], [rows['5'].status, rows['6'].status, rows['7'].status]);
  assert.deepStrictEqual(['1', '7', '9'].map((i) => DONE.has(rows[i].status)), [true, true, true]);
  assert.deepStrictEqual(['2', '3', '4', '5', '6'].map((i) => DONE.has(rows[i].status)), [false, false, false, false, false]);
});

runAll('acceptance');
