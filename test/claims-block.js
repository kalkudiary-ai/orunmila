// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/claims-block.js — the structured claims block (MR1, LD319; brief v4 line 443; spec/claims-block.md). The parser,
 * and the law gate's exact check of each `proved:` command behind ORUNMILA_CLAIMS_BLOCK=1: the declared command must
 * have run in the turn and passed, as one step of a run whose exit status means what it says. Hand-built turns.
 */

const { assert, tmpDir, it, runAll } = require('./helpers');
const { parseClaimsBlock, provedBy } = require('../src/reconcile/claims-block');
const { evaluateTurn } = require('../src/laws/evaluate');
const { loadLaws, activeLaws } = require('../src/laws/load');
const { extractAssertions } = require('../src/laws/assert-extractor');

const laws = activeLaws(loadLaws({ root: tmpDir() }).laws);
const block = (...lines) => ['Done.', '', '```orunmila-claims', ...lines, '```', ''].join('\n');
const run = (command, exit_code = 0) => ({ type: 'command_run', command, exit_code, failed: exit_code !== 0 });
const green = (res) => res.findings.filter((f) => f.law_id === 'no-green-without-command');

it('MR1: the block is read: changed, proved and not done; the last block counts; other lines are errors by number', () => {
  const b = parseClaimsBlock(['```orunmila-claims', 'proved: old', '```', 'later', '```orunmila-claims', 'changed: src/a.js, test/b.js', 'changed: c.md', 'proved: npm test', 'not done: the Windows run', 'tested: yes', '```'].join('\n'));
  assert.deepStrictEqual(b, { changed: ['src/a.js', 'test/b.js', 'c.md'], proved: ['npm test'], not_done: ['the Windows run'], errors: ['line 5 of the block: "tested: yes" is not changed:, proved: or not done:'] });
  assert.strictEqual(parseClaimsBlock('All tests pass.'), null, 'no block');
  assert.strictEqual(parseClaimsBlock('```orunmila-claims\nproved: npm test\n'), null, 'no closing fence: not a block');
});

it("MR1: a run proves a declared command only when the run's exit status is that command's; never through ; after it or ||", () => {
  assert.ok(provedBy('npm test', [{ command: 'cd web && npm test' }]));
  assert.ok(provedBy('npm test', [{ command: 'cd web; npm test' }]), 'a segment before it is fine');
  assert.ok(provedBy('npm  test', [{ command: 'npm test' }]), 'spaces are not words');
  assert.strictEqual(provedBy('npm test', [{ command: 'npm test; echo done' }]), null, "the run's status is echo's");
  assert.strictEqual(provedBy('npm test', [{ command: 'npm test && echo ok || true' }]), null, '|| makes it exit 0 whatever');
  assert.strictEqual(provedBy('npm test', [{ command: 'npm test || true' }]), null);
  assert.strictEqual(provedBy('npm test', [{ command: 'npm run test:unit' }]), null, 'another command is not the declared one');
});

it("MR1: the block's lines are not read again as prose claims", () => {
  assert.deepStrictEqual(extractAssertions(block('proved: npm test')).filter((a) => a.verification), []);
});

it('MR1 (ORUNMILA_CLAIMS_BLOCK=1): a declared command with no passing run is the green law\'s finding; a passing run clears it', () => {
  const none = evaluateTurn({ claimText: block('proved: npm test'), turnEvents: [], laws, claimsBlock: true });
  const f = green(none);
  assert.strictEqual(f.length, 1, JSON.stringify(none.findings));
  assert.strictEqual(f[0].severity, 'block');
  assert.strictEqual(f[0].evidence.declared_command, 'npm test');
  assert.strictEqual(green(evaluateTurn({ claimText: block('proved: npm test'), turnEvents: [run('npm test')], laws, claimsBlock: true })).length, 0);
  const failed = green(evaluateTurn({ claimText: block('proved: npm test'), turnEvents: [run('npm test', 1)], laws, claimsBlock: true }));
  assert.deepStrictEqual(failed[0].evidence.failed_commands, ['exit 1: npm test']);
  const piped = green(evaluateTurn({ claimText: block('proved: npm test'), turnEvents: [run('npm test | tail -5')], laws, claimsBlock: true }));
  assert.deepStrictEqual(piped[0].evidence.exit_code_laundered_by_pipe, ['npm test | tail -5']);
});

it('MR1: with the switch off (the default) a block changes nothing; with it on, prose claims are still read', () => {
  assert.strictEqual(green(evaluateTurn({ claimText: block('proved: npm test'), turnEvents: [], laws })).length, 0);
  const prose = evaluateTurn({ claimText: 'All tests pass.\n\n' + block('proved: npm run lint'), turnEvents: [run('npm run lint')], laws, claimsBlock: true });
  assert.strictEqual(green(prose).length, 0, 'the lint run is a passing command, so the prose claim has its receipt as before');
  const both = evaluateTurn({ claimText: 'All tests pass.\n\n' + block('proved: npm test'), turnEvents: [], laws, claimsBlock: true });
  assert.strictEqual(green(both).length, 2, 'the prose claim and the declared command are each a finding');
});

runAll('claims-block');
