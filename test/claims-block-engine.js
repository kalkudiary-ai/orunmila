// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/claims-block-engine.js — MR1b2 (LD339; spec/claims-block.md: `changed:` lines "checked against the record's
 * changes in the turn (a later slice)"; brief v4 lines 432, 434, 443): the Ọpọ́n reads the claims block's `changed:`
 * paths as file claims of their turn, as it reads "I updated src/a.ts" (C3d1), and as files the agent mentioned (C3d2).
 * A path it changed is backed; one it did not is a phantom file claim; a change it lists, even by a bare name, is not
 * a silent one. Hand-built logs, labelled so (brief line 761): made-up paths.
 */

const { assert, rmrf, tmpDir, it, runAll } = require('./helpers');
const { makeLog, M } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');
const { claimsOf, mentionsOf } = require('../src/opon/corroborate/claims');

const block = (lines) => ['Done.', '', '```orunmila-claims', ...lines, '```'].join('\n');
const claimed = (ms, text) => ({ ...M.claimed(ms), detail: { text } });

it('MR1b2: a claimed mark\'s block gives one file claim of its changed: paths, and they are mentions; a message with no block gives neither', () => {
  const m = claimed(0, block(['changed: src/a.ts, README.md', 'proved: npm test', 'not done: the docs']));
  const fromBlock = claimsOf(m).filter((c) => c.claim === 'block');
  assert.deepStrictEqual(fromBlock, [{ claim: 'block', text: 'changed: src/a.ts, README.md', files: ['src/a.ts', 'README.md'], commands: [], hedged: false }]);
  assert.ok(mentionsOf(m).includes('README.md'), 'a bare name in the block is mentioned');
  assert.deepStrictEqual(claimsOf(claimed(0, 'Done.')), []);
  assert.deepStrictEqual(claimsOf({ ...m, detail: { text: m.detail.text, claim_unconfirmed: true } }), [], 'text that may be another turn\'s is never read');
});

/** One turn: the agent edits src/a.ts and README.md, then ends with `text`; replayed. Returns every record. */
function turn(text) {
  const base = tmpDir();
  try {
    const s = makeLog(base, {});
    s.append(M.prompted(0));
    s.append(M.edited(100, 'e1', 'src/a.ts'));
    s.append(M.disk(150, 'src/a.ts'));
    s.append(M.edited(200, 'e2', 'README.md'));
    s.append(M.disk(250, 'README.md'));
    s.append(claimed(3000, text));
    s.append(M.turnEnded(3100));
    s.append(M.tick(20000));
    const r = replayFolder(s.dir);
    assert.strictEqual(r.ok, true, r.words);
    return r.lines.slice(1).map((l) => JSON.parse(l));
  } finally {
    rmrf(base);
  }
}
const phantoms = (recs) => recs.filter((g) => g.target && g.target.kind === 'claim').flatMap((g) => g.conflicts.filter((c) => c.kind === 'phantom_claim' && c.claim === 'file').map((c) => [c.path, c.why]));
const silent = (recs) => recs.filter((g) => g.conflicts && g.conflicts.some((c) => c.kind === 'silent_change')).map((g) => g.target.path).sort();

it('MR1b2: replayed, a changed: path the turn changed is backed, one it did not is a phantom file claim, and listed changes are not silent', () => {
  const recs = turn(block(['changed: src/a.ts, README.md, src/never.ts']));
  assert.deepStrictEqual(phantoms(recs), [['src/never.ts', 'no_event']]);
  assert.deepStrictEqual(silent(recs), [], 'both changes are listed in the block');
  for (const p of ['src/a.ts', 'README.md']) {
    const g = recs.find((x) => x.target && x.target.path === p);
    assert.deepStrictEqual([g.witness_status.glove.status, g.witness_status.sentinel.status], ['saw', 'saw'], p);
  }
  const without = turn('Done: the two edits.');
  assert.deepStrictEqual(phantoms(without), []);
  assert.deepStrictEqual(silent(without), ['README.md', 'src/a.ts'], 'with no block and no mention, both are silent, as before MR1b2');
});

it('MR1b3 (LD339): the session report gives each not done: line of the agent\'s blocks, with its turn, in text, HTML and JSON; none from text that could not be confirmed', () => {
  const { buildReport, renderText, renderHtml, renderJson } = require('../src/babalawo/report');
  const mk = (seq, turn, text, extra = {}) => ({ ...M.claimed(seq), seq, turn, detail: { text, ...extra } });
  const marks = [mk(1, 't1', block(['not done: the Windows run', 'not done: the <docs>'])), mk(2, 't2', 'All done.'), mk(3, 't3', block(['not done: hidden']), { claim_unconfirmed: true })];
  const rep = buildReport({ header: { session_id: 's', agent: { name: 'claude-code' } }, marks, odus: [], verdicts: [] });
  assert.deepStrictEqual(rep.not_done, [{ turn: 't1', text: 'the Windows run' }, { turn: 't1', text: 'the <docs>' }]);
  const line = 'The agent said it did not do: "the Windows run" (turn t1); "the <docs>" (turn t1).';
  assert.ok(renderText(rep).includes(line), renderText(rep));
  assert.ok(renderHtml(rep).includes('the &lt;docs&gt;') && !renderHtml(rep).includes('the <docs>'), 'escaped in the page');
  assert.deepStrictEqual(JSON.parse(renderJson(rep)).not_done, rep.not_done);
  const none = buildReport({ header: { session_id: 's' }, marks: [mk(2, 't2', 'All done.')], odus: [], verdicts: [] });
  assert.deepStrictEqual(none.not_done, []);
  assert.ok(!renderText(none).includes('did not do'));
});

runAll('claims-block-engine');
