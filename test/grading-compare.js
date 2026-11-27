// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/grading-compare.js — R56 (Phase 7, test 56's recorded-session half): scripts/grading-compare.js judges
 * `no-grep-as-basis` on a turn both ways, from today's events and from the intake's marks, and names why each result
 * differs: only open question 3's approved grading (NF26, NF69, a listing, a ranged read, a search's folder) is an
 * explained difference. Hand-built events and marks with made-up paths; the run on O's machine is in the ledger.
 */

const { assert, it, runAll } = require('./helpers');
const { compareTurn } = require('../scripts/grading-compare');

const CLAIM = 'grep shows src/x.js has no TODO markers left.';
const ev = (over) => ({ ts: '2026-11-16T09:00:00.000Z', session_id: 's', turn_id: 't1', agent: 'claude-code', source: 'hook', failed: false, ...over });
const mk = (says, target, detail, cause) => ({ source: 'hook', says, target, detail, turn: 't1', cause_hint: cause });
const grepEvent = ev({ call_id: 'g', type: 'file_read', path: 'TODO', read_kind: 'pattern', hash: null, bytes: null });
const grepMark = mk('read', { kind: 'dir', path: 'src' }, { tool: 'Grep', exit_status: 'pass', read_kind: 'pattern', pattern: 'TODO' }, 'g');

it('R56 test 56: a failed read is a full receipt in the event log and none in the marks (NF26): the difference is explained by the approved grading', () => {
  const events = [grepEvent, ev({ call_id: 'r', type: 'file_read', path: 'src/x.js', read_kind: 'full', failed: true, hash: null, bytes: null })];
  const marks = [grepMark, mk('started', { kind: 'file', path: 'src/x.js' }, { tool: 'Read' }, 'r'), mk('ended', { kind: 'file', path: 'src/x.js' }, { tool: 'Read', exit_status: 'fail' }, 'r')];
  const r = compareTurn({ claimText: CLAIM, events, marks });
  assert.strictEqual(r.same, false, JSON.stringify(r));
  assert.deepStrictEqual(r.reasons, ['NF26: a failed read is no receipt']);
  assert.strictEqual(r.explained, true);
});

it('R56: the same evidence both ways gives the same result; a difference the grading does not explain is named unexplained', () => {
  const read = ev({ call_id: 'r', type: 'file_read', path: 'src/x.js', read_kind: 'full', hash: 'a'.repeat(64), bytes: 3 });
  const readMark = mk('read', { kind: 'file', path: 'src/x.js' }, { tool: 'Read', exit_status: 'pass', read_kind: 'full', size: 3, fingerprint: 'sha256:' + 'a'.repeat(64) }, 'r');
  assert.strictEqual(compareTurn({ claimText: CLAIM, events: [grepEvent, read], marks: [grepMark, readMark] }).same, true);
  // The event log holds a whole read the marks lack: a capture difference, not a grading one, so unexplained.
  const r = compareTurn({ claimText: CLAIM, events: [grepEvent, read], marks: [grepMark] });
  assert.strictEqual(r.same, false, JSON.stringify(r));
  assert.strictEqual(r.explained, false, JSON.stringify(r));
  // A search alone: today's pattern text names no folder, the marks' search names src: explained by the grading.
  const s = compareTurn({ claimText: CLAIM, events: [grepEvent], marks: [grepMark] });
  assert.deepStrictEqual([s.same, s.explained, s.reasons], [false, true, ['open question 3: a search targets the folder it searched']]);
});

runAll('grading-compare');
