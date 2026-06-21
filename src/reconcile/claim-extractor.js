'use strict';

/**
 * claim-extractor.js
 *
 * Turns the agent's free-text turn response into a list of discrete,
 * checkable claims. Two tags matter most here (forensic gaps #1 and #2):
 *
 *   hedged             - "basic", "some", "a few", "should", "mostly"...
 *                         vague on purpose or by accident. A claim like this
 *                         can't be cleanly verified true/false from a diff -
 *                         that uncertainty is itself the signal, so we mark
 *                         it rather than silently grading it as done.
 *
 *   verificationClaim  - "tested", "verified", "confirmed", "passes",
 *                         "works". These are the dangerous ones: confident
 *                         language asserting proof, which must be backed by
 *                         an actual command_run with exit 0 in the same turn,
 *                         not just asserted. See provenance.js.
 */

const { extractTargets } = require('./task-extractor');

const HEDGE_WORDS = [
  'basic', 'basically', 'some', 'a few', 'mostly', 'partially', 'should', 'probably',
  'likely', 'generally', 'roughly', 'a bit', 'somewhat', 'minor', 'small tweak', 'quick',
  'a couple', 'various', 'several', 'as needed', 'where appropriate', 'best effort',
];

const VERIFICATION_WORDS = [
  'tested', 'test passes', 'tests pass', 'verified', 'confirmed', 'validated',
  'works', 'working', 'ran the tests', 'all tests pass', 'no errors', 'builds successfully',
  'compiles', 'fixed and verified', 'double-checked', 'i confirmed', 'this resolves',
  'build passes', 'build is green', 'build succeeds', 'passing', 'lint passes',
];

const ACTION_VERBS = [
  'added', 'created', 'implemented', 'wrote', 'fixed', 'updated', 'refactored', 'removed',
  'deleted', 'renamed', 'moved', 'configured', 'installed', 'replaced', 'extracted',
  'introduced', 'set up', 'cleaned up', 'optimized', 'migrated',
];

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9`*-])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function containsAny(lowerText, list) {
  return list.filter((w) => lowerText.includes(w));
}

function extractClaims(claimText) {
  if (!claimText || !claimText.trim()) return [];

  const claims = splitSentences(claimText)
    .map((sentence, i) => {
      const lower = sentence.toLowerCase();
      const verbs = containsAny(lower, ACTION_VERBS);
      const hedges = containsAny(lower, HEDGE_WORDS);
      const verifications = containsAny(lower, VERIFICATION_WORDS);

      const targets = extractTargets(sentence);
      if (!verbs.length && !verifications.length && !targets.length) return null;

      return {
        id: `claim${i + 1}`,
        text: sentence,
        verbs,
        targets,
        keywords: targets.map((t) => t.value), // legacy shim
        hedged: hedges.length > 0,
        hedgeWords: hedges,
        verificationClaim: verifications.length > 0,
        verificationWords: verifications,
      };
    })
    .filter(Boolean);

  // Anaphora patch: "I added X to login.js. I tested it and it works." - the
  // second sentence has no target of its own ("it" isn't one), so without
  // this it falls into `unverifiable` instead of being checked against
  // login.js, which defeats the point of phantom_verification. When a claim
  // has verification language but zero targets, inherit targets from the
  // nearest preceding claim that has any - it's almost always referring
  // back to what was just said.
  for (let i = 1; i < claims.length; i++) {
    if (claims[i].verificationClaim && !claims[i].targets.length) {
      for (let j = i - 1; j >= 0; j--) {
        if (claims[j].targets.length) {
          claims[i].targets = claims[j].targets;
          claims[i].keywords = claims[j].keywords;
          claims[i].inheritedTargets = true;
          break;
        }
      }
    }
  }

  return claims;
}

module.exports = { extractClaims, HEDGE_WORDS, VERIFICATION_WORDS, ACTION_VERBS };
