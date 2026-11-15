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

// P0-4's repeat skip is removed (O, 2026-11-13). The claim now comes from the
// Stop payload, so an identical claim on the next turn is a real restatement,
// and the block budget, not the skip, is what stops a loop.
it('P0-4: an identical claim on the next turn is judged again', () => {
  tmpHome();
  const root = tmpDir();
  const sid = 'p04-a';

  const first = runGate({ session_id: sid, claim: GREEN_LIE.claimText }, getAdapter('claude-code'), { root });
  assert.ok(first && first.decision === 'block', 'precondition: this claim blocks on its own turn');

  const turn = nextTurn(sid);
  const second = runGate({ session_id: sid, claim: GREEN_LIE.claimText }, getAdapter('claude-code'), { root });
  assert.ok(second && second.decision === 'block', 'restating the claim unchanged does not get it past the gate');
  const state = JSON.parse(fs.readFileSync(path.join(process.env.ORUNMILA_HOME, 'laws-state', sid, `t${turn}.json`), 'utf8'));
  assert.strictEqual(state.skipped_stale_claim, undefined, 'and no repeat skip is recorded');
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

// --- the block budget across Stop re-fires ----------------------------------
// Every Stop opens a new turn: the stop phase's own write advances a turn the
// previous Stop closed (turnstate.js). A budget counted per turn restarted on
// every re-fire after a block, so the loop trap stayed open: in the delta check
// of b2b3274 one claim, re-sent with varied text, blocked 6 Stops of 6. These
// drive the real hook scripts in the order the host runs them.

const { DEFAULT_BLOCK_BUDGET } = require('../src/laws/gate');

function hookSequence(sid) {
  const home = tmpHome();
  const root = tmpDir();
  const env = { ORUNMILA_HOME: home, ORUNMILA_LAWS: '', ORUNMILA_LAW_BLOCK_BUDGET: '', ORUNMILA_TURN_BOUNDARIES: '' };
  const send = (script, payload) =>
    run(`src/capture/claude-code/${script}`, { input: JSON.stringify(Object.assign({ session_id: sid }, payload)), env, cwd: root });
  let n = 0;
  return {
    home,
    root,
    env,
    send,
    prompt: (text) => send('user-prompt-submit.js', { prompt: text }),
    // Varied text each time: a reworded claim is what the budget is built for.
    stop() {
      const claim = `Full suite green, ${1463 + n++} tests pass, and debit.ts is correct.`;
      send('stop.js', { claim });
      const res = send('law-gate.js', { claim });
      assert.strictEqual(res.status, 0, 'the gate hook always exits 0');
      return res.stdout.trim() ? JSON.parse(res.stdout) : null;
    },
    done: () => { rmrf(root); rmrf(home); },
  };
}

const isBlock = (out) => Boolean(out && out.decision === 'block');
const standsDown = (out) =>
  Boolean(out && out.hookSpecificOutput && /standing down/i.test(out.hookSpecificOutput.additionalContext));

it('gate hook: the block budget holds across Stop re-fires when no new prompt arrives', () => {
  const h = hookSequence('budget-a');
  h.prompt('fix debit.ts');
  const outs = [1, 2, 3, 4].map(() => h.stop());
  const blocks = outs.filter(isBlock).length;
  assert.strictEqual(blocks, DEFAULT_BLOCK_BUDGET, `${blocks} blocks in 4 Stops after one prompt; the budget is ${DEFAULT_BLOCK_BUDGET}`);
  for (const out of outs.slice(DEFAULT_BLOCK_BUDGET)) {
    assert.ok(standsDown(out), 'past the budget it stands down and says so: ' + JSON.stringify(out));
  }
  h.done();
});

it('gate hook: a claim restated unchanged after a block is blocked again until the budget is spent', () => {
  const h = hookSequence('budget-c');
  h.prompt('fix debit.ts');
  const outs = [1, 2, 3].map(() => {
    h.send('stop.js', { claim: GREEN_LIE.claimText });
    const res = h.send('law-gate.js', { claim: GREEN_LIE.claimText });
    return res.stdout.trim() ? JSON.parse(res.stdout) : null;
  });
  assert.deepStrictEqual(outs.map(isBlock), [true, true, false], 'blocked twice, then the budget is spent');
  assert.ok(standsDown(outs[2]), 'and it says it stood down: ' + JSON.stringify(outs[2]));
  h.done();
});

it('gate hook: a new user prompt gets a fresh block budget', () => {
  const h = hookSequence('budget-b');
  h.prompt('fix debit.ts');
  for (let i = 0; i < DEFAULT_BLOCK_BUDGET; i++) assert.ok(isBlock(h.stop()), `block ${i + 1} of the first prompt`);
  assert.ok(standsDown(h.stop()), 'the first prompt\'s budget is spent');
  h.prompt('now fix wallet.ts');
  assert.ok(isBlock(h.stop()), 'a new prompt is judged with a fresh budget');
  h.done();
});

// NF54: Claude Code also fires UserPromptSubmit for prompts it writes itself (a
// background task's notification, a sub-agent's hand-back). Counted as
// messages, they refilled the budget, so an agent could reset its own limit.
const TASK_NOTE = '<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n</task-notification>';
const HAND_BACK = '<agent-message from="abc123">\n[Subagent hand-back] The report follows:\n  done\n</agent-message>';

it('gate hook: a task notification or a sub-agent hand-back does not refill the block budget (NF54)', () => {
  const h = hookSequence('budget-d');
  h.prompt('fix debit.ts');
  for (let i = 0; i < DEFAULT_BLOCK_BUDGET; i++) assert.ok(isBlock(h.stop()), `block ${i + 1}`);
  h.prompt(TASK_NOTE);
  assert.ok(standsDown(h.stop()), 'a task notification is not a message from the user');
  h.prompt(HAND_BACK);
  assert.ok(standsDown(h.stop()), 'nor is a sub-agent hand-back');
  h.prompt('Please look at the <task-notification> tag in the log.');
  assert.ok(isBlock(h.stop()), 'a person\'s message that merely mentions the tag still counts');
  h.prompt('\n' + TASK_NOTE);
  h.stop(); // the second block of this message's budget
  assert.ok(standsDown(h.stop()), 'a host prompt with leading whitespace does not refill it either');
  h.done();
});

it('gate hook: before any message is counted, blocks share one budget instead of refilling every turn', () => {
  const h = hookSequence('budget-e');
  h.prompt(TASK_NOTE); // the session's first prompt is one the host wrote
  assert.deepStrictEqual([h.stop(), h.stop(), h.stop()].map(isBlock), [true, true, false], 'after a host prompt');
  const g = hookSequence('budget-f'); // no prompt hook has fired at all
  assert.deepStrictEqual([g.stop(), g.stop(), g.stop()].map(isBlock), [true, true, false], 'with no prompt at all');
  h.done();
  g.done();
});

// --- test 40: the N10 race, on both witnesses' consumers --------------------
// When Claude Code's Stop hook fires, the transcript can still end on an
// earlier assistant block of the turn (5 of 5 probe runs, Phase 0 re-run). The
// Stop payload's last_assistant_message is the turn's final text. Neither the
// gate nor the Glove's claim mark may take the stale transcript text (N10,
// NF23); with no final text in the payload, both record the skip.

const CLEAN_FINAL = 'I read src/wallet/debit.ts and it debits the annual wallet first.';

/** A Claude Code transcript whose newest assistant block is `text`. */
function transcriptWith(dir, text) {
  const file = path.join(dir, 'transcript.jsonl');
  const line = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
  fs.writeFileSync(file, JSON.stringify(line) + '\n');
  return file;
}

/** One Stop through the real hooks: capture, then the gate. */
function stopThroughHooks(payload, { agent = 'claude-code' } = {}) {
  const home = tmpHome();
  const root = tmpDir();
  const env = { ORUNMILA_HOME: home, ORUNMILA_LAWS: '', ORUNMILA_LAW_BLOCK_BUDGET: '', ORUNMILA_TURN_BOUNDARIES: '' };
  const input = JSON.stringify(Object.assign({ transcript_path: transcriptWith(root, GREEN_LIE.claimText) }, payload));
  const capture = agent === 'claude-code'
    ? run('src/capture/claude-code/stop.js', { input, env, cwd: root })
    : run('src/capture/connector.js', { input, env, cwd: root, args: [agent, 'stop'] });
  assert.strictEqual(capture.status, 0);
  const gate = agent === 'claude-code' ? run('src/capture/claude-code/law-gate.js', { input, env, cwd: root }) : null;
  if (gate) assert.strictEqual(gate.status, 0, 'the gate hook always exits 0');
  const events = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const lawState = (turn) => {
    const p = path.join(home, 'laws-state', payload.session_id, `${turn}.json`);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  };
  return {
    gate: gate && gate.stdout.trim() ? JSON.parse(gate.stdout) : null,
    claim: events.find((e) => e.type === 'turn_claim'),
    lawState,
    done: () => { rmrf(root); rmrf(home); },
  };
}

it('test 40: in the N10 race neither the gate nor the Glove\'s claim mark takes the stale transcript text', () => {
  const r = stopThroughHooks({ session_id: 't40-a', last_assistant_message: CLEAN_FINAL });
  assert.ok(!isBlock(r.gate), 'the stale green claim must not be judged: ' + JSON.stringify(r.gate));
  assert.ok(!JSON.stringify(r.gate || {}).includes('1463 tests pass'), 'nothing the gate says quotes the stale block');
  assert.strictEqual(r.claim.text, CLEAN_FINAL, 'the Glove records the final text, not the stale block');
  r.done();
});

it('test 40: with no final text in the Stop payload, neither judges the transcript and both record the skip', () => {
  const r = stopThroughHooks({ session_id: 't40-b' });
  assert.strictEqual(r.gate, null, 'transcript text alone cannot be confirmed as this turn\'s');
  assert.strictEqual((r.lawState('t1') || {}).skipped_unconfirmed_claim, true, 'the gate leaves a trace of the skip');
  assert.strictEqual(r.claim.text, '', 'the Glove records no claim text');
  assert.strictEqual(r.claim.claim_unconfirmed, true, 'and marks the claim unconfirmed, so the skip is countable');
  r.done();
});

it('test 40: an unraced turn is still judged on its final text', () => {
  const r = stopThroughHooks({ session_id: 't40-c', last_assistant_message: GREEN_LIE.claimText });
  assert.ok(isBlock(r.gate), 'the turn really ended on an unbacked green claim: ' + JSON.stringify(r.gate));
  assert.strictEqual(r.claim.text, GREEN_LIE.claimText);
  assert.strictEqual(r.claim.claim_unconfirmed, undefined, 'a confirmed claim carries no skip mark');
  r.done();
});

it('test 40: another agent\'s Stop still reads the transcript (its payloads are not measured)', () => {
  const r = stopThroughHooks({ session_id: 't40-d' }, { agent: 'cursor' });
  assert.strictEqual(r.claim.text, GREEN_LIE.claimText, 'cursor keeps the transcript claim it had before');
  assert.strictEqual(r.claim.claim_unconfirmed, undefined);
  r.done();
});

// --- NF62: the Stop hooks' order ----------------------------------------------
// Claude Code may run the two Stop hooks in parallel (NF8). On a Stop with no
// prompt or tool call before it, the turn counter still points at the previous
// turn, closed, until stop.js advances it. A gate that ran first judged the new
// claim against that turn's records and overwrote its record: in session
// dc5716d4, t6's record held t7's claim, t10's t11's and t12's t13's.

it('NF62: a Stop with nothing before it is judged as its own turn, whichever Stop hook runs first', () => {
  const fp = (text) => require('crypto').createHash('sha256').update(text).digest('hex').slice(0, 16);
  const A = 'Tests pass.';
  const B = GREEN_LIE.claimText;
  for (const order of [['law-gate.js', 'stop.js'], ['stop.js', 'law-gate.js']]) {
    const sid = `nf62-${order[0]}`;
    const h = hookSequence(sid);
    h.prompt('fix debit.ts');
    h.send('post-tool-use.js', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: '17/17 passed', exit_code: 0 } });
    // Both Stops run in the order under test: A ends a turn in flight, B follows with nothing between.
    const stopInOrder = (text) => {
      const outs = {};
      for (const script of order) outs[script] = h.send(script, { last_assistant_message: text });
      return outs['law-gate.js'].stdout.trim() ? JSON.parse(outs['law-gate.js'].stdout) : null;
    };
    assert.strictEqual(stopInOrder(A), null, 'precondition: A is backed by its own run');
    const gate = stopInOrder(B);
    const record = (turn) => {
      const p = path.join(h.home, 'laws-state', sid, `${turn}.json`);
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    };
    const events = fs.readFileSync(path.join(h.home, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const ran = order.join(' then ');
    assert.deepStrictEqual(events.filter((e) => e.type === 'turn_claim').map((e) => e.turn_id), ['t1', 't2'], `${ran}: capture puts B in t2`);
    assert.strictEqual(record('t1').claim_fp, fp(A), `${ran}: A's record keeps A's claim`);
    assert.strictEqual(record('t2').claim_fp, fp(B), `${ran}: B has a record of its own`);
    assert.ok(isBlock(gate), `${ran}: B ran nothing, so its green claim is judged on its own records and blocks: ` + JSON.stringify(gate));
    h.done();
  }
});

// NF63: with the two Stop hooks at once, one can read turn.json while the other
// writes it. A plain write truncates the file first, and a read in that window
// finds it empty and falls back to turn 1.
it('NF63: a hook reading turn.json while another writes it never sees a broken file', () => {
  const home = tmpHome();
  const sid = 'nf63';
  const target = path.join(home, 'cache', sid, 'turn.json');
  turnstate.bumpTurn(sid);
  nextTurn(sid); // now on t2
  const realWrite = fs.writeFileSync;
  const seen = [];
  fs.writeFileSync = function (file, ...rest) {
    if (path.resolve(String(file)) === target) realWrite.call(fs, file, ''); // what a plain write does first
    seen.push(turnstate.turnId(sid)); // another hook reads, mid-write
    return realWrite.call(fs, file, ...rest);
  };
  try {
    turnstate.closeTurn(sid, { stop: turnstate.stopKey('done') });
    turnstate.advanceIfClosed(sid);
    turnstate.bumpTurn(sid);
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.ok(seen.length >= 3, 'each write was watched');
  assert.deepStrictEqual(seen, ['t2', 't2', 't3'], 'every read made during a write saw the last whole state');
  assert.strictEqual(turnstate.turnId(sid), 't3');
  rmrf(home);
});

// --- skips are counted and reported (brief Step 5) ---------------------------
// laws --check replays the laws over the log; it cannot see what the live gate
// declined to judge. The gate's own per-turn records can, and test 41's skip
// rate is read from them.

const lawsCheck = (h, sid, extra = []) =>
  run('bin/orunmila.js', { args: ['laws', '--check', '--session', sid, ...extra], env: h.env, cwd: h.root });

it('laws --check counts what the live gate did: turns checked, skipped and blocked', () => {
  const h = hookSequence('count-a');
  h.prompt('fix debit.ts');
  h.stop(); // blocked
  h.stop(); // blocked
  h.stop(); // checked; the budget is spent, so not blocked
  h.send('stop.js', {});
  h.send('law-gate.js', {}); // no final text: skipped
  for (let i = 0; i < 2; i++) {
    h.send('stop.js', { claim: CLEAN_FINAL });
    h.send('law-gate.js', { claim: CLEAN_FINAL }); // checked both times: a repeat is judged again
  }
  const res = lawsCheck(h, 'count-a');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(
    res.stdout.includes('Live gate: 5 turn(s) checked, 1 skipped (1 with no confirmed text, 0 repeating the last claim), 2 blocked.'),
    res.stdout
  );
  const json = JSON.parse(lawsCheck(h, 'count-a', ['--json']).stdout);
  assert.deepStrictEqual(
    json.live_gate,
    { recorded: true, checked: 5, skipped: 1, skipped_unconfirmed: 1, skipped_repeat: 0, blocked: 2, unreadable: 0, unrecorded: 0 }
  );
  h.done();
});

it('laws --check prints zero skips as 0, and says when the gate left no record', () => {
  const h = hookSequence('count-b');
  h.prompt('fix debit.ts');
  h.stop(); // blocked
  const res = lawsCheck(h, 'count-b');
  assert.ok(
    res.stdout.includes('Live gate: 1 turn(s) checked, 0 skipped (0 with no confirmed text, 0 repeating the last claim), 1 blocked. 0 claimed turn(s) have no gate record of their own.'),
    res.stdout
  );
  const none = lawsCheck(h, 'count-none');
  assert.ok(none.stdout.includes('Live gate: 0 turn(s) checked, 0 skipped'), none.stdout);
  assert.ok(none.stdout.includes('The gate left no record for this session.'), none.stdout);
  h.done();
});

// NF62 left turns with no record, and overwrote others, and the counts above
// could not see either: test 41's skip rate is read with this count beside them.
it('laws --check counts claimed turns the gate holds no record of, an overwritten record included (NF62)', () => {
  const h = hookSequence('count-c');
  h.prompt('fix debit.ts');
  h.stop(); // t1: judged and recorded
  h.send('stop.js', { claim: CLEAN_FINAL }); // t2: captured, but the gate never ran
  h.stop(); // t3: judged and recorded
  const rec = path.join(h.home, 'laws-state', 'count-c', 't3.json');
  fs.writeFileSync(rec, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(rec, 'utf8')), { claim_fp: '0000000000000000' })));
  const res = lawsCheck(h, 'count-c');
  assert.ok(res.stdout.includes(' 2 blocked. 2 claimed turn(s) have no gate record of their own.'), res.stdout);
  assert.strictEqual(JSON.parse(lawsCheck(h, 'count-c', ['--json']).stdout).live_gate.unrecorded, 2);
  h.done();
});

// --- the facts line (plan slice 2), off by default ---------------------------
// Until it is measured, the facts line is opt-in, and with it off the gate must
// print exactly what it printed before the facts line existed. The golden file
// holds that output, recorded at 4ab0595 from hand-built turns.

const { factsLineEnabled } = require('../src/laws/gate');
const GATE_ENV = ['ORUNMILA_FACTS_LINE', 'ORUNMILA_STRICT_PROOF', 'ORUNMILA_LAWS', 'ORUNMILA_LAW_BLOCK_BUDGET', 'ORUNMILA_TURN_BOUNDARIES'];

/** Run fn with these env values (undefined = unset), then put the old ones back. */
function withEnv(values, fn) {
  const prev = {};
  for (const k of Object.keys(values)) {
    prev[k] = process.env[k];
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

it('facts line flag: on only when ORUNMILA_FACTS_LINE is exactly 1', () => {
  for (const [value, on] of [[undefined, false], ['', false], ['0', false], ['on', false], ['true', false], [' 1', false], ['1', true]]) {
    assert.strictEqual(withEnv({ ORUNMILA_FACTS_LINE: value }, factsLineEnabled), on, `ORUNMILA_FACTS_LINE=${JSON.stringify(value)}`);
  }
});

it('facts line and strict proof off: the gate prints exactly what it printed at 4ab0595', () => {
  const { append } = require('../src/store/eventlog');
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'laws', 'gate-output-golden.json'), 'utf8'));
  assert.strictEqual(golden.scenarios.length, 10);
  for (const flag of [undefined, '', '0', 'on']) {
    const clean = Object.fromEntries(GATE_ENV.map((k) => [k, undefined]));
    withEnv(Object.assign(clean, { ORUNMILA_FACTS_LINE: flag, ORUNMILA_STRICT_PROOF: flag }), () => {
      golden.scenarios.forEach((s, i) => {
        const home = tmpHome();
        const root = tmpDir();
        const sid = `golden-${i}`;
        for (const e of s.events) append(Object.assign({ session_id: sid, turn_id: 't1' }, e));
        const out = s.stops.map((p) => JSON.stringify(runGate(Object.assign({ session_id: sid }, p), getAdapter('claude-code'), { root })));
        assert.deepStrictEqual(out, s.out, `${s.name}, ORUNMILA_FACTS_LINE=${JSON.stringify(flag)}`);
        rmrf(root);
        rmrf(home);
      });
    });
  }
});

// The facts themselves: computed from the turn's records only. The agent's prose
// is not an input, so "all green on my end" cannot change what the line says.

const { factsLine } = require('../src/laws/facts');
// Brief line 197: never one witness alone. Commands have only the Glove's record.
const GLOVE_ONLY = ' Sentinel: no record, commands are seen by the Glove only. ';
const NO_FILES = GLOVE_ONLY + 'Files changed this turn, Glove: none; Sentinel: none.';
const cmd = (command, exit_code, extra = {}) => Object.assign({ type: 'command_run', agent: 'claude-code', command, exit_code, failed: exit_code !== 0 && exit_code !== null }, extra);

it('facts: a turn that ran no tests says so, whatever the agent claims', () => {
  const line = factsLine([
    { type: 'file_read', path: '/repo/src/x.js', hash: 'abc' },
    cmd('ls', 0),
    cmd('echo "16 passing"', 0),
  ]);
  assert.ok(line.includes('Test runs this turn: none.'), line);
  assert.strictEqual(factsLine([]), 'Test runs this turn: none.' + NO_FILES);
});

it('facts: each test run is listed with the exit status the record holds', () => {
  const line = factsLine([
    cmd('npm test', null),                                        // Claude Code: null means pass
    cmd('npm test', 1),
    cmd('npx jest', null, { failed: true }),                      // failed, code unknown
    cmd('pytest -q', null, { agent: 'cursor', failed: false }),   // another agent: null means unknown
  ]);
  assert.strictEqual(line, 'Test runs this turn: npm test (pass); npm test (fail, exit 1); npx jest (fail); pytest -q (status unknown).' + NO_FILES);
});

it('facts: a piped run is marked piped; lookalikes are not test runs; a runner after cd or an env prefix is', () => {
  const line = factsLine([
    cmd('npm test | tail -5', 0),
    cmd('echo test', 0),
    cmd('ls test/', 0),
    cmd('mkdir tests', 0),
    cmd('npm run build', 0),
    cmd('cd ../other && npm test', 0),
    cmd('CI=1 node --test test/', 0),
    cmd('echo "a | npm test"', 0),
  ]);
  assert.strictEqual(line, 'Test runs this turn: npm test | tail -5 (pass, piped); cd ../other && npm test (pass); CI=1 node --test test/ (pass).' + NO_FILES);
});

// NF59: a heredoc's body is the command's input, so a commit message line that
// starts "npm test" is not a test run; a runner after the closing line still is.
it('facts: a heredoc body is not a command step (NF59)', () => {
  const commit = "git commit -F - <<'EOF'\nfix: the gate\n\nnpm test 17/17 suites\nEOF";
  assert.strictEqual(factsLine([cmd(commit, 0)]), 'Test runs this turn: none.' + NO_FILES);
  const after = 'cat <<EOF > notes.txt\nnpm test ran\nEOF\nnpm test';
  const opener = 'npm test <<-"END"\n\tinput\n\tEND';
  assert.strictEqual(factsLine([cmd(after, 0), cmd(opener, 0)]), `Test runs this turn: ${after} (pass); ${opener} (pass).` + NO_FILES);
  // A shell fed a heredoc runs its body, so there the body is the command.
  const shell = "bash <<'EOF'\nnpm test\nEOF";
  const remote = 'cd app && ssh ci-box <<EOF\nnpm test\nEOF';
  assert.strictEqual(factsLine([cmd(shell, 0), cmd(remote, 0)]), `Test runs this turn: ${shell} (pass); ${remote} (pass).` + NO_FILES);
  assert.strictEqual(factsLine([cmd("cat > gates.sh <<'EOF'\nnpm test\nEOF", 0)]), 'Test runs this turn: none.' + NO_FILES, 'writing a script runs nothing');
});

it('facts: files changed are counted once each, test files named, paths inside the root shown relative', () => {
  const write = (p) => ({ type: 'file_write', path: p, diff: '' });
  const line = factsLine([
    write('/repo/src/a.js'),
    write('/repo/src/a.js'),
    write('/repo/test/laws.js'),
    write('/repo/src/b.test.ts'),
    write('/elsewhere/test_x.py'),
    write('/repo/src/contest.js'),
  ], { root: '/repo' });
  assert.strictEqual(line, 'Test runs this turn: none.' + GLOVE_ONLY + 'Files changed this turn, Glove: 5 (test files: test/laws.js, src/b.test.ts, /elsewhere/test_x.py); Sentinel: none.');
});

it('facts: the Sentinel\'s writes inside the project are counted beside the Glove\'s, each witness on its own', () => {
  const disk = (p, extra = {}) => Object.assign({ type: 'file_write', source: 'fs-sentinel', session_id: null, path: p }, extra);
  const line = factsLine([{ type: 'file_write', path: '/repo/src/a.js' }], {
    root: '/repo',
    sentinelWrites: [
      disk('/repo/src/a.js'),
      disk('/repo/src/a.js'),
      disk('/repo/test/b.test.js'),
      disk('/other-project/src/c.js'),
      disk('/repo-two/test/d.test.js'),
      { type: 'file_read', source: 'fs-sentinel', path: '/repo/src/e.js' },
      null,
    ],
  });
  assert.strictEqual(line, 'Test runs this turn: none.' + GLOVE_ONLY + 'Files changed this turn, Glove: 1 (test files: none); Sentinel: 2 (test files: test/b.test.js).');
});

// With the switch on, the facts line comes first and the gate's own text follows
// it word for word: every golden output, prefixed and nothing else changed.
const FACTS_HEAD = 'orunmila facts (from the records, not your prose): ';
const stopOut = (text) => ({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: text } });

function goldenWithFacts(check) {
  const { append } = require('../src/store/eventlog');
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'laws', 'gate-output-golden.json'), 'utf8'));
  const clean = Object.fromEntries(GATE_ENV.map((k) => [k, undefined]));
  withEnv(Object.assign(clean, { ORUNMILA_FACTS_LINE: '1' }), () => {
    golden.scenarios.forEach((s, i) => {
      const home = tmpHome();
      const root = tmpDir();
      const sid = `facts-on-${i}`;
      for (const e of s.events) append(Object.assign({ session_id: sid, turn_id: 't1' }, e));
      s.stops.forEach((p, j) => check(s, p, runGate(Object.assign({ session_id: sid }, p), getAdapter('claude-code'), { root }), JSON.parse(s.out[j])));
      rmrf(root);
      rmrf(home);
    });
  });
}

it('facts line on: it comes first, and everything after it is what the gate printed without it, word for word', () => {
  let judged = 0;
  goldenWithFacts((s, p, out, before) => {
    const text = getAdapter('claude-code').fields.finalText(p);
    if (!text || !text.trim()) {
      assert.strictEqual(out, null, `${s.name}: a turn the gate does not judge gets no facts line either`);
      return;
    }
    judged++;
    // A turn with no Glove event gives the Sentinel no window: "not read".
    const facts = FACTS_HEAD + factsLine(s.events, { sentinelWrites: s.events.length ? [] : null });
    if (before === null) assert.deepStrictEqual(out, stopOut(facts), `${s.name}: a turn with no findings gets the facts line alone`);
    else if (before.decision) assert.deepStrictEqual(out, { decision: 'block', reason: `${facts}\n\n${before.reason}` }, s.name);
    else assert.deepStrictEqual(out, stopOut(`${facts}\n\n${before.hookSpecificOutput.additionalContext}`), s.name);
  });
  assert.strictEqual(judged, 10, 'every judged Stop of the golden scenarios was checked');
});

it('facts line on: the line is the turn\'s own records, not the claim', () => {
  const seen = {};
  goldenWithFacts((s, p, out) => { if (out) seen[s.name] = (out.reason || out.hookSpecificOutput.additionalContext).split('\n')[0]; });
  assert.strictEqual(seen['a green claim after a failed run'], `${FACTS_HEAD}Test runs this turn: npm test (fail, exit 1).${NO_FILES}`);
  assert.strictEqual(
    seen['a warn-only finding'],
    `${FACTS_HEAD}Test runs this turn: none.${GLOVE_ONLY}Files changed this turn, Glove: none; Sentinel: not read.`,
    'no Glove event in the turn, so no window to read the Sentinel in'
  );
  assert.strictEqual(
    seen['a turn that wrote a test file and ran the suite'],
    `${FACTS_HEAD}Test runs this turn: npm test (pass).${GLOVE_ONLY}Files changed this turn, Glove: 1 (test files: /repo/test/x.test.js); Sentinel: none.`
  );
});

it('facts line on: the gate reads the Sentinel\'s writes in the turn\'s window, inside the project only', () => {
  const { append } = require('../src/store/eventlog');
  const clean = Object.fromEntries(GATE_ENV.map((k) => [k, undefined]));
  withEnv(Object.assign(clean, { ORUNMILA_FACTS_LINE: '1' }), () => {
    const home = tmpHome();
    const root = tmpDir();
    const sid = 'facts-sentinel';
    const disk = (rel, extra = {}) =>
      append(Object.assign({ session_id: null, turn_id: null, agent: 'fs-sentinel', source: 'fs-sentinel', type: 'file_write', path: path.join(root, rel) }, extra));
    disk('src/before-the-turn.js', { ts: '2000-01-01T00:00:00.000Z' });
    append({ session_id: sid, turn_id: 't1', agent: 'claude-code', type: 'file_write', path: path.join(root, 'src/g.js') });
    append({ session_id: sid, turn_id: 't1', agent: 'claude-code', type: 'file_write', path: path.join(root, 'src/glove-only.js') });
    disk('src/g.js');
    disk('test/s.test.js');
    append({ session_id: null, turn_id: null, agent: 'fs-sentinel', source: 'fs-sentinel', type: 'file_write', path: path.join(root + '-elsewhere', 'x.js') });
    const out = runGate({ session_id: sid, claim: 'I changed src/g.js.' }, getAdapter('claude-code'), { root });
    const first = (out.reason || out.hookSpecificOutput.additionalContext).split('\n')[0];
    assert.strictEqual(
      first,
      `${FACTS_HEAD}Test runs this turn: none.${GLOVE_ONLY}Files changed this turn, Glove: 2 (test files: none); Sentinel: 2 (test files: test/s.test.js).`
    );
    rmrf(root);
    rmrf(home);
  });
});

it('facts: more than five test runs are summarised; a malformed record does not throw', () => {
  const runs = [1, 2, 3, 4, 5, 6, 7].map((n) => cmd(`npm test -- ${n}`, 0));
  const line = factsLine(runs.concat([{ type: 'command_run' }, { type: 'file_write' }, null, 'junk']));
  assert.ok(line.startsWith('Test runs this turn: npm test -- 1 (pass); '), line);
  assert.ok(line.includes('npm test -- 5 (pass); and 2 more.'), line);
  assert.ok(line.endsWith(NO_FILES), line);
});

// --- the reader: an apostrophe inside a word is not a quote mark (NF31) ------
// "isn't ... haven't" paired as a quoted span, so the text between two
// contractions became a literal target ("t updated, and I haven") and the
// receipt law asked for a receipt for it.

const { extractTargets } = require('../src/reconcile/task-extractor');
const literals = (s) => extractTargets(s).filter((t) => t.kind === 'literal').map((t) => t.raw);

it('targets: an apostrophe inside a word opens no quoted span, so no junk literal is extracted (NF31)', () => {
  assert.deepStrictEqual(literals("This machine's copy of that file is owned by the agent's account."), []);
  assert.deepStrictEqual(literals("The done-ledger isn't updated, and I haven't run it."), []);
  assert.deepStrictEqual(literals("That's 2 problems caused by this round, and it's fine."), []);
  assert.deepStrictEqual(literals("The users' sessions and the agents' turns are counted."), []);
  assert.deepStrictEqual(literals("Read the 'agent's notes first."), [], 'a quote never closed does not close on an apostrophe');
});

it('targets: a real single-quoted span is still a literal, an apostrophe inside it included', () => {
  assert.deepStrictEqual(literals("Set the 'retry limit' flag."), ['retry limit']);
  assert.deepStrictEqual(literals("The message now reads 'it's fine' everywhere."), ["it's fine"]);
  assert.deepStrictEqual(literals("The template's line reads 'the tests pass' and nothing ran."), ['the tests pass']);
});

// The reconciler's own mask (claim-extractor.js) reads the words the shared
// reader does not cover ("verified", "works", the action verbs); it paired
// apostrophes the same way, hiding them between two contractions.
const { extractClaims } = require('../src/reconcile/claim-extractor');

it('reconciler: words between two contractions are read, not masked as a quote', () => {
  const [claim] = extractClaims("That's verified now that it's merged.");
  assert.ok(claim, 'the sentence is a claim');
  assert.deepStrictEqual(claim.verificationWords, ['verified']);
});

// NF57: the reconciler's own words matched as substrings and ignored negation,
// so "unverified" counted as "verified" and "Not verified this pass" as a claim.
const verWords = (text) => (extractClaims(text)[0] || { verificationWords: [] }).verificationWords;

it('reconciler: its own verification words match whole words, and a "not" before one cancels it (NF57)', () => {
  assert.deepStrictEqual(verWords('The parser change is unverified.'), []);
  assert.deepStrictEqual(verWords('Not verified this pass: I ran no test suite.'), []);
  assert.deepStrictEqual(verWords('It has not yet been confirmed.'), []);
  assert.deepStrictEqual(verWords("The fix wasn't validated on Windows."), []);
  assert.deepStrictEqual(verWords('The frameworks load in order.'), [], 'a word inside another word is not that word');
});

it('reconciler: a real claim of a check still counts (NF57 guards)', () => {
  assert.deepStrictEqual(verWords('I verified the parser.'), ['verified']);
  assert.deepStrictEqual(verWords('All three fixes confirmed per the log.'), ['confirmed']);
  assert.deepStrictEqual(verWords('Verified: the gate blocks it.'), ['verified']);
  assert.deepStrictEqual(verWords('Nothing works yet.'), ['works'], 'switch off, the four shared words read as before');
});

it('reconciler: a word inside real single quotes is still only mentioned', () => {
  assert.deepStrictEqual(extractClaims("The template's status line reads 'verified' for now."), []);
});

// --- strict proof (plan slice 4.1): which test runs prove a pass ------------
// The green law takes any command that did not fail as proof (NF40): `ls`,
// `npm test || true`, a failed run followed by `echo ok`. proofOfPass reads
// only test runs, and only those whose recorded status means what it says.

const { proofOfPass } = require('../src/laws/proof');
const ran = (command, exit_code = 0, extra = {}) =>
  Object.assign({ type: 'command_run', agent: 'claude-code', command, exit_code, failed: exit_code !== 0 && exit_code !== null }, extra);
const proves = (...events) => proofOfPass(events).proven;

it('proof: the plan\'s probe commands prove nothing', () => {
  for (const events of [
    [ran('echo ok')],
    [ran('ls')],
    [ran('git status')],
    [ran('npm test || true')],
    [ran('npm test; true')],
    [ran('echo "16 passing"')],
    [ran('npm test', 1), ran('echo ok')],
    [ran('echo test')],
    [ran('ls test/')],
    [ran('mkdir tests')],
    [ran('npm run build')],
  ]) {
    assert.strictEqual(proves(...events), false, events.map((e) => e.command).join(' / '));
  }
  assert.strictEqual(proves(ran('cd ../other && npm test')), true, 'a run in another folder still proves until item 10');
});

it('proof: masking, pipes and pipefail are read from the line, not from a word on it (NF52)', () => {
  assert.strictEqual(proves(ran('npm test')), true);
  assert.strictEqual(proves(ran('npm test', null)), true, 'Claude Code: no code and not failed is a pass');
  assert.strictEqual(proves(ran('npm test && echo done')), true, '&& runs the next step only after a pass');
  assert.strictEqual(proves(ran('CI=1 npm test')), true);
  assert.strictEqual(proves(ran('echo x | npm test')), true, 'the runner is the last stage, so the status is its own');
  assert.strictEqual(proves(ran('set -o pipefail; npm test | tail -5')), true);
  assert.strictEqual(proves(ran('set -euo pipefail && npm test | tail')), true);
  assert.strictEqual(proves(ran('npm test > out.txt; echo $?')), false, 'the line exits with echo\'s status');
  assert.strictEqual(proves(ran('npm test;')), true, 'nothing after the ; decides anything');
  assert.strictEqual(proves(ran('npm test\n')), true, 'nor after a trailing new line');
  assert.strictEqual(proves(ran('npm test | tail -5')), false);
  assert.strictEqual(proves(ran('npm test | tail -5; echo ${PIPESTATUS[0]}')), false);
  assert.strictEqual(proves(ran('npm test | tail -5 # pipefail')), false);
  assert.strictEqual(proves(ran('echo "set -o pipefail"; npm test | tail -5')), false, 'quoted, it sets nothing');
  assert.strictEqual(proves(ran('npm test | tail -5; set -o pipefail')), false, 'set after the pipe is too late');
  assert.strictEqual(proves(ran('false || npm test')), false, 'after ||, the runner may never have run');
  assert.strictEqual(proves(ran('pytest', null, { agent: 'cursor', failed: false })), false, 'another agent: no code is unknown');
});

it('proof: a heredoc body is not a test run, and a runner after the heredoc still proves (NF59)', () => {
  const r = proofOfPass([ran("git commit -F - <<'EOF'\nnpm test 17/17\nEOF")]);
  assert.deepStrictEqual(r.runs, [], 'a commit message is not a run');
  assert.strictEqual(proves(ran('cat <<EOF > f\nit\'s a note\nEOF\nnpm test')), true, 'the runner after the closing line is the last step');
  assert.strictEqual(proves(ran('cat <<EOF > f\nnote\nEOF\nnpm test; echo $?')), false, 'and is still read for masking');
});

it('proof: a failed run with no later proving run is not proof, and the result names its runs', () => {
  assert.strictEqual(proves(ran('npm test'), ran('npm test', 1)), false, 'the last run failed');
  assert.strictEqual(proves(ran('npm test', 1), ran('npm test')), true, 'fixed, then run again');
  assert.strictEqual(proves(ran('npm test', 1), ran('npm test || true')), false, 'a masked run after a failure fixes nothing');
  const r = proofOfPass([ran('npm test', 1), ran('npm test | tail -5'), ran('ls'), ran('npm test && echo done')]);
  assert.deepStrictEqual(r.runs.map((x) => x.verdict), ['failed', 'piped', 'proof']);
  assert.strictEqual(r.by, 'npm test && echo done');
  assert.deepStrictEqual(proofOfPass([null, 'junk', { type: 'command_run' }]), { proven: false, by: null, runs: [] });
});

// --- strict proof wired into the gate (plan slice 4.2), switch off by default

const { strictProofEnabled } = require('../src/laws/gate');

it('strict proof switch: on only when ORUNMILA_STRICT_PROOF is exactly 1', () => {
  for (const [value, on] of [[undefined, false], ['', false], ['0', false], ['on', false], ['1', true]]) {
    assert.strictEqual(withEnv({ ORUNMILA_STRICT_PROOF: value }, strictProofEnabled), on, `ORUNMILA_STRICT_PROOF=${JSON.stringify(value)}`);
  }
});

it('strict proof: the green law takes only a proof of pass, and says which runs did not prove one', () => {
  const masked = [ran('npm test; echo $?')];
  const loose = evaluateTurn({ claimText: 'Tests pass.', turnEvents: masked, laws: GREEN_LAW() });
  assert.deepStrictEqual(loose.findings, [], 'today any passing command is the receipt');
  const strict = evaluateTurn({ claimText: 'Tests pass.', turnEvents: masked, laws: GREEN_LAW(), strictProof: true });
  assert.strictEqual(strict.blocking.length, 1, 'strictly, a masked run proves nothing');
  assert.deepStrictEqual(strict.findings[0].evidence.test_runs, ['masked: npm test; echo $?']);
  const proven = evaluateTurn({ claimText: 'Tests pass.', turnEvents: [ran('npm test')], laws: GREEN_LAW(), strictProof: true });
  assert.deepStrictEqual(proven.findings, [], 'a proof of pass licenses the claim');
});

it('strict proof: through the gate the switch decides, and the reason lists the runs', () => {
  const { append } = require('../src/store/eventlog');
  const clean = Object.fromEntries(GATE_ENV.map((k) => [k, undefined]));
  for (const flag of [undefined, '1']) {
    withEnv(Object.assign({}, clean, { ORUNMILA_STRICT_PROOF: flag }), () => {
      const home = tmpHome();
      const root = tmpDir();
      append({ session_id: 'strict-g', turn_id: 't1', type: 'command_run', agent: 'claude-code', command: 'npm test | tail -5', exit_code: 0, failed: false });
      append({ session_id: 'strict-g', turn_id: 't1', type: 'command_run', agent: 'claude-code', command: 'set -o pipefail; npm test | tail -5', exit_code: 1, failed: true });
      const out = runGate({ session_id: 'strict-g', claim: 'Tests pass.' }, getAdapter('claude-code'), { root });
      assert.strictEqual(out.decision, 'block', `blocks either way: the last run failed (switch ${flag})`);
      if (flag) assert.ok(out.reason.includes('  test runs that prove no pass: piped: npm test | tail -5 | failed: set -o pipefail; npm test | tail -5'), out.reason);
      else assert.ok(!out.reason.includes('test runs that prove no pass'), 'off, the reason is as before');
      rmrf(root);
      rmrf(home);
    });
  }
});

it('strict proof: laws --check replays with the same switch as the gate', () => {
  const h = hookSequence('strict-c');
  h.prompt('fix debit.ts');
  h.send('post-tool-use.js', { tool_name: 'Bash', tool_input: { command: 'npm test; echo $?' }, tool_response: { stdout: 'ok' } });
  h.send('stop.js', { claim: 'Tests pass.' });
  const off = run('bin/orunmila.js', { args: ['laws', '--check', '--session', 'strict-c', '--json'], env: h.env, cwd: h.root });
  const on = run('bin/orunmila.js', { args: ['laws', '--check', '--session', 'strict-c', '--json'], env: Object.assign({}, h.env, { ORUNMILA_STRICT_PROOF: '1' }), cwd: h.root });
  const blocking = (res) => JSON.parse(res.stdout).turns.flatMap((t) => t.findings).filter((f) => f.severity === 'block').map((f) => f.law_id);
  assert.deepStrictEqual(blocking(off), [], 'off: the masked run is a passing command');
  assert.deepStrictEqual(blocking(on), ['no-green-without-command'], 'on: it proves nothing');
  h.done();
});

// --- strict proof in the Stain Map (plan slice 4.3), same switch -------------

const { reconcileTurn } = require('../src/reconcile/matcher');
const verdictOf = (turnEvents, opts = {}) => {
  const [c] = reconcileTurn(Object.assign({ promptText: 'go', claimText: 'Tests pass.', turnEvents }, opts)).claims;
  return `${c.outcome} ${c.provenance} ${c.causeHints.join(',')}`.trim();
};

it('strict proof, Stain Map: a run that proves nothing is not a receipt, and says so', () => {
  const masked = [ran('npm test; echo $?')];
  assert.strictEqual(verdictOf(masked, { strictProof: false }), 'verified receipt_matches');
  assert.strictEqual(verdictOf(masked, { strictProof: true }), 'phantom_verification not_sent run-proves-nothing');
  assert.strictEqual(verdictOf([ran('npm test')], { strictProof: true }), 'verified receipt_matches');
  assert.strictEqual(verdictOf([ran('npm test', 1)], { strictProof: true }), 'phantom_verification disregarded_failure error-in-context');
  assert.strictEqual(verdictOf([ran('ls')], { strictProof: true }), 'phantom_verification not_sent no-verification-attempted');
});

it('strict proof, Stain Map: reconcileTurn reads the switch when the caller does not pass it', () => {
  const masked = [ran('npm test; echo $?')];
  assert.strictEqual(withEnv({ ORUNMILA_STRICT_PROOF: undefined }, () => verdictOf(masked)), 'verified receipt_matches');
  assert.strictEqual(withEnv({ ORUNMILA_STRICT_PROOF: '1' }, () => verdictOf(masked)), 'phantom_verification not_sent run-proves-nothing');
});

// --- strict proof: the Stain Map leaves works/working/passing/compiles to the
// shared reader (plan slice 4.4). Its own list matched them as substrings, so
// "Nothing works yet." read as a claim that something works.

it('strict proof, reader: the four words are read by the shared reader, not as substrings', () => {
  const words = (text, strictProof) => (extractClaims(text, { strictProof })[0] || { verificationWords: [] }).verificationWords;
  assert.deepStrictEqual(words('Nothing works yet.', false), ['works'], 'off: as before');
  assert.deepStrictEqual(words('Nothing works yet.', true), [], 'on: no subject says it works');
  assert.deepStrictEqual(words('It is working correctly now.', true), ['working correctly']);
  assert.deepStrictEqual(words('The build compiles.', true), ['build compiles']);
  assert.deepStrictEqual(words('I verified the parser.', true), ['verified'], 'verified, confirmed and validated stay');
  assert.deepStrictEqual(extractClaims('Nothing works yet in parser.js.', { strictProof: true }), [], 'with a target, not a claim either');
});

runAll('laws (layers 4 + 5)');
