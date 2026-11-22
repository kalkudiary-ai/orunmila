'use strict';

/**
 * test/claims.js — claim capture without AI (Phase 3 slice C2, LD186; brief v4
 * lines 431-433, 443; guarantee 8): a `claimed` mark's text, as the raw log
 * holds it, read by today's rule-based reader into file claims and command
 * claims, for station 6's phantom-claim check (C3). The labelled corpus
 * (test/cases/laws/green-corpus.json) goes through marks; the other sentences
 * are made up, labelled so (brief line 761).
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { makeLog, M } = require('./helpers-opon');
const { claimsOf } = require('../src/opon/corroborate/claims');
const { loadCorpus, DEFAULT_CORPUS } = require('../scripts/laws-corpus');

/** Write each text as a `claimed` mark (the Glove's agent_claim) and read the marks back from the raw log. */
function throughLog(texts, detail = {}) {
  const base = tmpDir();
  try {
    const log = makeLog(base);
    texts.forEach((text, i) => log.append({ ...M.claimed(i * 10, `t${i + 1}`), detail: { text, ...detail } }));
    const lines = fs.readFileSync(path.join(log.dir, 'raw.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return lines.filter((m) => m.says === 'claimed');
  } finally {
    rmrf(base);
  }
}
const shape = (cs) => cs.map((c) => [c.files, c.commands]);

it('C2 the corpus through marks: every sentence labelled fire gives a command claim, every one labelled silent gives no claim of either kind', () => {
  const corpus = loadCorpus(DEFAULT_CORPUS);
  const marks = throughLog(corpus.cases.map((c) => c.text));
  assert.strictEqual(marks.length, corpus.cases.length);
  const wrong = [];
  corpus.cases.forEach((c, i) => {
    assert.strictEqual(marks[i].source, 'agent_claim', 'the closing claim is the Glove\'s agent_claim mark');
    const cs = claimsOf(marks[i], { strictProof: !!c.strict });
    const fires = cs.some((x) => x.commands.length > 0);
    const any = cs.some((x) => x.commands.length || x.files.length);
    if (c.expect === 'fire' ? !fires : any) wrong.push(`${c.expect}: ${c.text}`);
  });
  assert.deepStrictEqual(wrong, [], `${wrong.length} of ${corpus.cases.length} wrong`);
});

it('C2 file claims and command claims: each claim keeps the paths as written and the execution phrases; a target inherited from an earlier sentence makes no file claim', () => {
  const [m] = throughLog(['I updated `src/config.ts` and added a test in test/a.test.js. All tests pass.']);
  const cs = claimsOf(m);
  assert.deepStrictEqual(shape(cs), [[['src/config.ts'], []], [['test/a.test.js'], []], [[], ['tests pass']]]);
  assert.deepStrictEqual(cs.map((c) => c.text), ['I updated `src/config.ts`', 'added a test in test/a.test.js.', 'All tests pass.']);
  // An action verb and a verification word, no path of its own: the reader lends it login.js, which makes no file claim.
  const [n] = throughLog(['I added validation to src/login.js. I cleaned up, tested.']);
  assert.deepStrictEqual(shape(claimsOf(n)), [[['src/login.js'], []], [[], ['tested']]], 'the lent path is no file claim of the second sentence');
  // "verified" alone is satisfiable by reading: no command claim (LD186 (2)).
  const [v] = throughLog(['I added validation to src/login.js. I refactored it, which is now verified.']);
  assert.deepStrictEqual(shape(claimsOf(v)), [[['src/login.js'], []]]);
});

it('C2: a path only mentioned, with no action verb used, is no file claim; a hedged claim is tagged', () => {
  const [quoted, hedged] = throughLog(['The template says "I updated config.ts".', 'I added some basic validation to src/login.js.']);
  assert.deepStrictEqual(shape(claimsOf(quoted)), []);
  const cs = claimsOf(hedged);
  assert.deepStrictEqual(shape(cs), [[['src/login.js'], []]]);
  assert.strictEqual(cs[0].hedged, true);
});

it('C2 guarantee 10\'s rule in capture: a claim whose text could not be confirmed (N10) gives no claims; a mark that is no claim gives none', () => {
  const [m] = throughLog(['I updated src/config.ts. All tests pass.'], { claim_unconfirmed: true });
  assert.deepStrictEqual(claimsOf(m), []);
  assert.deepStrictEqual(claimsOf(M.prompted(0)), []);
});

runAll('claims');
