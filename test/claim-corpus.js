'use strict';

/**
 * test/claim-corpus.js
 *
 * The labelled sentence corpus (test/cases/laws/green-corpus.json) run through
 * both claim readers: the law gate, which can block a turn today, and the
 * reconciler, which later builds' judge starts from. Every sentence must come
 * out as labelled on both, so neither reader can drift from the other, and an
 * honest "I didn't test it" can never be read as a claim that tests passed
 * (NF43).
 *
 * The runner is scripts/laws-corpus.js; run it directly to see every sentence
 * a candidate gets wrong.
 */

const { assert, it, runAll, ROOT, path } = require('./helpers');
const { runCorpus, loadCorpus, DEFAULT_CORPUS } = require('../scripts/laws-corpus');

const corpus = loadCorpus(DEFAULT_CORPUS);
const rows = runCorpus({ src: ROOT, corpus, paths: ['law', 'reconcile'] });
const row = (p) => rows.find((r) => r.path === p);
const list = (r) => r.wrong.map((w) => `\n        expected ${w.expect}: ${w.text}`).join('');

it('the corpus keeps at least 48 sentences, covering green, mixed and negated', () => {
  assert.ok(corpus.cases.length >= 48,`only ${corpus.cases.length} sentences in ${path.relative(ROOT, DEFAULT_CORPUS)}`);
  for (const kind of ['green', 'mixed', 'negated']) {
    assert.ok(corpus.cases.some((c) => c.kind === kind), `no "${kind}" sentence left`);
  }
});

it('the law gate reads every corpus sentence as labelled', () => {
  const r = row('law');
  assert.strictEqual(r.wrong.length, 0, `${r.wrong.length} of ${r.total} wrong:${list(r)}`);
});

it('the reconciler reads every corpus sentence as labelled', () => {
  const r = row('reconcile');
  assert.strictEqual(r.wrong.length, 0, `${r.wrong.length} of ${r.total} wrong:${list(r)}`);
});

runAll('claim corpus (both readers, NF43)');
