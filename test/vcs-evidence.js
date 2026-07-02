'use strict';

/**
 * test/vcs-evidence.js
 *
 * Covers the git/CI evidence path added after the two-session dogfood:
 *   1. deriveVcsEvents parses gh/git OUTPUT into typed PR_STATE/CI_STATE/GIT_STATE
 *      events (JSON and human forms), and returns [] on anything unrecognized.
 *   2. provenance resolves a claim naming a merged PR to `resolved-since`
 *      (a satisfied verdict), not a phantom — the exact false positive we hit.
 *   3. The evidence-detached invariant: a turn with ZERO captured tool events
 *      can never produce `not_sent`/phantom; such claims are `unverifiable`.
 *
 * Run: node test/vcs-evidence.js
 */

const { assert, it, runAll } = require('./helpers');
const { deriveVcsEvents } = require('../src/capture/vcs-evidence');
const { reconcileTurn } = require('../src/reconcile/matcher');
const provenance = require('../src/reconcile/provenance');

// --- parser: gh pr -> PR_STATE ----------------------------------------------

it('vcs: gh pr view --json parses number/state/mergeCommit', () => {
  const out = '{"mergeCommit":{"oid":"abc123"},"number":25,"state":"MERGED"}';
  const evs = deriveVcsEvents('gh pr view 25 --json number,state,mergeCommit', out);
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0], { type: 'pr_state', pr_number: 25, pr_state: 'merged', merged_sha: 'abc123' });
});

it('vcs: gh pr view human TSV output parses state + number', () => {
  const out = 'title:\tFix failover\nstate:\tMERGED\nauthor:\tkalkudiary-ai\nnumber:\t25\nurl:\thttps://x/pull/25';
  const evs = deriveVcsEvents('gh pr view 25', out);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].pr_number, 25);
  assert.equal(evs[0].pr_state, 'merged');
});

it('vcs: gh pr list --json array yields one PR_STATE per row', () => {
  const out = '[{"number":26,"state":"OPEN"},{"number":25,"state":"MERGED"}]';
  const evs = deriveVcsEvents('gh pr list --json number,state', out);
  assert.equal(evs.length, 2);
  assert.equal(evs.find((e) => e.pr_number === 25).pr_state, 'merged');
  assert.equal(evs.find((e) => e.pr_number === 26).pr_state, 'open');
});

// --- parser: gh checks -> CI_STATE ------------------------------------------

it('vcs: gh pr checks human output parses per-check conclusions', () => {
  const out = 'verify\tpass\t1m32s\thttps://x\nsmoke\tpass\t20s\thttps://y\nlive-eval\tfail\t2m\thttps://z';
  const evs = deriveVcsEvents('gh pr checks 26', out);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, 'ci_state');
  assert.equal(evs[0].checks.length, 3);
  assert.equal(evs[0].checks.find((c) => c.name === 'verify').conclusion, 'pass');
  assert.equal(evs[0].checks.find((c) => c.name === 'live-eval').conclusion, 'fail');
});

// --- parser: git -> GIT_STATE -----------------------------------------------

it('vcs: git rev-parse HEAD yields a GIT_STATE with the sha', () => {
  const sha = 'a'.repeat(40);
  const evs = deriveVcsEvents('git rev-parse HEAD', sha + '\n');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, 'git_state');
  assert.equal(evs[0].head_sha, sha);
});

it('vcs: git status -b captures the branch', () => {
  const evs = deriveVcsEvents('git status -b --porcelain', '## main...origin/main\n M src/x.js\n');
  assert.equal(evs[0].branch, 'main');
});

it('vcs: unrecognized command produces no events (never guesses)', () => {
  assert.deepEqual(deriveVcsEvents('npm test', 'all good'), []);
  assert.deepEqual(deriveVcsEvents('gh pr view 1', 'garbage with no fields'), []);
  assert.deepEqual(deriveVcsEvents('', ''), []);
});

// --- provenance: a merged PR the claim names is resolved-since, not phantom --

it('vcs: claim naming a captured-merged PR resolves to verified (not phantom)', () => {
  const r = reconcileTurn({
    promptText: 'investigate the failover trace',
    claimText: 'The failover was fixed by PR #25, which is merged.',
    turnEvents: [
      { type: 'command_run', command: 'gh pr view 25', exit_code: 0 },
      { type: 'pr_state', pr_number: 25, pr_state: 'merged', merged_sha: 'abc123' },
    ],
  });
  const claim = r.claims.find((c) => /#25/.test(c.claim.text));
  assert.ok(claim, 'the PR claim was extracted');
  assert.equal(claim.provenance, 'resolved-since');
  assert.equal(claim.outcome, 'verified');
});

it('vcs: claim says merged but PR captured OPEN => disregarded_failure', () => {
  const r = reconcileTurn({
    promptText: 'ship it',
    claimText: 'I fixed the bug in PR #26 and shipped it.',
    turnEvents: [
      { type: 'command_run', command: 'gh pr view 26', exit_code: 0 },
      { type: 'pr_state', pr_number: 26, pr_state: 'open', merged_sha: null },
    ],
  });
  const claim = r.claims.find((c) => /#26/.test(c.claim.text));
  assert.ok(claim, 'the PR claim was extracted');
  assert.equal(claim.provenance, 'disregarded_failure');
});

// --- the evidence-detached invariant ----------------------------------------

it('vcs: detached run (evidenceDetached) yields unverifiable, never not_sent', () => {
  const r = reconcileTurn({
    promptText: 'do the work',
    claimText: 'I added rate limiting to payment.js and refactored auth.js.',
    turnEvents: [], // post-hoc transcript-only: no receipts were ever captured
    evidenceDetached: true, // the caller knows no eventlog exists for the session
  });
  assert.equal(r.evidenceBasis, 'evidence-detached');
  assert.equal(r.summary.phantom, 0, 'no phantom findings when evidence was never collectible');
  assert.ok(r.claims.every((c) => c.provenance !== 'not_sent'), 'not_sent is structurally impossible when detached');
  assert.ok(r.claims.every((c) => c.outcome === 'unverifiable'), 'detached work-claims are unverifiable');
});

it('vcs: detached verification claim is unverifiable, not phantom_verification', () => {
  const r = reconcileTurn({
    promptText: 'go',
    claimText: 'I tested payment.js and it passes.',
    turnEvents: [],
    evidenceDetached: true,
  });
  assert.equal(r.summary.phantom_verification, 0);
  assert.ok(r.claims.every((c) => c.outcome === 'unverifiable'));
});

it('vcs: an EMPTY but non-detached turn is still a real phantom (invariant is scoped)', () => {
  // A live turn where the agent did nothing but claim: no events, but capture
  // WAS active (evidenceDetached defaults false). This must stay phantom — the
  // corpus 03-phantom-no-evidence case.
  const r = reconcileTurn({
    promptText: 'add a dark mode toggle to settings',
    claimText: 'I added a dark mode toggle to the settings page.',
    turnEvents: [],
  });
  assert.equal(r.evidenceBasis, 'receipted');
  assert.ok(r.claims.some((c) => c.outcome === 'phantom'), 'live do-nothing turn is still phantom');
});

it('vcs: a receipted turn still flags a real phantom (invariant is scoped)', () => {
  const r = reconcileTurn({
    promptText: 'add caching',
    claimText: 'I added caching to nonexistent.js.',
    turnEvents: [{ type: 'file_write', path: 'other.js', diff: '+x\n', source: 'hook' }],
  });
  assert.equal(r.evidenceBasis, 'receipted');
  assert.ok(r.claims.some((c) => c.provenance === 'not_sent'), 'not_sent still fires when evidence exists');
});

// --- prNumbersInClaim helper -------------------------------------------------

it('vcs: prNumbersInClaim extracts #N and PR N forms', () => {
  assert.deepEqual([...provenance.prNumbersInClaim({ text: 'PR #25 and pr 26 landed' })].sort(), [25, 26]);
  assert.deepEqual([...provenance.prNumbersInClaim({ text: 'no numbers here' })], []);
});

runAll('vcs-evidence');
