// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/babalawo/weakened.js — R27, tests weakened (MR2, LD317; O's approval of R2 in research/market-landscape.md,
 * LD315). The brief's own example of the lie detector is "tests pass" while the test file was deleted (line 176). This
 * finds the agent's own change to a test file that makes the suite easier to pass:
 *
 *   deleted    the test file was deleted
 *   skips      the change adds more skip, only or todo markers than it removes (`it.skip`, `xit`, `@pytest.mark.skip`,
 *              `t.Skip(`, `#[ignore]`, `@Disabled`, ...)
 *   asserts    the change removes more assertion lines than it adds (`expect(`, `assert`, `t.Error`, `XCTAssert`, ...)
 *
 * A test file is what the facts line calls one (src/laws/facts.js isTestFile), so the two never disagree. Fixed word
 * lists on the diff's added and removed lines: plain code, no model, no file system (guarantee 8, line 656). The caller
 * reads the diffs kept beside the log (line 267; src/opon/ledger/beside.js) and checks each against its fingerprint; a
 * missing or changed one is lost evidence, never an empty diff (open question 4).
 *
 * Not found (stated limits): a test path removed from a runner's config, a snapshot rewritten, an assertion weakened
 * inside one line (`toBe(3)` to `toBeDefined()`), a skip added through a variable, a test file outside the project, a
 * test file by a name the facts line does not know (`FooTest.java`).
 *
 *   isTestPath(p)              -> boolean
 *   weakening(odu, diffTexts)  -> null | { deleted, skips_added, asserts_removed, asserts_added }
 */

const { isTestFile } = require('../laws/facts');

const isTestPath = (p) => typeof p === 'string' && isTestFile(p);

const SKIP = /\b(?:it|test|describe|context|suite)\.(?:skip|only|todo)\b|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|@unittest\.skip|\bpytest\.skip\s*\(|\bt\.Skip(?:f|Now)?\s*\(|#\[ignore\]|@(?:Disabled|Ignore)\b/;
const ASSERT = /\bexpect\s*\(|\bassert(?:_eq|_ne)?!?\b|\bassert\w*\s*\(|\.should\b|\bshould\.|\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail)\s*\(|\bXCTAssert\w*\s*\(|\bAssert\.\w+\s*\(|\bself\.assert\w*\s*\(/;

/** Added and removed lines of a unified diff: `+`/`-` lines, not its `+++`/`---` file lines. */
function changedLines(text) {
  const added = [];
  const removed = [];
  for (const l of String(text).split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) added.push(l.slice(1));
    else if (l.startsWith('-')) removed.push(l.slice(1));
  }
  return { added, removed };
}
const count = (lines, re) => lines.filter((l) => re.test(l)).length;

/** Whether this sealed odù is the agent's own change to a test file inside the project. */
function candidate(o) {
  const t = o.target;
  if (!t || t.kind !== 'file' || t.outside || !isTestPath(t.path)) return false;
  if (!['modified', 'deleted', 'renamed'].includes(o.action)) return false;
  if (o.net_change && o.net_change.changed === false) return false;
  return o.attribution === 'explained';
}

function weakening(o, diffTexts = []) {
  if (!candidate(o)) return null;
  if (o.action === 'deleted') return { deleted: true, skips_added: 0, asserts_removed: 0, asserts_added: 0 };
  let skips = 0;
  let removed = 0;
  let added = 0;
  for (const text of diffTexts) {
    const c = changedLines(text);
    skips += count(c.added, SKIP) - count(c.removed, SKIP);
    removed += count(c.removed, ASSERT);
    added += count(c.added, ASSERT);
  }
  if (skips > 0 || removed > added) return { deleted: false, skips_added: Math.max(0, skips), asserts_removed: removed, asserts_added: added };
  return null;
}

module.exports = { isTestPath, weakening, changedLines };
