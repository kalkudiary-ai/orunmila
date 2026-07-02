'use strict';

/**
 * provenance.js
 *
 * This is the axis the user specifically asked not to lose: sent or not
 * sent, and - as far as it's honestly inferable - intentional-looking or
 * hallucination-looking. We can never actually know intent, so this module
 * only ever produces evidence tags, never a verdict on "why". The render
 * layer must show these as supporting signals, not accusations.
 *
 * provenance (hard, evidence-based):
 *   receipt_matches      - matching tool call(s) exist, succeeded, evidence found
 *   disregarded_failure  - matching tool call(s) exist but failed, claim implies success anyway
 *   not_sent             - zero tool calls reference this target at all
 *   unverifiable         - claim too vague to map to any concrete target
 *
 * causeHints (soft, inferential, always plural - never a single "the reason"):
 *   vague-hedge                - claim hedges itself; leans toward minimization, not confusion
 *   high-specificity-mismatch  - claim names specifics absent from every diff/command this
 *                                turn; leans toward confabulation
 *   error-in-context           - a check ran and failed, visible in the tool's own result
 *   no-verification-attempted  - claim asserts proof but no check of any kind ran this turn
 *
 * Matching is TYPED now (see review/EXTRACTOR_DESIGN.md):
 *   path    -> basename equality against event paths (NOT substring, so
 *              payment.js no longer matches unrelated.js, and the bare-"js"
 *              over-match is gone)
 *   symbol  -> word-boundary hit in ADDED diff lines / command text
 *   phrase  -> >=50% of content tokens appear in added diff lines or basename
 *   literal -> exact substring (literals are verbatim by intent)
 *
 * Verification claims ("tested", "works", "passes") are deliberately checked
 * against ANY test/build/lint-like command in the whole turn, not just
 * commands whose target overlaps the claim.
 */

const { basename } = require('./task-extractor');

const TEST_LIKE = /\b(test|tests|jest|pytest|mocha|vitest|rspec|lint|eslint|tsc|build|compile|cargo|go test|mvn|gradle)\b/i;

function isTestLikeCommand(e) {
  return e.type === 'command_run' && !!e.command && TEST_LIKE.test(e.command);
}

// Only the lines an action ADDED - matching a removed/context line shouldn't
// credit an addition claim.
function addedLines(diff) {
  if (!diff) return '';
  return diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n')
    .toLowerCase();
}

function wordHit(token, haystack) {
  if (!token) return false;
  const re = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return re.test(haystack);
}

// Does one typed target match one event?
function targetMatchesEvent(target, e) {
  const path = (e.path || '').toLowerCase();
  const base = path ? basename(path) : '';
  const added = addedLines(e.diff);
  const command = (e.command || '').toLowerCase();
  const toolBlob = [e.tool_name, JSON.stringify(e.input || {})].filter(Boolean).join(' ').toLowerCase();

  switch (target.kind) {
    case 'path':
      // basename equality (allow the extension-less well-known names too)
      return (
        base === target.value ||
        base.startsWith(target.value + '.') ||
        (path && path.endsWith('/' + target.value))
      );
    case 'symbol':
      return (
        wordHit(target.value, added) ||
        wordHit(target.value, command) ||
        wordHit(target.value, base) ||
        wordHit(target.value, toolBlob)
      );
    case 'phrase': {
      const tokens = target.value.split(/\s+/).filter(Boolean);
      if (!tokens.length) return false;
      const hay = `${added} ${base} ${command}`;
      const hits = tokens.filter((t) => wordHit(t, hay)).length;
      return hits / tokens.length >= 0.5;
    }
    case 'literal':
      return added.includes(target.value) || command.includes(target.value) || base.includes(target.value);
    default:
      return false;
  }
}

// Normalize a claim/subtask into a typed target list. Supports both the new
// `targets` field and the legacy flat `keywords` (treated as loose symbols).
function targetsOf(claim) {
  if (claim.targets && claim.targets.length) return claim.targets;
  if (claim.keywords && claim.keywords.length) {
    return claim.keywords.map((k) => ({ kind: 'symbol', value: String(k).toLowerCase() }));
  }
  return [];
}

function eventsMentioning(turnEvents, claim) {
  const targets = targetsOf(claim);
  if (!targets.length) return [];
  return turnEvents.filter((e) => targets.some((t) => targetMatchesEvent(t, e)));
}

// Which PR numbers does this claim reference? "#25", "PR 25", "pr#25".
function prNumbersInClaim(claim) {
  const nums = new Set();
  const text = `${claim.text || ''} ${(claim.targets || []).map((t) => t.value).join(' ')}`;
  const re = /(?:pr[\s#-]*|#)(\d{1,6})\b/gi;
  let m;
  while ((m = re.exec(text))) nums.add(Number(m[1]));
  return nums;
}

// A claim that names a PR reconciles against captured PR_STATE, not a diff.
// A merged PR the claim names is a durable receipt ('resolved-since') even when
// no file/command in THIS turn touches it — the exact case that read as a
// phantom in the two-session review. A named PR captured NOT merged, while the
// claim says it landed, is a contradiction, not a pass.
function vcsPrResolution(claim) {
  return function (turnEvents) {
    const nums = prNumbersInClaim(claim);
    if (!nums.size) return null;
    const prEvents = turnEvents.filter((e) => e.type === 'pr_state' && nums.has(Number(e.pr_number)));
    if (!prEvents.length) return null;
    const merged = prEvents.filter((e) => e.pr_state === 'merged');
    if (merged.length) return { provenance: 'resolved-since', causeHints: ['vcs-confirmed'], evidence: merged };
    if (/\bmerged?\b|\blanded\b|\bshipped\b/i.test(claim.text || '')) {
      return { provenance: 'disregarded_failure', causeHints: ['error-in-context'], evidence: prEvents };
    }
    return null;
  };
}

// A verification/CI claim ("checks pass", "CI green") reconciles against a
// captured CI_STATE. All-pass -> resolved-since; any-fail -> disregarded_failure.
function vcsCiResolution(claim) {
  return function (turnEvents) {
    const ci = turnEvents.filter((e) => e.type === 'ci_state' && Array.isArray(e.checks) && e.checks.length);
    if (!ci.length) return null;
    const mentionsCi = /\b(ci|checks?|pipeline|workflow|green|passing)\b/i.test(claim.text || '');
    if (!mentionsCi && !claim.verificationClaim) return null;
    const anyFail = ci.some((e) => e.checks.some((c) => c.conclusion === 'fail'));
    const allPass = ci.some((e) => e.checks.every((c) => c.conclusion === 'pass'));
    if (anyFail && !allPass) return { provenance: 'disregarded_failure', causeHints: ['error-in-context'], evidence: ci };
    if (allPass) return { provenance: 'resolved-since', causeHints: ['vcs-confirmed'], evidence: ci };
    return null;
  };
}

// opts.evidenceDetached: the turn had ZERO captured tool events (a post-hoc
// transcript-only run). Under it, `not_sent` is structurally impossible — the
// matcher never had the tool stream, so it cannot honestly say "no tool call
// referenced this". Such claims are `unverifiable`, tagged so the render layer
// can say why. This is the invariant that kills the detached false-positive
// storm at the source, not by filtering after the fact.
function classify(claim, turnEvents, opts = {}) {
  const detached = !!opts.evidenceDetached;
  const resolvePr = vcsPrResolution(claim);
  const resolveCi = vcsCiResolution(claim);

  if (claim.verificationClaim) {
    const testCommands = turnEvents.filter(isTestLikeCommand);
    if (testCommands.length) {
      const passed = testCommands.some((c) => c.exit_code === 0 && c.failed !== true);
      if (passed) return { provenance: 'receipt_matches', causeHints: [], evidence: testCommands };
      return { provenance: 'disregarded_failure', causeHints: ['error-in-context'], evidence: testCommands };
    }
    const ci = resolveCi(turnEvents);
    if (ci) return ci;
    const pr = resolvePr(turnEvents);
    if (pr) return pr;
    if (detached) return { provenance: 'unverifiable', causeHints: ['evidence-detached'], evidence: [] };
    return { provenance: 'not_sent', causeHints: ['no-verification-attempted'], evidence: [] };
  }

  if (!targetsOf(claim).length) {
    return { provenance: 'unverifiable', causeHints: ['vague-hedge'], evidence: [] };
  }

  // A claim that names a PR resolves against captured PR_STATE FIRST — merge
  // state is authoritative and more precise than a substring hit on the `gh`
  // command that produced it (which would otherwise read as receipt_matches).
  const prEarly = resolvePr(turnEvents);
  if (prEarly) return prEarly;

  const matches = eventsMentioning(turnEvents, claim);

  if (!matches.length) {
    const ci = resolveCi(turnEvents);
    if (ci) return ci;
    if (detached) return { provenance: 'unverifiable', causeHints: ['evidence-detached'], evidence: [] };
    const causeHints = claim.hedged ? ['vague-hedge'] : ['high-specificity-mismatch'];
    return { provenance: 'not_sent', causeHints, evidence: [] };
  }

  const anyFailed = matches.some((e) => e.failed === true);
  const anySucceeded = matches.some((e) => e.failed !== true);

  if (anyFailed && !anySucceeded) {
    return { provenance: 'disregarded_failure', causeHints: ['error-in-context'], evidence: matches };
  }

  return { provenance: 'receipt_matches', causeHints: [], evidence: matches };
}

module.exports = {
  classify,
  eventsMentioning,
  isTestLikeCommand,
  targetMatchesEvent,
  targetsOf,
  prNumbersInClaim,
};
