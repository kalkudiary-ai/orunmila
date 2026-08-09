'use strict';

/**
 * test/laws.js — the law layer (layers 4 and 5).
 *
 * Three things are under test, and the third is the one that matters:
 *   1. the schema refuses a malformed law LOUDLY (a law that silently stopped
 *      applying is the exact failure the layer exists to prevent);
 *   2. layer 5 can extend, patch and switch off layer 4;
 *   3. the evidentiary rules fire on a claim resting on a grep and stay silent
 *      on the same claim once the file has actually been read.
 */

const { assert, fs, path, tmpHome, tmpDir, rmrf, it, runAll } = require('./helpers');

const { validateLaw } = require('../src/laws/schema');
const { loadLaws, activeLaws, lawPaths } = require('../src/laws/load');
const { extractAssertions, isFactualAssertion } = require('../src/laws/assert-extractor');
const { evaluateTurn, buildReceipts, receiptStrength, readStrength } = require('../src/laws/evaluate');

// --- helpers ---------------------------------------------------------------

const lex = (over = {}) =>
  Object.assign(
    {
      id: 'no-vercel',
      title: 'This project does not deploy to Vercel',
      severity: 'warn',
      detect: { kind: 'lexical', scope: 'claim', patterns: ['\\bvercel\\b'] },
      message: 'Vercel is not this project’s host.',
    },
    over
  );

/** Build the law set from an explicit list, bypassing the file layers. */
function lawsFrom(entries) {
  return entries.map((e, i) => {
    const { law, errors } = validateLaw(e, { source: `test#${i}`, layer: 5 });
    assert.deepStrictEqual(errors, [], `law ${i} should validate: ${errors.join('; ')}`);
    return law;
  });
}

const CANON = () => activeLaws(loadLaws({ root: tmpDir() }).laws);

// --- schema ----------------------------------------------------------------

it('schema: a well-formed lexical law validates and compiles its patterns', () => {
  const { law, errors } = validateLaw(lex(), { source: 'test' });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(law.kind, 'lexical');
  assert.strictEqual(law.enabled, true);
  assert.strictEqual(law.patterns.length, 1);
  assert.ok(law.patterns[0].test('deployed to VERCEL'), 'pattern should be case-insensitive');
  assert.deepStrictEqual(law.rawPatterns, ['\\bvercel\\b'], 'raw source kept for printing back to the user');
});

it('schema: a law with no id is refused', () => {
  const { law, errors } = validateLaw(lex({ id: '' }), { source: 'test' });
  assert.strictEqual(law, null);
  assert.ok(errors.some((e) => /missing an "id"/.test(e)), errors.join('; '));
});

it('schema: a non-kebab-case id is refused', () => {
  const { errors } = validateLaw(lex({ id: 'No_Vercel' }), { source: 'test' });
  assert.ok(errors.some((e) => /kebab-case/.test(e)), errors.join('; '));
});

it('schema: an unknown severity is refused', () => {
  const { errors } = validateLaw(lex({ severity: 'explode' }), { source: 'test' });
  assert.ok(errors.some((e) => /unknown severity/.test(e)), errors.join('; '));
});

it('schema: an unknown evidentiary rule is refused, and the message lists the real ones', () => {
  const { errors } = validateLaw(
    { id: 'x', severity: 'block', detect: { kind: 'evidentiary', rule: 'vibes' } },
    { source: 'test' }
  );
  assert.ok(errors.some((e) => /unknown detect.rule "vibes"/.test(e)), errors.join('; '));
  assert.ok(errors.some((e) => /pattern_read_only/.test(e)), 'error should name the valid rules');
});

it('schema: an invalid regular expression is refused rather than crashing the gate', () => {
  const { errors } = validateLaw(lex({ detect: { kind: 'lexical', patterns: ['('] } }), { source: 'test' });
  assert.ok(errors.some((e) => /invalid regular expression/.test(e)), errors.join('; '));
});

it('schema: a pathologically long pattern is refused (the gate must not hang)', () => {
  const { errors } = validateLaw(lex({ detect: { kind: 'lexical', patterns: ['a'.repeat(500)] } }), { source: 'test' });
  assert.ok(errors.some((e) => /exceeds 400 characters/.test(e)), errors.join('; '));
});

// --- loading: layer 4 + layer 5 --------------------------------------------

it('load: the canon (layer 4) loads on its own with no user files present', () => {
  tmpHome();
  const root = tmpDir();
  const { laws, errors, layers } = loadLaws({ root });
  assert.deepStrictEqual(errors, [], errors.join('; '));
  assert.ok(laws.length >= 5, `expected the canon to carry laws, got ${laws.length}`);
  assert.ok(laws.every((l) => l.layer === 4), 'every canon law is layer 4');
  assert.ok(laws.some((l) => l.id === 'no-grep-as-basis'), 'the grep law ships in the canon');
  const canonLayer = layers.find((l) => l.key === 'canon');
  assert.strictEqual(canonLayer.present, true);
  assert.strictEqual(layers.find((l) => l.key === 'user').present, false, 'no user file yet');
  rmrf(root);
});

it('load: a user file (layer 5) adds its own laws alongside the canon', () => {
  const home = tmpHome();
  const root = tmpDir();
  fs.writeFileSync(path.join(home, 'laws.json'), JSON.stringify({ laws: [lex()] }));
  const { laws, errors } = loadLaws({ root });
  assert.deepStrictEqual(errors, [], errors.join('; '));
  const mine = laws.find((l) => l.id === 'no-vercel');
  assert.ok(mine, 'the user law is in force');
  assert.strictEqual(mine.layer, 5);
  rmrf(root);
});

it('load: a patch entry retunes a canon law by id without restating the rule', () => {
  const home = tmpHome();
  const root = tmpDir();
  fs.writeFileSync(
    path.join(home, 'laws.json'),
    JSON.stringify({ laws: [{ id: 'no-uncertainty-as-fact', severity: 'block' }] })
  );
  const { laws, errors } = loadLaws({ root });
  assert.deepStrictEqual(errors, [], errors.join('; '));
  const patched = laws.find((l) => l.id === 'no-uncertainty-as-fact');
  assert.strictEqual(patched.severity, 'block', 'the canon warning was escalated to a block');
  assert.strictEqual(patched.rule, 'hedged_assertion', 'detection is untouched by a patch');
  assert.ok(patched.patchedBy && patched.patchedBy.length === 1, 'the override is attributed, not hidden');
  rmrf(root);
});

it('load: enabled:false switches a canon law off', () => {
  const home = tmpHome();
  const root = tmpDir();
  fs.writeFileSync(path.join(home, 'laws.json'), JSON.stringify({ laws: [{ id: 'no-grep-as-basis', enabled: false }] }));
  const { laws } = loadLaws({ root });
  assert.strictEqual(laws.find((l) => l.id === 'no-grep-as-basis').enabled, false);
  assert.ok(!activeLaws(laws).some((l) => l.id === 'no-grep-as-basis'), 'a disabled law never reaches the evaluator');
  rmrf(root);
});

it('load: a patch aimed at an id that does not exist is reported, never silently ignored', () => {
  const home = tmpHome();
  const root = tmpDir();
  fs.writeFileSync(path.join(home, 'laws.json'), JSON.stringify({ laws: [{ id: 'no-grep-as-bassis', severity: 'block' }] }));
  const { errors } = loadLaws({ root });
  assert.ok(errors.some((e) => /does not patch any known law/.test(e)), errors.join('; '));
  rmrf(root);
});

it('load: a project file overrides a user file, and the redefinition is attributed', () => {
  const home = tmpHome();
  const root = tmpDir();
  fs.writeFileSync(path.join(home, 'laws.json'), JSON.stringify({ laws: [lex({ severity: 'warn' })] }));
  fs.mkdirSync(path.join(root, '.orunmila'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.orunmila', 'laws.json'),
    JSON.stringify({ laws: [lex({ severity: 'block', detect: { kind: 'lexical', patterns: ['\\bvercel\\b', '\\bnetlify\\b'] } })] })
  );
  const { laws, errors } = loadLaws({ root });
  assert.deepStrictEqual(errors, [], errors.join('; '));
  const l = laws.find((x) => x.id === 'no-vercel');
  assert.strictEqual(l.severity, 'block');
  assert.strictEqual(l.patterns.length, 2, 'the project definition replaced the user one outright');
  assert.ok(l.redefines, 'the replaced definition is attributed, not silently dropped');
  rmrf(root);
});

it('load: a malformed law file is a loud error, not a silent skip', () => {
  const home = tmpHome();
  const root = tmpDir();
  fs.writeFileSync(path.join(home, 'laws.json'), '{ this is not json');
  const { errors } = loadLaws({ root });
  assert.ok(errors.some((e) => /not valid JSON/.test(e)), errors.join('; '));
  rmrf(root);
});

it('load: lawPaths points layer 5 at .orunmila/, beside the existing ignore and redact files', () => {
  tmpHome();
  const p = lawPaths({ root: '/tmp/example-repo' });
  assert.strictEqual(p.project, path.join('/tmp/example-repo', '.orunmila', 'laws.json'));
  assert.ok(p.user.endsWith(path.join('laws.json')));
});

// --- the factual-assertion gate --------------------------------------------

it('assertions: a descriptive present-tense claim about code is caught', () => {
  assert.ok(isFactualAssertion('The wallet reads from tier_snapshot_at_issue in debit.ts.'));
});

it('assertions: questions, imperatives and offers are not assertions', () => {
  assert.ok(!isFactualAssertion('Does debit.ts read from the snapshot?'), 'question');
  assert.ok(!isFactualAssertion('Check debit.ts for the snapshot read.'), 'imperative');
  assert.ok(!isFactualAssertion('I can update debit.ts if you want.'), 'offer');
  assert.ok(!isFactualAssertion('If debit.ts reads the snapshot, we are fine.'), 'conditional');
});

it('assertions: an absolute claim is flagged as absolute', () => {
  const [a] = extractAssertions('All 16 call sites in debit.ts are wrong.');
  assert.ok(a, 'the sentence is an assertion');
  assert.strictEqual(a.absolute, true);
});

it('assertions: a phrase-only sentence yields nothing (the false-positive control)', () => {
  assert.deepStrictEqual(extractAssertions('The approach is reasonable and the outcome is good.'), []);
});

it('assertions: a forbidden word inside backticks is masked, so explaining a law does not break it', () => {
  const laws = lawsFrom([lex({ detect: { kind: 'lexical', scope: 'claim', patterns: ['\\bvercel\\b'] } })]);
  const used = evaluateTurn({ claimText: 'I deployed the web app to Vercel.', laws });
  const discussed = evaluateTurn({ claimText: 'The law forbids the word `Vercel` in a claim.', laws });
  assert.strictEqual(used.findings.length, 1, 'using the word fires');
  assert.strictEqual(discussed.findings.length, 0, 'quoting the word does not');
});

// --- receipts ---------------------------------------------------------------

it('receipts: a file_read with a content hash is a full receipt; without one it is weak', () => {
  assert.strictEqual(readStrength({ type: 'file_read', path: 'a.ts', hash: 'abc' }), 'full');
  assert.strictEqual(readStrength({ type: 'file_read', path: '**/*.ts' }), 'weak');
  assert.strictEqual(readStrength({ type: 'file_read', path: 'gone.ts', failed: true }), 'none');
});

it('receipts: an explicit read_kind beats the hash proxy when the capture layer records one', () => {
  assert.strictEqual(readStrength({ type: 'file_read', read_kind: 'pattern', hash: 'abc' }), 'weak');
  assert.strictEqual(readStrength({ type: 'file_read', read_kind: 'full' }), 'full');
});

it('receipts: a grep run through the shell is weak; a cat through the shell is full', () => {
  const r = buildReceipts([
    { type: 'command_run', command: 'grep -rn "debit" src/', exit_code: 0, stdout_excerpt: 'src/wallet/debit.ts:12' },
    { type: 'command_run', command: 'cat src/wallet/refund.ts', exit_code: 0, stdout_excerpt: 'export function refund()' },
  ]);
  assert.strictEqual(receiptStrength({ kind: 'path', value: 'debit.ts' }, r), 'weak', 'shell grep is a weak receipt');
  assert.strictEqual(receiptStrength({ kind: 'path', value: 'refund.ts' }, r), 'full', 'shell cat is a full receipt');
});

// --- the evidentiary rules --------------------------------------------------

const GREP_LAW = () => CANON().filter((l) => l.id === 'no-grep-as-basis');

it('grep law: fires when the only receipt for the claim is a pattern match', () => {
  const res = evaluateTurn({
    claimText: 'The wallet reads from tier_snapshot_at_issue in debit.ts.',
    turnEvents: [
      { type: 'command_run', command: 'grep -rn tier_snapshot_at_issue src/', exit_code: 0, stdout_excerpt: 'src/wallet/debit.ts:40' },
    ],
    laws: GREP_LAW(),
  });
  assert.strictEqual(res.findings.length > 0, true, 'a claim resting on a grep is caught');
  assert.strictEqual(res.blocking.length > 0, true, 'and it blocks, per the canon severity');
  assert.strictEqual(res.findings[0].heuristic, true, 'never dressed up as a glove fact');
});

it('grep law: goes quiet once the file has actually been read in full', () => {
  const res = evaluateTurn({
    claimText: 'The wallet reads from tier_snapshot_at_issue in debit.ts.',
    turnEvents: [
      { type: 'command_run', command: 'grep -rn tier_snapshot_at_issue src/', exit_code: 0, stdout_excerpt: 'src/wallet/debit.ts:40' },
      { type: 'file_read', path: '/repo/src/wallet/debit.ts', hash: 'deadbeef', bytes: 900 },
    ],
    laws: GREP_LAW(),
  });
  assert.strictEqual(res.findings.length, 0, 'having done the reading, the claim stands');
});

it('no-receipt law: fires on a confident claim about a file the turn never opened', () => {
  const laws = CANON().filter((l) => l.id === 'no-claim-without-receipt');
  const res = evaluateTurn({
    claimText: 'The router in dispatch.ts already handles the retry case.',
    turnEvents: [],
    laws,
  });
  assert.strictEqual(res.findings.length > 0, true);
  assert.ok(res.findings[0].evidence.unreceipted_targets.includes('dispatch.ts'), JSON.stringify(res.findings[0].evidence));
});

it('no-receipt law: stays silent when the file was read', () => {
  const laws = CANON().filter((l) => l.id === 'no-claim-without-receipt');
  const res = evaluateTurn({
    claimText: 'The router in dispatch.ts already handles the retry case.',
    turnEvents: [{ type: 'file_read', path: '/repo/src/dispatch.ts', hash: 'abc', bytes: 10 }],
    laws,
  });
  assert.strictEqual(res.findings.length, 0);
});

it('absolutes law: a grep can never license "all" — the claim is refused', () => {
  const laws = CANON().filter((l) => l.id === 'no-absolute-without-enumeration');
  const res = evaluateTurn({
    claimText: 'All 16 call sites in debit.ts are wrong.',
    turnEvents: [{ type: 'command_run', command: 'grep -rn NGN src/', exit_code: 0, stdout_excerpt: 'src/wallet/debit.ts:1' }],
    laws,
  });
  assert.strictEqual(res.findings.length > 0, true, 'an absolute on a grep is unlicensed');
});

/**
 * REGRESSION — a real miss, caught by dogfooding this layer while building it.
 *
 * Mid-build the agent asserted: "The clean fix is one additive field,
 * `read_kind`, on the FILE_READ event." It had read core.js and eventlog.js but
 * NOT lineage.js, whose trailEntry allowlist meant the fix was in fact two lines
 * in two files. The symbol `read_kind` did not exist anywhere yet — it had been
 * invented in the sentence that asserted it.
 *
 * no-claim-without-receipt caught it. no-absolute-without-enumeration did not,
 * because "one additive field" is a COUNTED claim and the absolutes rule only
 * knew digits followed by a short list of nouns. Sizing an unresearched change
 * as "one X" is the commonest confident under-estimate there is, so both laws
 * must fire on this sentence.
 */
it('regression: "the fix is one additive field" — a counted, unresearched claim is caught by BOTH laws', () => {
  const laws = CANON().filter((l) => l.id === 'no-claim-without-receipt' || l.id === 'no-absolute-without-enumeration');
  const res = evaluateTurn({
    claimText: 'The clean fix is one additive field, `read_kind`, on the file_read event.',
    // What the turn had actually looked at: two other files. Nothing covering
    // read_kind, because the symbol was invented in this very sentence.
    turnEvents: [
      { type: 'file_read', path: '/repo/src/capture/core.js', hash: 'aaa', bytes: 9000 },
      { type: 'file_read', path: '/repo/src/store/eventlog.js', hash: 'bbb', bytes: 6000 },
    ],
    laws,
  });
  const fired = res.findings.map((f) => f.law_id).sort();
  assert.deepStrictEqual(
    fired,
    ['no-absolute-without-enumeration', 'no-claim-without-receipt'],
    'both laws must fire on an invented symbol sized with an unenumerated count: ' + JSON.stringify(fired)
  );
  // Both laws CATCH it. Neither BLOCKS, and that is a measured decision rather
  // than a weakening. Against real sessions the absolutes rule cannot catch
  // "one additive field" without also catching "it needs two things", and the
  // receipt rule cannot tell a database-answered claim from an invented one
  // while the capture layer records a tool call's INPUT but never its RESULT.
  // Both ship as warnings until the log is good enough to justify stopping a
  // turn over them. Escalating either is a one-line layer-5 patch.
  assert.deepStrictEqual(res.blocking, [], 'nothing blocks on evidence this noisy — findings are raised, not enforced');
  assert.ok(res.findings.every((f) => f.severity === 'warn'), 'and the declared severity is honest about that');
});

it('regression: the same shape stands once the work has actually been done', () => {
  const laws = CANON().filter((l) => l.id === 'no-claim-without-receipt' || l.id === 'no-absolute-without-enumeration');
  const res = evaluateTurn({
    claimText: 'The clean fix is one additive field, `read_kind`, on the file_read event.',
    turnEvents: [
      { type: 'file_read', path: '/repo/src/capture/core.js', hash: 'aaa', bytes: 9000 },
      { type: 'command_run', command: 'cat src/trail/lineage.js', exit_code: 0, stdout_excerpt: 'if (e.read_kind) trailEntry.read_kind = e.read_kind;' },
    ],
    laws,
  });
  assert.deepStrictEqual(res.findings.map((f) => f.law_id), [], 'having checked the consumer, the claim stands');
});

it('verification law: "tests pass" with no passing command is refused; with one it stands', () => {
  const laws = CANON().filter((l) => l.id === 'no-green-without-command');
  const bare = evaluateTurn({ claimText: 'The tests pass and debit.ts is correct.', turnEvents: [], laws });
  assert.strictEqual(bare.findings.length > 0, true, 'a green claim with no command behind it');

  const backed = evaluateTurn({
    claimText: 'The tests pass and debit.ts is correct.',
    turnEvents: [{ type: 'command_run', command: 'npm test', exit_code: 0, stdout_excerpt: '13/13 suites passed' }],
    laws,
  });
  assert.strictEqual(backed.findings.length, 0, 'a green claim with a passing command stands');
});

it('verification law: a FAILED command does not license a green claim, and the exit code is shown', () => {
  const laws = CANON().filter((l) => l.id === 'no-green-without-command');
  const res = evaluateTurn({
    claimText: 'The tests pass and debit.ts is correct.',
    turnEvents: [{ type: 'command_run', command: 'npm test', exit_code: 1, stdout_excerpt: '1 failing' }],
    laws,
  });
  assert.strictEqual(res.findings.length > 0, true);
  assert.ok(/exit 1/.test(res.findings[0].evidence.failed_commands.join(' ')), 'the failing exit is quoted back');
});

it('lexical law over commands: a forbidden shell invocation is caught in the command stream', () => {
  const laws = lawsFrom([
    {
      id: 'no-add-all',
      severity: 'block',
      detect: { kind: 'lexical', scope: 'command', patterns: ['git\\s+add\\s+(-A|--all|\\.)'] },
      message: 'Stage only the paths you authored.',
    },
  ]);
  const res = evaluateTurn({
    claimText: 'Committed the change.',
    turnEvents: [{ type: 'command_run', command: 'git add -A && git commit -m wip', exit_code: 0 }],
    laws,
  });
  assert.strictEqual(res.findings.length, 1);
  assert.strictEqual(res.findings[0].evidence.where, 'command');
  assert.strictEqual(res.blocking.length, 1);
});

it('an "unless" clause exempts the sentence that forbids the thing', () => {
  const laws = lawsFrom([
    {
      id: 'no-assume',
      severity: 'warn',
      detect: { kind: 'lexical', scope: 'claim', patterns: ['\\bassume\\b'], unless: ['\\bnever assume\\b'] },
      message: 'Do not assume.',
    },
  ]);
  assert.strictEqual(evaluateTurn({ claimText: 'I assume the cache is warm.', laws }).findings.length, 1);
  assert.strictEqual(evaluateTurn({ claimText: 'The rule is that we never assume.', laws }).findings.length, 0);
});

it('a turn with no claim text and no events produces no findings at all', () => {
  const res = evaluateTurn({ claimText: '', turnEvents: [], laws: CANON() });
  assert.deepStrictEqual(res.findings, [], 'silence beats noise');
});

it('the whole canon over an ordinary, well-evidenced turn stays quiet', () => {
  const res = evaluateTurn({
    claimText: 'I read src/wallet/debit.ts and it debits the annual wallet before the top-up wallet.',
    turnEvents: [
      { type: 'file_read', path: '/repo/src/wallet/debit.ts', hash: 'abc', bytes: 2400 },
      { type: 'command_run', command: 'npm test', exit_code: 0, stdout_excerpt: 'ok' },
    ],
    laws: CANON(),
  });
  assert.deepStrictEqual(
    res.findings.map((f) => f.law_id),
    [],
    'a claim backed by a real read must not be flagged: ' + JSON.stringify(res.findings.map((f) => [f.law_id, f.evidence.text]))
  );
});

runAll('laws (layers 4 + 5)');