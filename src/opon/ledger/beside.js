// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/opon/ledger/beside.js — the diffs kept beside the log, read for a reader that needs the changed lines (brief v4
 * line 267; MR2, LD317: the judge's R27). Each diff is read from `files/<hex>` in the session folder and used only when
 * its bytes hash to the `diff_ref` its mark names; a missing or changed file is lost evidence and is left out, never
 * read as an empty diff (open question 4). Only the test files' changes are read (src/laws/facts.js isTestFile, the one
 * definition the facts line and R27 share), so a closeout reads a handful of files, not every diff of the session.
 *
 *   testDiffs({ odus, refOf, dir })        -> { [odu_id]: [diff text, ...] }   refOf(seq): a mark's diff_ref or null
 *   testDiffsFromMarks({ odus, marks, dir }) -> the same, each ref read from the raw log's marks
 *   oduRecords(text)                       -> the odù log's records
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isTestFile } = require('../../laws/facts');

const REF = /^sha256:([0-9a-f]{64})$/;

function testDiffs({ odus, refOf, dir }) {
  const out = {};
  for (const o of odus) {
    const t = o.target;
    if (o.record !== 'odu' || o.state !== 'sealed' || !t || t.kind !== 'file' || t.outside || typeof t.path !== 'string' || !isTestFile(t.path)) continue;
    if (!['modified', 'renamed'].includes(o.action)) continue;
    const texts = [];
    for (const seq of o.mark_seqs || []) {
      const m = REF.exec(String(refOf(seq) || ''));
      if (!m) continue;
      let bytes;
      try {
        bytes = fs.readFileSync(path.join(dir, 'files', m[1]));
      } catch {
        continue; // lost evidence: left out, never an empty diff
      }
      if (crypto.createHash('sha256').update(bytes).digest('hex') === m[1]) texts.push(bytes.toString('utf8'));
    }
    if (texts.length) out[o.odu_id] = texts;
  }
  return out;
}

function testDiffsFromMarks({ odus, marks, dir }) {
  const refs = new Map();
  for (const m of marks) if (m && m.detail && typeof m.detail.diff_ref === 'string') refs.set(m.seq, m.detail.diff_ref);
  return testDiffs({ odus, refOf: (s) => refs.get(s) || null, dir });
}

const oduRecords = (text) => String(text).split('\n').slice(0, -1).map((l) => JSON.parse(l));

module.exports = { testDiffs, testDiffsFromMarks, oduRecords };
