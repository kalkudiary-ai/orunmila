// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
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
 *
 * Speech-act gate (added after the dogfood reports — see test/cases/precision/ (each case names its source report)):
 * a sentence only counts as a *claim of completed work* if it's assertive in
 * the agent's own voice. Imperatives to the user ("Click X"), conditionals
 * ("If you'd like…"), offers ("Want me to…"), questions, and statements
 * whose subject is an external actor ("Chrome disabled GPU") are filtered
 * out before any verb/target check. Without this, every conversational
 * sentence with a backtick or PascalCase identifier was getting graded as
 * a phantom.
 */

const { extractTargets, SQUOTE_RE } = require('./task-extractor');
const { sanitize } = require('./sanitize');
const { findExecutionClaims, maskQuoted: maskForReader, MECHANISM_FRAME_RE } = require('./verification-claim');

const HEDGE_WORDS = [
  'basic', 'basically', 'some', 'a few', 'mostly', 'partially', 'should', 'probably',
  'likely', 'generally', 'roughly', 'a bit', 'somewhat', 'minor', 'small tweak', 'quick',
  'a couple', 'various', 'several', 'as needed', 'where appropriate', 'best effort',
];

// Claims that an EXECUTION passed ("tested", "tests pass", "the build is green")
// are read by findExecutionClaims, shared with the law gate, which knows that
// "Nothing was tested." says the opposite (NF43). This list keeps the words that
// reader does not cover.
const VERIFICATION_WORDS = [
  'verified', 'confirmed', 'validated',
  'works', 'working', 'ran the tests', 'no errors',
  'compiles', 'fixed and verified', 'double-checked', 'i confirmed', 'this resolves',
  'passing',
];

// The verb list (LD203 (b), LD288): "I edited X" is a claim of changed work as much as "I updated X". This list is the
// live law gate's too, so the edit verbs come only with ORUNMILA_EDIT_VERBS=1 (off by default; turning it on is O's).
// `changed` is left out: it is said of the world as often as of the agent's own work.
const EDIT_VERBS = ['edited', 'modified', 'rewrote', 'patched'];
const ACTION_VERBS = [
  'added', 'created', 'implemented', 'wrote', 'fixed', 'updated', 'refactored', 'removed',
  'deleted', 'renamed', 'moved', 'configured', 'installed', 'replaced', 'extracted',
  'introduced', 'set up', 'cleaned up', 'optimized', 'migrated',
  ...(process.env.ORUNMILA_EDIT_VERBS === '1' ? EDIT_VERBS : []),
];

// First-person past-tense or passive anchors that mark a sentence as an
// assertion of completed work. Anything not matching one of these (or being
// a recognized headline/heading like "Done:") falls through the speech-act
// gate and is dropped, regardless of any verb/target hits — those hits were
// the dominant false-positive source in the dogfood data.
const ASSERTIVE_ANCHOR_RE = new RegExp(
  [
    // "I added X", "we wrote Y", "I've fixed Z" — first-person past
    String.raw`\b(?:i|we)(?:'ve|'d|'ll| have| had| just)?\s+(?:${ACTION_VERBS.join('|')})\b`,
    // Passive: "X was/were/has been added/created/…"
    String.raw`\b(?:has|have|was|were|is|are|been)\s+(?:${ACTION_VERBS.join('|')})\b`,
    // Bare past participle leading a bullet, e.g. "- Added X", "Fixed Y"
    String.raw`^\s*(?:[-*•]\s*|\d+[.)]\s*)?(?:${ACTION_VERBS.join('|')})\b`,
    // "Done:", "Landed:", "Committed:", "Merged:" headlines
    String.raw`^\s*(?:done|landed|committed|merged|shipped|pushed)\s*[:—-]`,
  ].join('|'),
  'i'
);

// Imperative-to-user sentences. These are the agent telling the user what to
// do, never the agent reporting what it itself did. Anchored at start-of-
// sentence with a verb in bare form.
const IMPERATIVE_VERBS = [
  'click', 'open', 'tell', 'go', 'run', 'try', 'check', 'set', 'reopen', 'drop',
  'type', 'paste', 'copy', 'visit', 'navigate', 'press', 'select', 'choose',
  'enable', 'disable', 'install', 'uninstall', 'restart', 'reload', 'refresh',
  'send', 'share', 'see', 'use', 'pick', 'note', 'consider', 'avoid', 'remember',
  'find', 'look', 'review', 'inspect', 'verify', 'confirm', 'flip', 'toggle',
];
const IMPERATIVE_RE = new RegExp(
  String.raw`^\s*(?:please\s+|just\s+|then\s+|now\s+|first\s+|next\s+)?(?:${IMPERATIVE_VERBS.join('|')})\b`,
  'i'
);

// Conditional/hypothetical leads. The clause after "if" is not an assertion.
const CONDITIONAL_RE = /^\s*(?:if|when(?!\s+i\s)|unless|once|should\s+you|would\s+you|whenever)\b/i;

// Offer / future-work patterns — the agent is proposing, not reporting.
const OFFER_RE = new RegExp(
  [
    String.raw`^\s*(?:if you('|')?d like|if you want|want me to|i can|i'll|i could|happy to|let me know|say the word|let me\b|here(?:'s| is) (?:what|where|how))`,
    String.raw`\bwant me to\b`,
    String.raw`\bsay the word\b`,
    String.raw`\bping me when\b`,
    String.raw`^\s*(?:my recommendation|my suggestion|i'd (?:recommend|suggest|go))`,
  ].join('|'),
  'i'
);

// External-actor subjects: when the grammatical subject is something other
// than the agent or the code, the sentence is a description of the world,
// not a work claim.
const EXTERNAL_SUBJECT_RE = new RegExp(
  String.raw`^\s*(?:chrome|github|npm|aider|the browser|the gpu|the user|macos|windows|linux|the server|the dashboard server|node|the agent|the model|claude|gemini|gpt|deepseek|llama|qwen|the api|the framework|the registry|the cli|aider)\b`,
  'i'
);

// Section heading: a line that's pure markdown header. These are document
// structure, not claims.
const HEADING_RE = /^\s*#{1,6}\s+/;

function splitSentences(text, opts) {
  const sentences = text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9`*-])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const result = [];
  for (const s of sentences) {
    result.push(...splitCompoundClaims(s, opts));
  }
  return result;
}

// A plain "and" joining TWO assertions of work is two claims, not one. Left
// unsplit, a true half verifies a false half: "I added validation to login.js
// and wrote a test in login.test.js" scored `verified` off the login.js write
// alone, masking the fact that login.test.js was never written. That is a false
// green, which is the worst direction of error for this tool, and it was the
// asymmetry that made it possible — the ASK side (task-extractor's
// SPLIT_CONNECTORS) has always split on plain "and"; the CLAIM side never did.
//
// But splitting on every "and" is not safe either, and the reason is worth
// keeping: "I fixed the bug in PR #26 and shipped it." puts the PR number in
// one half and the merge language in the other, and the VCS provenance check
// needs them together to catch a "shipped" claim against a PR captured OPEN.
// So the plain-"and" split is CONDITIONAL — it fires only when both halves
// stand on their own as assertions of completed work. A trailing fragment that
// needs its sibling for meaning ("and shipped it", "and it works", "and
// retries to the client") keeps its sibling.
const PLAIN_AND_RE = /,?\s+and\s+/i;

function splitOnPlainAnd(part, opts) {
  const halves = part.split(PLAIN_AND_RE);
  if (halves.length < 2) return [part];
  // Every half must be independently assertive, or the sentence stays whole.
  if (!halves.every((h) => h.trim() && isAssertiveAboutWork(h, opts))) return [part];
  return halves;
}

function splitCompoundClaims(sentence, opts) {
  const parts = [];
  const semiParts = sentence.split(/\s*;\s+/);
  for (const part of semiParts) {
    // Explicit sequencing connectors split unconditionally — they are only ever
    // used between two complete actions.
    const subParts = part.split(/,?\s+(?:and\s+then|and\s+also|then\s+also)\s+/i);
    for (const sub of subParts) parts.push(...splitOnPlainAnd(sub, opts));
  }
  return parts.map((p) => p.trim()).filter(Boolean);
}

function containsAny(lowerText, list) {
  return list.filter((w) => lowerText.includes(w));
}

// The words above go through the shared reader's mechanism frame too, so "This
// is how it works." and "My review follows while it works." are not read as
// claims of verification. Only that frame: the other disqualifiers were
// measured to drop real claims of a check here ("all confirmed ... per").
// With strict proof on (ORUNMILA_STRICT_PROOF=1, plan slice 4.4) these four are
// left to the shared reader, which needs a subject and knows the negations, so
// "Nothing works yet." is not read as a claim that something works.
const SHARED_READER_WORDS = ['works', 'working', 'passing', 'compiles'];

// NF57: each word counts only as a whole word ("unverified" is not "verified",
// "frameworks" is not "works"), and the words the shared reader never takes are
// cancelled by a negation just before them ("not verified", "hasn't been
// confirmed"). Only that one occurrence: the sentence-wide disqualifiers drop
// real claims of a check here (see above).
const NEGATED_BEFORE_RE = /(?:\b(?:not|never|no|nothing|none)|n't)\s+(?:(?:yet|been|be|fully|really|actually|properly|independently)\s+){0,2}$/;

function wordsIn(lowerMasked, words) {
  return words.filter((w) => {
    for (let at = lowerMasked.indexOf(w); at !== -1; at = lowerMasked.indexOf(w, at + 1)) {
      const whole = !/[a-z0-9]/.test(lowerMasked[at - 1] || '') && !/[a-z0-9]/.test(lowerMasked[at + w.length] || '');
      if (!whole) continue;
      if (!SHARED_READER_WORDS.includes(w) && NEGATED_BEFORE_RE.test(lowerMasked.slice(0, at))) continue;
      return true;
    }
    return false;
  });
}

function verificationWordsIn(sentence, lowerMasked, { strictProof = false } = {}) {
  if (MECHANISM_FRAME_RE.test(maskForReader(sentence))) return [];
  const words = strictProof ? VERIFICATION_WORDS.filter((w) => !SHARED_READER_WORDS.includes(w)) : VERIFICATION_WORDS;
  return wordsIn(lowerMasked, words);
}

// Mask quoted spans (``…``, "…", '…') so action/verification verb scans
// don't trigger on verbs being MENTIONED rather than USED.
// We replace each quoted region with same-length whitespace so offsets stay
// stable for any downstream code that cares. Single quotes use the target
// extractor's pattern: an apostrophe inside a word (it's) is not a quote mark,
// so "That's verified now that it's merged." keeps its "verified" (NF31).
function maskQuoted(s) {
  return s
    .replace(/`([^`]*)`/g, (m) => ' '.repeat(m.length))
    .replace(/"([^"]*)"/g, (m) => ' '.repeat(m.length))
    .replace(SQUOTE_RE, (m) => ' '.repeat(m.length));
}

// Returns the speech-act gate decision: true means "this sentence is a
// candidate claim of completed work". A return of false means we drop it
// before any classification — no phantom, no anything.
function isAssertiveAboutWork(sentence, opts = {}) {
  const trimmed = sentence.trim();
  if (!trimmed) return false;

  // Questions are never claims.
  if (trimmed.endsWith('?')) return false;
  // Headings are document structure.
  if (HEADING_RE.test(trimmed)) return false;
  // Imperatives to the user.
  if (IMPERATIVE_RE.test(trimmed)) return false;
  // Conditionals / hypotheticals.
  if (CONDITIONAL_RE.test(trimmed)) return false;
  // Offers / proposals.
  if (OFFER_RE.test(trimmed)) return false;
  // External-actor subjects.
  if (EXTERNAL_SUBJECT_RE.test(trimmed)) return false;

  // Verification claims need first-person attribution OR an explicit verification
  // verb that isn't sitting in a conditional clause. We accept them here so the
  // matcher can grade them; the conservative filter is on action verbs.
  const masked = maskQuoted(trimmed.toLowerCase());
  if (verificationWordsIn(trimmed, masked, opts).length || findExecutionClaims(trimmed).length) return true;

  // Action claims need an assertive anchor (first-person past-tense, passive,
  // bullet-led participle, or a "done:" headline).
  return ASSERTIVE_ANCHOR_RE.test(trimmed);
}

function extractClaims(claimText, opts = {}) {
  if (!claimText || !claimText.trim()) return [];

  // Strip wrapper tags, code fences, table rows, runner stdout *before*
  // sentence splitting. Without this, table rows and code-block contents
  // come through as sentences.
  const cleaned = sanitize(claimText);
  if (!cleaned.trim()) return [];

  const claims = splitSentences(cleaned, opts)
    .map((sentence, i) => {
      if (!isAssertiveAboutWork(sentence, opts)) return null;

      // Verbs/verifications must be detected on the QUOTED-MASKED form so
      // a verb mentioned inside backticks/quotes doesn't trigger.
      const lowerMasked = maskQuoted(sentence.toLowerCase());
      const verbs = containsAny(lowerMasked, ACTION_VERBS);
      const hedges = containsAny(lowerMasked, HEDGE_WORDS);
      const verifications = [...new Set(verificationWordsIn(sentence, lowerMasked, opts).concat(findExecutionClaims(sentence)))];

      // Targets are still extracted from the full sentence (including quoted
      // spans) because filenames in backticks are how the agent names what
      // it touched.
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
  // nearest preceding claim that has any — but only when that preceding
  // claim is itself anchored work (the dogfood data showed unanchored
  // anaphora compounded false positives across hypotheticals).
  for (let i = 1; i < claims.length; i++) {
    if (claims[i].verificationClaim && !claims[i].targets.length) {
      for (let j = i - 1; j >= 0; j--) {
        if (claims[j].targets.length && claims[j].verbs && claims[j].verbs.length) {
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

module.exports = {
  extractClaims,
  HEDGE_WORDS,
  VERIFICATION_WORDS,
  ACTION_VERBS,
  isAssertiveAboutWork,
};
