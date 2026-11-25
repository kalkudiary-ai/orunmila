// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/weakened.js — R27, tests weakened (MR2, LD317; brief v4 line 176's example of the lie detector; O's approval of
 * R2, LD315). The agent's own change to a test file that makes the suite easier to pass: a test file deleted, skip or
 * only markers added, assertions removed. The judge gives it Look at this by default; the report says what happened and,
 * when that turn's claim says the tests pass, says that too. Hand-built session logs (test/helpers-opon.js), made-up
 * paths; the diffs are written beside the log, as the intake keeps them, and named by their fingerprint.
 */

const crypto = require('crypto');
const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { makeLog, M } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');
const { isTestPath, weakening, changedLines } = require('../src/babalawo/weakened');
const { testDiffs, testDiffsFromMarks } = require('../src/opon/ledger/beside');
const { buildReport, renderText } = require('../src/babalawo/report');
const { loadRules, DEFAULT_RULES } = require('../src/babalawo/rules');

const recordsOf = (text) => text.split('\n').slice(0, -1).map((l) => JSON.parse(l));

/** A diff kept beside the log, as the intake keeps it: files/<sha256 hex>; returns its ref. */
function keep(dir, text) {
  const hex = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'files', hex), text);
  return 'sha256:' + hex;
}

/** One agent edit of `file` whose diff is `diff`, seen by both witnesses, in turn t1, then a claim of `claim`. */
function session(file, diff, { says = 'modified', claim = 'All tests pass.' } = {}) {
  const base = tmpDir();
  const s = makeLog(base);
  s.append(M.prompted(0));
  s.append(M.started(10, 'e1', { kind: 'file', path: file }));
  const edit = M.edited(50, 'e1', file, says);
  if (diff !== null) edit.detail = { ...edit.detail, diff_ref: keep(s.dir, diff) };
  s.append(edit);
  s.append(M.disk(70, file, says));
  s.append({ ...M.claimed(900), detail: { text: claim } });
  s.append({ ...M.claimed(901), source: 'law_gate', says: 'checked', target: { kind: 'turn', id: 't1' }, detail: { result: 'passed', findings: [] } });
  s.append(M.turnEnded(902));
  s.append(M.tick(10000));
  const r = replayFolder(s.dir);
  assert.ok(r.ok && r.verdict, `${r.words} ${r.verdict_words}`);
  const raw = recordsOf(fs.readFileSync(path.join(s.dir, 'raw.jsonl'), 'utf8'));
  const odus = recordsOf(r.odu);
  const verdicts = recordsOf(r.verdict);
  const rep = buildReport({ header: raw[0], marks: raw.slice(1), odus, verdicts, diffs: testDiffsFromMarks({ odus, marks: raw.slice(1), dir: s.dir }) });
  rmrf(base);
  return { odus, verdicts, rep };
}
const r27 = (verdicts) => verdicts.filter((v) => v.record === 'verdict' && (v.rule === 'R27' || v.also.includes('R27')));

it("MR2: which paths are test files: the facts line's one definition, every OS separator", () => {
  for (const p of ['test/a.js', 'src/__tests__/b.ts', 'a.test.ts', 'pkg/b_test.go', 'tests/test_c.py', 'c_test.py', 'spec/x.rb', 'src\\tests\\w.js', 'web/d.spec.tsx'])
    assert.ok(isTestPath(p), p);
  for (const p of ['src/a.js', 'contest.js', 'latest/x.js', 'attestation.md', 'src/testing.js']) assert.ok(!isTestPath(p), p);
});

it('MR2: the diff reader counts only added and removed lines, never the file lines', () => {
  assert.deepStrictEqual(changedLines('--- a.js (before)\n+++ a.js (after)\n-x\n+y\n z'), { added: ['y'], removed: ['x'] });
});

it('MR2 (line 176): the agent deleted a test file and claimed the tests pass: R27, Look at this, and the report says both', () => {
  const { verdicts, rep } = session('test/auth.test.js', null, { says: 'deleted' });
  const v = r27(verdicts);
  assert.strictEqual(v.length, 1, JSON.stringify(verdicts));
  assert.strictEqual(v[0].verdict, 'look_at_this');
  const f = rep.findings.find((x) => x.rule === 'R27');
  assert.ok(f && /The agent deleted the test file test\/auth\.test\.js/.test(f.sentence), JSON.stringify(rep.findings));
  assert.ok(f.sentence.includes('while its claim in that turn says the tests pass ("tests pass")'), f.sentence);
  assert.ok(renderText(rep).includes(f.sentence));
});

it('MR2: skip and only markers added to a test file are R27; the report counts them', () => {
  const diff = "--- test/a.test.js (before)\n+++ test/a.test.js (after)\n-  it('logs in', () => {\n+  it.skip('logs in', () => {\n+  describe.only('x', () => {});\n";
  const { verdicts, rep } = session('test/a.test.js', diff);
  assert.strictEqual(r27(verdicts).length, 1, JSON.stringify(verdicts));
  const f = rep.findings.find((x) => x.rule === 'R27');
  assert.ok(/added 2 skip or only markers to test\/a\.test\.js/.test(f.sentence), f.sentence);
});

it('MR2: more assertions removed than added is R27; a rewrite that keeps them is not', () => {
  const weaker = '--- t/x_test.go (before)\n+++ t/x_test.go (after)\n-\tif got != 3 { t.Errorf("bad") }\n-\tassert.Equal(t, 3, got)\n+\t_ = got\n';
  const a = session('t/x_test.go', weaker);
  assert.strictEqual(r27(a.verdicts).length, 1, JSON.stringify(a.verdicts));
  assert.ok(/removed 2 assertion lines and added 0 in t\/x_test\.go/.test(a.rep.findings.find((x) => x.rule === 'R27').sentence));
  const same = '--- test/y.test.js (before)\n+++ test/y.test.js (after)\n-  expect(a).toBe(1);\n+  expect(a).toBe(2);\n';
  assert.strictEqual(r27(session('test/y.test.js', same).verdicts).length, 0);
});

it('MR2: a test file changed with no diff kept, or a diff whose bytes do not match its fingerprint, is never read as an empty diff', () => {
  const { verdicts } = session('test/z.test.js', null);
  assert.strictEqual(r27(verdicts).length, 0, 'no diff: nothing to read, nothing found');
  const o = { record: 'odu', state: 'sealed', target: { kind: 'file', path: 'test/z.test.js' }, action: 'modified', attribution: 'explained', net_change: { changed: true }, mark_seqs: [1] };
  assert.strictEqual(weakening(o, []), null);
});

it('MR2 (line 267, open question 4): the reader keeps a diff only when its bytes match its fingerprint; a missing or changed one is left out', () => {
  const dir = tmpDir();
  try {
    const good = keep(dir, '-  expect(a).toBe(1);\n');
    const bad = keep(dir, '+  it.skip(1)\n');
    fs.writeFileSync(path.join(dir, 'files', bad.slice(7)), 'changed after it was kept');
    const odus = [{ record: 'odu', state: 'sealed', odu_id: 'odu_0001', target: { kind: 'file', path: 'test/a.test.js' }, action: 'modified', mark_seqs: [1, 2, 3] }];
    const refs = { 1: good, 2: bad, 3: 'sha256:' + 'f'.repeat(64) };
    assert.deepStrictEqual(testDiffs({ odus, refOf: (s) => refs[s], dir }), { odu_0001: ['-  expect(a).toBe(1);\n'] });
    const outside = [{ ...odus[0], target: { kind: 'file', path: 'src/a.js' } }];
    assert.deepStrictEqual(testDiffs({ odus: outside, refOf: (s) => refs[s], dir }), {}, 'only test files are read');
  } finally {
    rmrf(dir);
  }
});

it("MR2: a change no agent action explains is R6's, not R27's (it may have been the person)", () => {
  const o = { record: 'odu', state: 'sealed', target: { kind: 'file', path: 'test/a.test.js' }, action: 'deleted', attribution: 'unexplained', net_change: { changed: true }, mark_seqs: [1] };
  assert.strictEqual(weakening(o, []), null);
});

it('MR2: R27 is in the default rules, Look at this, and a rules file may set it off or violation', () => {
  assert.ok(DEFAULT_RULES.includes('R27 look_at_this'), DEFAULT_RULES);
  assert.strictEqual(loadRules('R27 off\n').rules.verdict.R27, 'off');
  assert.strictEqual(loadRules('R27 violation\n').rules.verdict.R27, 'violation');
});

runAll('weakened');
