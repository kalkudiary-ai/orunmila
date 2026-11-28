// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/compat-shapes.js — EU1 (Phase 7; brief v4 lines 745-748, test 47): every command an existing user may script
 * against keeps its output shape for this release. The fixture is one real session from O's machine (session
 * `c5426624`, Orunmila's own build work), stripped by src/opon/fixtures/strip.js (its leak check clean, its relevance
 * check holding: 198 marks, the same kinds); `shapes-0.2.4.json` is what the published 0.2.4 printed on that fixture,
 * key paths and types only. Every pair 0.2.4 printed must still be printed (fields may be added, never removed or
 * given another type), with the same exit code.
 *
 * Stated limit: the stripper masks all claim text, so `laws --check --json` finds nothing on a stripped fixture and
 * its findings' shape is held here only at its top level; its whole shape was checked on three real sessions on O's
 * machine (review/done-ledger.md, session 982aff85: 44 pairs, 0 lost).
 */

const { assert, fs, path, ROOT, tmpDir, rmrf, it, runAll } = require('./helpers');
const { shapes, missing } = require('../scripts/compat-shapes');

const FIX = path.join(__dirname, 'cases', 'compat', '0.2.4');
const BIN = path.join(ROOT, 'bin', 'orunmila.js');

it('EU1 test 47: on a stripped real session, this build prints every key path and type the published 0.2.4 printed, with the same exit code, for every scripted command', () => {
  const old = JSON.parse(fs.readFileSync(path.join(FIX, 'shapes-0.2.4.json'), 'utf8'));
  const home = tmpDir();
  try {
    fs.copyFileSync(path.join(FIX, 'events.jsonl'), path.join(home, 'events.jsonl'));
    const now = shapes(BIN, ['id1'], { ORUNMILA_HOME: home });
    assert.deepStrictEqual(Object.keys(now).sort(), Object.keys(old).sort());
    for (const k of Object.keys(old)) {
      assert.deepStrictEqual(now[k].status, old[k].status, `${k}: exit codes`);
      assert.deepStrictEqual(missing(old[k].shape, now[k].shape), [], `${k}: pairs 0.2.4 printed and this build does not`);
    }
    assert.ok(old['trail --json'].shape.length >= 90, 'the fixture exercises the trail');
  } finally {
    rmrf(home);
  }
});

it('EU1: the comparison sees a lost field and a changed type, and a null where a value was is data, not shape', () => {
  const old = ['.:object', 'a:string', 'b:number', 'c:null', 'd:array', 'd[]:string'];
  assert.deepStrictEqual(missing(old, ['.:object', 'a:string', 'c:null', 'd:array', 'd[]:string']), ['b:number']);
  assert.deepStrictEqual(missing(old, ['.:object', 'a:number', 'b:number', 'c:null', 'd:array', 'd[]:string']), ['a:string']);
  assert.deepStrictEqual(missing(old, ['.:object', 'a:string', 'b:number', 'c:string', 'd:array', 'd[]:string', 'e:boolean']), []);
});

runAll('compat-shapes');
