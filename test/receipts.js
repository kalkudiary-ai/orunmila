'use strict';

/**
 * test/receipts.js — src/opon/gate/receipts.js: how much a turn's Glove marks
 * show the agent saw of a file, as the law gate grades it (open question 3,
 * decided by O 2026-11-16: brief v4 line 276; review/phase1-design.md section
 * 3, tests 78-81; NF26, NF69; Phase 1 slice B9a, pure part; LD67). Not wired.
 * Marks are built here; no real data.
 */

const { assert, it, runAll } = require('./helpers');
const { receiptsOf, receiptFor } = require('../src/opon/gate/receipts');

let n = 0;
const glove = (says, target, detail) => ({ schema_version: 1, session_id: 's1', source: 'hook', agent: 'claude-code', turn: 't1', sub_agent: null, observed_at: '2026-01-01T00:00:00.000Z', mono_ns: String(++n), cause_hint: `toolu_${n}`, target, says, detail });
const file = (p) => ({ kind: 'file', path: p });
const dir = (p) => ({ kind: 'dir', path: p });
const read = (p, readKind) => glove('read', file(p), { tool: 'Read', exit_status: 'pass', read_kind: readKind });
const grade = (marks, p) => receiptFor(receiptsOf(marks), p);

it('test 78: a turn whose only read of a file failed has no receipt for it (NF26)', () => {
  assert.strictEqual(grade([glove('ended', file('src/a.ts'), { tool: 'Read', exit_status: 'fail' })], 'src/a.ts'), 'none');
});

it('a read mark that did not pass is no receipt, whatever its read_kind says (NF26: read_kind is never looked at first)', () => {
  for (const status of ['fail', 'unknown', undefined]) {
    const m = glove('read', file('src/a.ts'), { tool: 'Read', exit_status: status, read_kind: 'range' });
    assert.strictEqual(grade([m], 'src/a.ts'), 'none', String(status));
  }
});

it('test 79: a turn whose only edit of a file failed has no receipt for it (NF69)', () => {
  assert.strictEqual(grade([glove('ended', file('src/a.ts'), { tool: 'Edit', exit_status: 'fail' })], 'src/a.ts'), 'none');
  assert.strictEqual(grade([glove('modified', file('src/a.ts'), { tool: 'Edit', exit_status: 'fail' })], 'src/a.ts'), 'none');
});

it('test 80: a range read, a read the adapter cannot show was whole (null), and a full read are full receipts', () => {
  assert.strictEqual(grade([read('src/a.ts', 'range')], 'src/a.ts'), 'full', 'range (Q3-1)');
  assert.strictEqual(grade([read('src/a.ts', null)], 'src/a.ts'), 'full', 'null (Q3-2)');
  assert.strictEqual(grade([read('src/a.ts', 'full')], 'src/a.ts'), 'full');
  assert.strictEqual(grade([read('src/a.ts', 'range')], 'src/b.ts'), 'none', 'only for the file read');
});

it('test 81: a folder listing is a weak receipt for the files under it, and none outside it', () => {
  const ls = glove('read', dir('src'), { tool: 'LS', exit_status: 'pass', read_kind: null });
  assert.strictEqual(grade([ls], 'src/a.ts'), 'weak');
  assert.strictEqual(grade([ls], 'src/deep/b.ts'), 'weak');
  assert.strictEqual(grade([ls], 'srcx/a.ts'), 'none', 'a folder whose name extends another is not under it');
  assert.strictEqual(grade([ls], 'lib/a.ts'), 'none');
});

it('a search is weak: on a folder for the files under it, on the project root for every file, on a file for that file', () => {
  const search = (target) => glove('read', target, { tool: 'Grep', exit_status: 'pass', read_kind: 'pattern', pattern: 'x' });
  assert.strictEqual(grade([search(dir('src'))], 'src/a.ts'), 'weak');
  assert.strictEqual(grade([search(dir('.'))], 'lib/z.ts'), 'weak');
  assert.strictEqual(grade([search(file('src/a.ts'))], 'src/a.ts'), 'weak');
  assert.strictEqual(grade([search(file('src/a.ts'))], 'src/b.ts'), 'none');
});

it("a passing write is a full receipt for its file: created, modified, deleted, and a rename's new path", () => {
  for (const says of ['created', 'modified', 'deleted', 'renamed']) {
    assert.strictEqual(grade([glove(says, file('src/a.ts'), { tool: 'Write', exit_status: 'pass' })], 'src/a.ts'), 'full', says);
  }
});

it('the strongest receipt wins in any order; a later failure never takes back one earned', () => {
  const search = glove('read', dir('src'), { tool: 'Grep', exit_status: 'pass', read_kind: 'pattern', pattern: 'x' });
  const failed = glove('ended', file('src/a.ts'), { tool: 'Read', exit_status: 'fail' });
  const weakSearchOnFile = glove('read', file('src/a.ts'), { tool: 'Grep', exit_status: 'pass', read_kind: 'pattern', pattern: 'x' });
  assert.strictEqual(grade([read('src/a.ts', 'range'), search], 'src/a.ts'), 'full');
  assert.strictEqual(grade([search, read('src/a.ts', 'range')], 'src/a.ts'), 'full');
  assert.strictEqual(grade([read('src/a.ts', 'range'), weakSearchOnFile], 'src/a.ts'), 'full', 'a weak file read after a full one');
  assert.strictEqual(grade([read('src/a.ts', null), failed], 'src/a.ts'), 'full');
});

it('only the Glove gives receipts: a Sentinel mark, a command and a turn mark give none', () => {
  const sentinel = { ...glove('modified', file('src/a.ts'), { exit_status: 'pass' }), source: 'sentinel', turn: null }; // passing, so only the source refuses it
  const command = glove('exited', { kind: 'command', text: 'cat src/a.ts' }, { tool: 'Bash', exit_status: 'pass' });
  const turnEnd = glove('ended', { kind: 'turn', id: 't1' }, {});
  assert.strictEqual(grade([sentinel, command, turnEnd], 'src/a.ts'), 'none');
});

runAll('receipts');
