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

const { assert, fs, path, tmpHome, tmpDir, rmrf, run, it, runAll } = require('./helpers');

const { validateLaw } = require('../src/laws/schema');
const { loadLaws, activeLaws, lawPaths } = require('../src/laws/load');
const { extractAssertions, isFactualAssertion } = require('../src/laws/assert-extractor');
const { evaluateTurn, buildReceipts, receiptStrength, readStrength, hasUnguardedPipe } = require('../src/laws/evaluate');

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

it('receipts: a pager downstream of a grep does NOT upgrade it to a read', () => {
  // The regression this guards. The rule was once "is a pattern AND the line
  // does not also mention cat/head/tail/sed", so `grep x src | head` matched on
  // its `head` and was filed as a FULL READ of every file the grep named.
  // Measured over a real corpus on 2026-08-16: 292 of 457 shell greps (63.9%)
  // were piped into a pager — `| head` alone was 219 — so nearly two thirds of
  // every pattern match ever run was recorded as though the file had been read.
  // That is precisely the receipt no-grep-as-basis must never find.
  for (const command of [
    'grep -rn "debit" src/ | head',
    'grep -rn "debit" src/ | head -40',
    'grep -rn "debit" src/ | cat',
    'grep -rn "debit" src/ | tail -5',
    'ps aux | grep -i debit | grep -v grep | head',
  ]) {
    const r = buildReceipts([{ type: 'command_run', command, exit_code: 0, stdout_excerpt: 'src/wallet/debit.ts:12' }]);
    assert.strictEqual(receiptStrength({ kind: 'path', value: 'debit.ts' }, r), 'weak', command);
  }
});

it('receipts: independent commands on one line are graded separately', () => {
  // Why the read exemption could not simply be deleted: a compound line can
  // honestly do both. 49 of those 292 were this shape — a real partial read of
  // one file beside a pattern match of another. Splitting on `;`/`&&`/`||` (but
  // NOT on a single `|`, whose stages share one pipeline) files each half where
  // it belongs instead of letting either one speak for the whole line.
  const r = buildReceipts([
    { type: 'command_run', command: 'sed -n "1,40p" src/a.ts && grep -rn "x" src/b.ts | head', exit_code: 0, stdout_excerpt: '' },
  ]);
  assert.strictEqual(receiptStrength({ kind: 'path', value: 'a.ts' }, r), 'full', 'the sed really did read a.ts');
  assert.strictEqual(receiptStrength({ kind: 'path', value: 'b.ts' }, r), 'weak', 'the grep only pattern-matched b.ts');
});

it('receipts: a non-pattern command still contributes its OUTPUT as a full receipt', () => {
  // Guards the other direction: attributing output separately must not cost
  // `npm test` its ability to name a failing file that appears only in stdout.
  const r = buildReceipts([
    { type: 'command_run', command: 'npm test', exit_code: 0, stdout_excerpt: 'FAIL src/wallet/debit.ts' },
  ]);
  assert.strictEqual(receiptStrength({ kind: 'path', value: 'debit.ts' }, r), 'full');
});

// --- the evidentiary rules --------------------------------------------------

const GREP_LAW = () => CANON().filter((l) => l.id === 'no-grep-as-basis');

it('grep law: fires when the only receipt for the claim is a pattern match', () => {
  const res = evaluateTurn({
    // Written as a PATH, not a bare basename: the narrowed rule fires only for
    // targets that name a file in this codebase, which is what excludes the
    // dependency-name false positives ("it requires internet to load Three.js").
    claimText: 'The wallet reads from tier_snapshot_at_issue in src/wallet/debit.ts.',
    turnEvents: [
      { type: 'command_run', command: 'grep -rn tier_snapshot_at_issue src/', exit_code: 0, stdout_excerpt: 'src/wallet/debit.ts:40' },
    ],
    laws: GREP_LAW(),
  });
  assert.strictEqual(res.findings.length > 0, true, 'a claim resting on a grep is caught');
  assert.strictEqual(res.findings[0].heuristic, true, 'never dressed up as a glove fact');
  assert.strictEqual(res.blocking.length > 0, true, 'and it blocks — the narrowed rule earned it on real data');
});

it('grep law: goes quiet once the file has actually been read in full', () => {
  const res = evaluateTurn({
    // Written as a PATH, not a bare basename: the narrowed rule fires only for
    // targets that name a file in this codebase, which is what excludes the
    // dependency-name false positives ("it requires internet to load Three.js").
    claimText: 'The wallet reads from tier_snapshot_at_issue in src/wallet/debit.ts.',
    turnEvents: [
      { type: 'command_run', command: 'grep -rn tier_snapshot_at_issue src/', exit_code: 0, stdout_excerpt: 'src/wallet/debit.ts:40' },
      { type: 'file_read', path: '/repo/src/wallet/debit.ts', hash: 'deadbeef', bytes: 900 },
    ],
    laws: GREP_LAW(),
  });
  assert.strictEqual(res.findings.length, 0, 'having done the reading, the claim stands');
});

/**
 * REGRESSION — the dependency-name false positive, measured and then designed out.
 *
 * The first cut of the grep law fired 12 times across 194 real sessions with
 * about 2 genuine. Every false positive was a DEPENDENCY or command name that
 * happened to sit in a grep pattern. Those are claims about the world, not this
 * codebase, and reading a local file would settle none of them. Narrowing to
 * path-shaped targets took 12 firings to 1 — the genuine one — which is what
 * let this law be escalated to block.
 */
it('regression: a dependency named in prose must never block a turn', () => {
  const laws = GREP_LAW();
  const greped = [{ type: 'command_run', command: 'grep -rn "force-graph" src/', exit_code: 0, stdout_excerpt: 'src/render/trail-visual.js:12 three.js' }];

  for (const claim of [
    'It requires internet to load Three.js and 3d-force-graph from CDN.',
    'The 3D graph now uses 3d-force-graph for the layout.',
    'debug-transcript exists because parsers do silently come back empty.',
  ]) {
    const res = evaluateTurn({ claimText: claim, turnEvents: greped, laws });
    assert.deepStrictEqual(res.findings, [], `a package/command name is not a claim about this repo: "${claim}"`);
  }
});

it('regression: the genuine catch still fires — a named FILE claimed from a grep alone', () => {
  const res = evaluateTurn({
    claimText: 'grep of src/render/trail-visual.js returns 0 hits, so only one THREE. reference remains.',
    turnEvents: [{ type: 'command_run', command: 'grep -n nodeThreeObject src/render/trail-visual.js', exit_code: 0, stdout_excerpt: '' }],
    laws: GREP_LAW(),
  });
  assert.strictEqual(res.blocking.length > 0, true, 'a claim about what is NOT in a file needs the file read, not matched');
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

/**
 * REGRESSION — P0-3. The flagship BLOCKING law could not see the commonest way
 * an agent claims a pass.
 *
 * Found 2026-10-28 while building a demo of the gate firing: the demo did not
 * fire. "The build is green." was caught. "Tests pass.", "All tests pass.",
 * "I ran the tests and they pass." and "It works." were not — and THREE
 * different filters were responsible, not one:
 *
 *   "Tests pass."                    11 characters — died on the length floor
 *   "All tests pass."                no copula     — died on the state-verb test
 *   "I ran the tests and they pass." first person  — died on external-subject
 *
 * Two more died on the vocabulary itself, which was a list of ADJACENT word
 * pairs: "test SUITE passes" has a word in the gap. Those two were recorded in
 * the issue tracker as CAUGHT, on the strength of the law's title rather than a
 * run — so this table is the acceptance test from review/ISSUES.md, extended
 * with the shapes the issue itself got wrong.
 */
const GREEN_LAW = () => CANON().filter((l) => l.id === 'no-green-without-command');
const READ_ONLY = [{ type: 'file_read', path: '/repo/src/x.js', hash: 'abc', bytes: 100 }];
const greenFires = (claimText, turnEvents = READ_ONLY) =>
  evaluateTurn({ claimText, promptText: 'go', turnEvents, laws: GREEN_LAW() }).findings.length > 0;

it('P0-3: every common phrasing of "it passed" is seen, not just the copula-shaped ones', () => {
  for (const claim of [
    'Full suite green, 1463 tests pass, and debit.ts is correct.',
    'The build is green.',
    'The suite is passing.',
    'Tests are passing.',
    'Tests pass.',
    'All tests pass.',
    'The tests passed.',
    'The test suite passes.',
    'I ran the tests and they pass.',
    'I tested it and it works.',
    'It works.',
    'The lint passes and tsc is clean.',
    'CI is green.',
    'Everything works.',
    'The smoke ran clean.',
  ]) {
    assert.ok(greenFires(claim), `must fire with no passing command behind it: ${claim}`);
  }
});

/**
 * The other half, and the half that decides whether a BLOCKING law is bearable.
 * The first five are the documented false positives from assert-extractor's own
 * comments; the last eight are sentences that FIRED when the vocabulary was
 * first widened, taken verbatim from this tool's own 111-session corpus. A law
 * that stops a turn has to stay silent on every one of them.
 */
it('P0-3: care, intent, mechanism and the other sense of "passed" stay silent', () => {
  for (const claim of [
    // being careful — negation and attributive use
    'capture hooks exist for one agent; Cursor/Aider are not tested',
    'branch coverage was low because the new branches were not tested',
    'the multiplier logic is unit-tested',
    'empty means open by the tested logic',
    'the verification verb is in a future frame (*should work*)',
    // speech acts
    'Do the tests pass?',
    'If the tests pass, push it.',
    'Run the tests and check it works.',
    "I'll run the tests and confirm it works.",
    'Once the suite is green we can ship.',
    // hedged — the green law has no hedge check of its own
    'The tests probably pass.',
    'I think the build is green.',
    // intent, not report
    'We need to make the tests pass.',
    'The goal is to get the suite green.',
    // reported speech, and mechanism rather than outcome
    'The handover says the tests pass.',
    'This is how it works.',
    'Whether the suite passes is the open question.',
    // measured false positives from the real corpus
    'the coverage work that made them invisible',
    'none of it is work you asked for',
    "my-video has no .git of its own - it's inside Kalku's working tree",
    'I re-ran it with --repo passed explicitly.',
    'It contradicted itself and I passed it as clean.',
    'there have been zero errors in the actual last 24h',
    'check 1 was not user-scoped so it prints PASS',
    'The flag is passed to the adapter.',
  ]) {
    assert.ok(!greenFires(claim), `must stay silent: ${claim}`);
  }
});

it('P0-3: the newly-seen phrasings stand once a passing command backs them', () => {
  const passing = [{ type: 'command_run', command: 'npm test', exit_code: 0, stdout_excerpt: '15/15 passed' }];
  for (const claim of ['Tests pass.', 'It works.', 'I ran the tests and they pass.']) {
    assert.ok(!greenFires(claim, passing), `a real receipt licenses it: ${claim}`);
  }
});

/**
 * REGRESSION — the RECEIPT side of the same law, found while measuring the fix
 * above and worse than the recall gap it was hiding behind.
 *
 * buildReceipts accepted only `undefined` as "exit code not observed". The
 * capture layer writes `null`: core.js stores
 * `exit_code: code === null && failed ? 1 : code`, so a command that ran with
 * nothing signalling failure lands in the log as `{ exit_code: null,
 * failed: false }`. Measured against this tool's own event log on 2026-10-28,
 * 9,210 of 9,358 captured commands — 98.4% of every command orunmila has ever
 * recorded — carry exactly that shape, and every one was being filed as a
 * FAILURE. The law fired on turns whose suite had plainly gone green, and the
 * findings listed those passing commands back to the user under
 * `failed_commands`.
 *
 * Every other test in this file builds its events by hand with an explicit
 * `exit_code: 0`. That is precisely why none of them ever caught it, and why
 * this one asserts on the shape the capture layer actually writes.
 */
it('receipts: an unobserved exit code that nothing flagged as failed is NOT a failure', () => {
  const r = buildReceipts([
    { type: 'command_run', command: 'npm test', exit_code: null, failed: false, stdout_excerpt: '15/15 passed' },
  ]);
  assert.strictEqual(r.passingCommands.length, 1, 'the shape the capture layer actually writes');
  assert.strictEqual(r.failedCommands.length, 0, 'an unobserved exit is not evidence of failure');
});

it('receipts: an unobserved exit code that WAS flagged failed is still a failure', () => {
  const r = buildReceipts([
    { type: 'command_run', command: 'npm test', exit_code: null, failed: true, stdout_excerpt: '1 failing' },
  ]);
  assert.strictEqual(r.passingCommands.length, 0);
  assert.strictEqual(r.failedCommands.length, 1, 'failed:true still means failed');
});

it('receipts: a real captured passing command licenses a green claim end to end', () => {
  const res = evaluateTurn({
    claimText: 'Tests pass.',
    turnEvents: [{ type: 'command_run', command: 'npm test', exit_code: null, failed: false, stdout_excerpt: '15/15 passed' }],
    laws: GREEN_LAW(),
  });
  assert.deepStrictEqual(res.findings, [], 'a command captured the way the hooks capture it is a receipt');
});

// --- exit-code integrity ----------------------------------------------------
//
// Found by running orunmila's own close-out gate over the session that built
// this file: three test runs failed and §2b reported "none", because each had
// been piped through grep or tail and the pipeline reported the LAST stage's
// exit code. A verification law that trusts that zero certifies the failure.

it('pipes: an unguarded pipeline launders the exit code; pipefail and || do not', () => {
  assert.strictEqual(hasUnguardedPipe('npm test | tail -5'), true);
  assert.strictEqual(hasUnguardedPipe('npm test 2>&1 | grep -E "FAIL"'), true);
  assert.strictEqual(hasUnguardedPipe('npm test'), false);
  assert.strictEqual(hasUnguardedPipe('npm test || echo failed'), false, '|| is a logical OR, not a pipeline');
  assert.strictEqual(hasUnguardedPipe('set -o pipefail; npm test | tail -5'), false, 'pipefail restores the meaning');
  assert.strictEqual(hasUnguardedPipe('echo "a|b"'), false, 'a pipe inside quotes is an argument, not a pipeline');
});

it('pipes: a piped green run does NOT license a green claim, and the finding says why', () => {
  const laws = CANON().filter((l) => l.id === 'no-green-without-command');
  const res = evaluateTurn({
    // The exact shape from the build session: the suite is piped to grep, so
    // the recorded exit code is grep's, and it is 0 whatever the suite did.
    claimText: 'The tests pass and debit.ts is correct.',
    turnEvents: [{ type: 'command_run', command: 'npm test 2>&1 | grep -E "FAIL|passed"', exit_code: 0, stdout_excerpt: '' }],
    laws,
  });
  assert.strictEqual(res.findings.length > 0, true, 'a laundered zero must not certify green');
  assert.deepStrictEqual(
    res.findings[0].evidence.exit_code_laundered_by_pipe,
    ['npm test 2>&1 | grep -E "FAIL|passed"'],
    'and the finding names the pipeline responsible'
  );
  assert.strictEqual(res.receipts.unreliable_commands, 1);
});

it('pipes: the same run un-piped does license the claim', () => {
  const laws = CANON().filter((l) => l.id === 'no-green-without-command');
  const res = evaluateTurn({
    claimText: 'The tests pass and debit.ts is correct.',
    turnEvents: [{ type: 'command_run', command: 'npm test', exit_code: 0, stdout_excerpt: '14/14 suites passed' }],
    laws,
  });
  assert.deepStrictEqual(res.findings, [], 'an honest exit code is honest evidence');
});

it('pipes: a piped command is still a CONTENT receipt, just not a proof of green', () => {
  const r = buildReceipts([
    { type: 'command_run', command: 'cat src/wallet/refund.ts | head -40', exit_code: 0, stdout_excerpt: 'export function refund()' },
  ]);
  assert.strictEqual(receiptStrength({ kind: 'path', value: 'refund.ts' }, r), 'full', 'the output really did show the file');
  assert.strictEqual(r.passingCommands.length, 0, 'but it certifies nothing about passing');
  assert.strictEqual(r.unreliableCommands.length, 1);
});

// --- capture-level proof (not just the reader's opinion of the reader) ------
//
// The two tests above prove the EVALUATOR grades read_kind correctly. They say
// nothing about whether the capture layer ever writes it. These drive the real
// Claude Code hook script end to end and read the resulting event log back.

function captureToolEvent(payload) {
  const home = tmpHome();
  const res = run('src/capture/claude-code/post-tool-use.js', { input: JSON.stringify(payload), env: { ORUNMILA_HOME: home } });
  assert.strictEqual(res.status, 0, `capture hook must never fail the agent (stderr: ${res.stderr})`);
  const logPath = path.join(home, 'events.jsonl');
  const lines = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : [];
  return lines.map((l) => JSON.parse(l));
}

it('capture: a Grep tool call is written to the log as read_kind "pattern"', () => {
  const events = captureToolEvent({
    session_id: 'sess-grep',
    tool_name: 'Grep',
    tool_input: { pattern: 'tier_snapshot_at_issue' },
    tool_response: {},
  });
  const read = events.find((e) => e.type === 'file_read');
  assert.ok(read, 'a pattern read is still recorded as file_read: ' + JSON.stringify(events));
  assert.strictEqual(read.read_kind, 'pattern', 'and now carries the distinction that used to be discarded');
});

it('capture: a Read tool call is written to the log as read_kind "full"', () => {
  const events = captureToolEvent({
    session_id: 'sess-read',
    tool_name: 'Read',
    tool_input: { file_path: __filename },
    tool_response: {},
  });
  const read = events.find((e) => e.type === 'file_read');
  assert.ok(read, 'a full read is recorded');
  assert.strictEqual(read.read_kind, 'full');
  assert.ok(read.hash, 'and still carries its content hash — the old proxy is unchanged, not replaced');
});

it('capture: tool RESULTS are not written unless explicitly opted into', () => {
  const home = tmpHome();
  const payload = JSON.stringify({
    session_id: 'sess-tool',
    tool_name: 'mcp__supabase__execute_sql',
    tool_input: { query: 'select * from users' },
    tool_response: { rows: [{ email: 'someone@example.com' }] },
  });

  const off = run('src/capture/claude-code/post-tool-use.js', { input: payload, env: { ORUNMILA_HOME: home } });
  assert.strictEqual(off.status, 0);
  let log = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8');
  assert.ok(!/someone@example\.com/.test(log), 'a tool result must not reach the plaintext log by default');
  assert.ok(/execute_sql/.test(log), 'but the call itself is recorded');

  const home2 = tmpHome();
  const on = run('src/capture/claude-code/post-tool-use.js', {
    input: payload,
    env: { ORUNMILA_HOME: home2, ORUNMILA_CAPTURE_TOOL_RESULTS: '1' },
  });
  assert.strictEqual(on.status, 0);
  log = fs.readFileSync(path.join(home2, 'events.jsonl'), 'utf8');
  assert.ok(/someone@example\.com/.test(log), 'and IS captured once the user opts in, knowingly');
});

// --- read_kind, the additive capture field ----------------------------------

it('read_kind: a Grep tool call is a weak receipt even when it carries a hash', () => {
  // The capture layer now records read_kind, so the hash proxy is no longer the
  // only signal — and where the two disagree, the explicit field wins.
  const r = buildReceipts([
    { type: 'file_read', path: 'src/wallet/debit.ts', hash: 'abc', bytes: 10, read_kind: 'pattern' },
  ]);
  assert.strictEqual(receiptStrength({ kind: 'path', value: 'debit.ts' }, r), 'weak');
});

it('read_kind: history captured before the field existed still grades correctly', () => {
  const r = buildReceipts([
    { type: 'file_read', path: 'src/wallet/debit.ts', hash: 'abc', bytes: 10 }, // old full read
    { type: 'file_read', path: '**/*.ts' },                                      // old glob
  ]);
  assert.strictEqual(receiptStrength({ kind: 'path', value: 'debit.ts' }, r), 'full');
  assert.strictEqual(receiptStrength({ kind: 'path', value: '*.ts' }, r), 'weak');
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

// --- the run-time gate ------------------------------------------------------

const { decideForTurn, runGate } = require('../src/laws/gate');
const { getAdapter } = require('../src/capture/agents');

// A turn that claims green with no passing command — the one shape measured
// precise enough to be worth stopping (8 firings in 1,174 real turns, all real).
const GREEN_LIE = {
  claimText: 'Full suite green, 1463 tests pass, and debit.ts is correct.',
  turnEvents: [{ type: 'file_read', path: '/repo/src/wallet/debit.ts', hash: 'abc', bytes: 100 }],
};

it('gate: a clean turn produces no output at all', () => {
  tmpHome();
  const out = decideForTurn({
    sessionId: 's1',
    turnId: 't1',
    claimText: 'I read src/wallet/debit.ts and it debits the annual wallet first.',
    turnEvents: [{ type: 'file_read', path: '/repo/src/wallet/debit.ts', hash: 'abc', bytes: 100 }],
    root: tmpDir(),
  });
  assert.strictEqual(out, null, 'silence is the common case and must cost nothing');
});

it('gate: an unbacked green claim blocks the turn, and the reason tells the agent what to do', () => {
  tmpHome();
  const out = decideForTurn({ sessionId: 's2', turnId: 't1', ...GREEN_LIE, root: tmpDir() });
  assert.strictEqual(out.decision, 'block');
  assert.ok(/no-green-without-command/.test(out.reason), out.reason);
  assert.ok(/answer again/i.test(out.reason), 'the reason must be actionable, not just an accusation');
});

it('gate: a warn-only finding advises without stopping the turn', () => {
  tmpHome();
  const out = decideForTurn({
    sessionId: 's3',
    turnId: 't1',
    // no receipt for dispatch.ts — a warn law, never a block
    claimText: 'The router in dispatch.ts already handles the retry case.',
    turnEvents: [],
    root: tmpDir(),
  });
  assert.ok(out && out.hookSpecificOutput, 'advisory, not a block: ' + JSON.stringify(out));
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'Stop');
  assert.ok(/advisory/i.test(out.hookSpecificOutput.additionalContext));
  assert.strictEqual(out.decision, undefined, 'a warn law must never stop a turn');
});

it('gate: the block budget prevents the loop trap, and says so instead of going quiet', () => {
  tmpHome();
  const root = tmpDir();
  const args = { sessionId: 's4', turnId: 't1', ...GREEN_LIE, root };

  assert.strictEqual(decideForTurn(args).decision, 'block', 'block 1 of 2');
  assert.strictEqual(decideForTurn(args).decision, 'block', 'block 2 of 2');

  const third = decideForTurn(args);
  assert.strictEqual(third.decision, undefined, 'budget spent — it must stand down rather than pin the agent');
  const text = third.hookSpecificOutput.additionalContext;
  assert.ok(/standing down/i.test(text), 'and it must SAY it stood down: ' + text);
  assert.ok(/UNRESOLVED, not forgiven/.test(text), 'a silenced law must not read as a pass');
  rmrf(root);
});

it('gate: the budget is per turn, so the next turn is judged fresh', () => {
  tmpHome();
  const root = tmpDir();
  decideForTurn({ sessionId: 's5', turnId: 't1', ...GREEN_LIE, root });
  decideForTurn({ sessionId: 's5', turnId: 't1', ...GREEN_LIE, root });
  const nextTurn = decideForTurn({ sessionId: 's5', turnId: 't2', ...GREEN_LIE, root });
  assert.strictEqual(nextTurn.decision, 'block', 'a spent budget must not disarm the rest of the session');
  rmrf(root);
});

it('gate: ORUNMILA_LAWS=off disables it entirely', () => {
  tmpHome();
  const prev = process.env.ORUNMILA_LAWS;
  process.env.ORUNMILA_LAWS = 'off';
  try {
    const out = runGate({ session_id: 's6', claim: GREEN_LIE.claimText }, getAdapter('claude-code'), { root: tmpDir() });
    assert.strictEqual(out, null, 'the kill switch must be absolute');
  } finally {
    if (prev === undefined) delete process.env.ORUNMILA_LAWS;
    else process.env.ORUNMILA_LAWS = prev;
  }
});

it('gate: a turn with no claim text is never judged', () => {
  tmpHome();
  assert.strictEqual(runGate({ session_id: 's7' }, getAdapter('claude-code'), { root: tmpDir() }), null);
});

it('gate hook: exits 0 and emits valid JSON for a blocking turn', () => {
  const home = tmpHome();
  const res = run('src/capture/claude-code/law-gate.js', {
    input: JSON.stringify({ session_id: 's8', claim: GREEN_LIE.claimText }),
    env: { ORUNMILA_HOME: home },
  });
  assert.strictEqual(res.status, 0, 'a non-zero exit from a Stop hook blocks the agent by itself');
  const out = JSON.parse(res.stdout);
  assert.strictEqual(out.decision, 'block');
});

it('gate hook: exits 0 silently on garbage input rather than refusing the turn', () => {
  const home = tmpHome();
  const res = run('src/capture/claude-code/law-gate.js', { input: 'not json at all{{{', env: { ORUNMILA_HOME: home } });
  assert.strictEqual(res.status, 0, 'a broken law engine may stop enforcing; it may never stop the agent');
  assert.strictEqual(res.stdout.trim(), '', 'and it must say nothing rather than something malformed');
});

// --- receipt matching: a path is the same path however it is spelled ---------
// Found by Opon firing on the turn that HAD run the command it wanted: prose
// wrote `~/tools/…`, the shell printed the absolute path, and the raw substring
// match read real evidence as no evidence at all.

it("a ~ path in a claim matches a receipt holding the absolute path, and vice versa", () => {
  const { covers } = require("../src/laws/evaluate");
  const home = require("os").homedir();
  const receipt = `readlink -f /usr/local/bin/orunmila\n${home}/tools/orunmila/bin/orunmila.js`;
  const target = (value) => ({ kind: "path", value });
  assert.ok(covers(receipt, target("~/tools/orunmila/bin/orunmila.js")), "tilde claim vs absolute receipt");
  assert.ok(covers(receipt, target(`${home}/tools/orunmila/bin/orunmila.js`)), "absolute claim vs absolute receipt");
  assert.ok(covers("cat ~/tools/orunmila/bin/orunmila.js", target(`${home}/tools/orunmila/bin/orunmila.js`)), "absolute claim vs tilde receipt");
  assert.ok(!covers(receipt, target("~/some/other/project/file.js")), "and it must NOT start matching unrelated paths");
});

it("a Unicode arrow in a claim does not hide a receipt written with ->", () => {
  const { covers } = require("../src/laws/evaluate");
  const receipt = "ls -la /usr/local/lib/node_modules\norunmila -> /Users/x/tools/orunmila";
  assert.ok(covers(receipt, { kind: "literal", value: "orunmila → /Users/x/tools/orunmila" }));
});

// --- P0-4: stale claim text -------------------------------------------------
// runGate takes its claim from lastAssistantText(transcript_path). When Stop
// fires before the host has flushed THIS turn's final assistant message, that
// returns the PREVIOUS turn's text and the gate judges words the agent did not
// write in the turn being judged. Measured in a real session: two consecutive
// turns captured byte-identical claims and the gate re-flagged a sentence that
// had already been retracted.

const turnstate = require('../src/capture/turnstate');

/** Advance a session from its current turn to the next one, as a real turn does. */
function nextTurn(sid) {
  turnstate.closeTurn(sid);
  return turnstate.advanceIfClosed(sid);
}

it('P0-4: an identical claim on the next turn is not judged again', () => {
  tmpHome();
  const root = tmpDir();
  const sid = 'p04-a';

  const first = runGate({ session_id: sid, claim: GREEN_LIE.claimText }, getAdapter('claude-code'), { root });
  assert.ok(first && first.decision === 'block', 'precondition: this claim blocks on its own turn');

  nextTurn(sid);
  const second = runGate({ session_id: sid, claim: GREEN_LIE.claimText }, getAdapter('claude-code'), { root });
  assert.strictEqual(second, null, 'the same text one turn later is stale, not a new claim');
  rmrf(root);
});

it('P0-4: the skip is recorded, so it is measurable rather than silent', () => {
  tmpHome();
  const root = tmpDir();
  const sid = 'p04-b';
  runGate({ session_id: sid, claim: GREEN_LIE.claimText }, getAdapter('claude-code'), { root });
  const turn = nextTurn(sid);
  runGate({ session_id: sid, claim: GREEN_LIE.claimText }, getAdapter('claude-code'), { root });

  const statePath = path.join(process.env.ORUNMILA_HOME, 'laws-state', sid, `t${turn}.json`);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.strictEqual(state.skipped_stale_claim, true, 'declining to judge must leave a trace');
  assert.ok(state.claim_fp, 'and the fingerprint it declined on');
  rmrf(root);
});

it('P0-4: a genuinely new claim on the next turn is still judged', () => {
  tmpHome();
  const root = tmpDir();
  const sid = 'p04-c';
  runGate({ session_id: sid, claim: GREEN_LIE.claimText }, getAdapter('claude-code'), { root });
  nextTurn(sid);
  const out = runGate(
    { session_id: sid, claim: 'Full suite green, 999 tests pass, and wallet.ts is correct.' },
    getAdapter('claude-code'), { root }
  );
  assert.ok(out && out.decision === 'block', 'different text is a real claim and must still block');
  rmrf(root);
});

it('P0-4: the very first turn has no predecessor and is judged normally', () => {
  tmpHome();
  const root = tmpDir();
  const out = runGate({ session_id: 'p04-d', claim: GREEN_LIE.claimText }, getAdapter('claude-code'), { root });
  assert.ok(out && out.decision === 'block', 't1 must never be treated as a repeat');
  rmrf(root);
});

it('P0-4: recording the fingerprint does not clobber the block counter', () => {
  tmpHome();
  const root = tmpDir();
  const sid = 'p04-e';
  runGate({ session_id: sid, claim: GREEN_LIE.claimText }, getAdapter('claude-code'), { root });
  const statePath = path.join(process.env.ORUNMILA_HOME, 'laws-state', sid, 't1.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.strictEqual(state.blocks, 1, 'the block budget survives the fingerprint write');
  assert.ok(Array.isArray(state.law_ids) && state.law_ids.length, 'and so does the law list');
  assert.ok(state.claim_fp, 'alongside the fingerprint');
  rmrf(root);
});

runAll('laws (layers 4 + 5)');
