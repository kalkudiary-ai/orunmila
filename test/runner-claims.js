// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/runner-claims.js — F40 (LD392): a claim of a pass that quotes the runner's own count ("`npm test` passed
 * (`1 test passed`)", "Ran `npm test` — **1 test passed**") is a test claim, for every agent, behind
 * ORUNMILA_RUNNER_CLAIMS=1 (off by default: the reader is the live gate's too); "wired" is a work verb with the edit
 * verbs (ORUNMILA_EDIT_VERBS=1). The sentences are the two from test 49's Cursor sessions and made-up ones.
 */

const { assert, it, runAll } = require('./helpers');
const { findExecutionClaims } = require('../src/reconcile/verification-claim');

const withRunner = (on, fn) => {
  const was = process.env.ORUNMILA_RUNNER_CLAIMS;
  if (on) process.env.ORUNMILA_RUNNER_CLAIMS = '1';
  else delete process.env.ORUNMILA_RUNNER_CLAIMS;
  try {
    return fn();
  } finally {
    if (was === undefined) delete process.env.ORUNMILA_RUNNER_CLAIMS;
    else process.env.ORUNMILA_RUNNER_CLAIMS = was;
  }
};

const F40 = ['`npm test` passed (`1 test passed`).', 'Ran `npm test` — **1 test passed**.', 'The suite: **12 tests passing**.', '`pytest` passed: "3 tests passed".'];

it('F40 (LD392): with ORUNMILA_RUNNER_CLAIMS=1, a pass quoted in the runner\'s own count is a test claim; off (the default), as before', () => {
  for (const s of F40) {
    assert.ok(withRunner(true, () => findExecutionClaims(s)).length > 0, `on: ${s}`);
    assert.deepStrictEqual(withRunner(false, () => findExecutionClaims(s)), [], `off: ${s}`);
  }
});

it('F40: still not a claim with the switch on: a quoted phrase that is not a count, a count reported from elsewhere, a count that failed, a negation', () => {
  for (const s of ['the verb is in a future frame (*should work*).', 'The handover says `3 tests passed`.', 'It printed **0 tests passed, 2 failed** so nothing works yet.', 'Done: **3 tests passed, 1 failed**.', 'I did not run it, so no `tests passed` line exists.']) {
    assert.deepStrictEqual(withRunner(true, () => findExecutionClaims(s)), [], s);
  }
});

it('F40 through the claim reader and the gate: with the switch on, the sentence is a verification claim, and a turn with no test run behind it is blocked', () => {
  const code = `
    const { extractClaims } = require('./src/reconcile/claim-extractor');
    const { decideForTurn } = require('./src/laws/gate');
    const c = extractClaims(${JSON.stringify(F40[0])});
    const out = decideForTurn({ sessionId: 's', turnId: 't1', claimText: ${JSON.stringify(F40[1])}, promptText: 'test it', turnEvents: [], root: process.cwd() });
    console.log(JSON.stringify({ verification: c.some((x) => x.verificationClaim), decision: out && out.decision ? out.decision : null }));`;
  const home = require('./helpers').tmpDir();
  const exec = (env) => JSON.parse(require('child_process').execFileSync('node', ['-e', code], { cwd: require('./helpers').ROOT, env: { ...process.env, ORUNMILA_HOME: home, ...env }, encoding: 'utf8' }));
  assert.deepStrictEqual(exec({ ORUNMILA_RUNNER_CLAIMS: '1' }), { verification: true, decision: 'block' });
  assert.deepStrictEqual(exec({ ORUNMILA_RUNNER_CLAIMS: '' }), { verification: false, decision: null });
  require('./helpers').rmrf(home);
});

it('F40: with ORUNMILA_EDIT_VERBS=1, "wired" is a work verb, as "edited" is; off, it is not', () => {
  const code = `const { extractClaims } = require('./src/reconcile/claim-extractor'); console.log(JSON.stringify(extractClaims('I wired the toggle into src/settings.js.').map((c) => c.verbs)));`;
  const exec = (env) => JSON.parse(require('child_process').execFileSync('node', ['-e', code], { cwd: require('./helpers').ROOT, env: { ...process.env, ...env }, encoding: 'utf8' }));
  assert.deepStrictEqual(exec({ ORUNMILA_EDIT_VERBS: '1' }), [['wired']]);
  assert.deepStrictEqual(exec({ ORUNMILA_EDIT_VERBS: '' }), []);
});

runAll('runner-claims');
