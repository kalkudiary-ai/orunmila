'use strict';

/**
 * assert-extractor.js — find the sentences that assert a FACT about the system.
 *
 * This is deliberately NOT src/reconcile/claim-extractor.js, and the difference
 * is the reason the law layer exists as its own module.
 *
 * The reconciler's gate (isAssertiveAboutWork) keeps only claims of COMPLETED
 * WORK — "I added X", "fixed Y". That is the right gate for grading a diff.
 * But being confidently wrong does not live there. It lives in the DESCRIPTIVE
 * present tense:
 *
 *     "the wallet reads from tier_snapshot_at_issue"
 *     "there are 16 call sites with a hardcoded currency"
 *     "nothing else references that column"
 *
 * Not one of those is a claim about work done, so the reconciler drops all
 * three — and those three are exactly the shape of statement an agent states
 * with total confidence and gets wrong. So the law layer needs its own gate:
 * present-tense, anchored to a code target, and graded against whether the turn
 * holds a receipt that could possibly support it.
 *
 * The small filter regexes below are duplicated from claim-extractor rather than
 * imported. That is on purpose. The reconciler is the settled layer; coupling it
 * to a newer, noisier one so they must change together would make every future
 * law tweak a change to the part of orunmila that is already trusted.
 */

const { extractTargets } = require('../reconcile/task-extractor');
const { sanitize } = require('../reconcile/sanitize');

// Verbs that, in the present tense with a code subject, state how the system IS.
// NOTE on the missing auxiliaries: 'have' and 'had' were here and were removed
// after the first real-session measurement. As auxiliaries they appear in almost
// any sentence of engineering prose — "since callers may have depended on…" is
// an aside, not an assertion — and they dragged ordinary discussion into the
// gate. 'has' is kept because its possessive use ("the router has no retry") is
// a genuine claim about system state.
const STATE_VERBS = [
  'is', 'are', 'was', 'were', "isn't", "aren't", "wasn't", "weren't",
  'has', "hasn't",
  'contains', 'includes', 'returns', 'reads', 'writes', 'calls', 'uses', 'lives',
  'sits', 'exists', 'handles', 'does', "doesn't", 'sets', 'defaults', 'points',
  'maps', 'expects', 'accepts', 'emits', 'throws', 'requires', 'depends',
  'references', 'implements', 'extends', 'overrides', 'matches', 'resolves',
];

const STATE_VERB_RE = new RegExp(String.raw`\b(?:${STATE_VERBS.map((v) => v.replace(/'/g, "['’]")).join('|')})\b`, 'i');

// "there is / there are / there's no" — the existential assertion, which almost
// always carries a count or an absolute and almost never carries a receipt.
const EXISTENTIAL_RE = /\bthere(?:'s| is| are| was| were)\b/i;

// Negative-universal assertions: the single most receipt-hungry sentence shape
// in engineering prose, because proving a negative requires seeing everything.
const NEGATIVE_UNIVERSAL_RE = /\b(?:no other|nothing else|nowhere else|none of|not a single|never|no longer)\b/i;

/**
 * Absolutes and counts. A grep can prove that something EXISTS. It can never
 * prove that a set is COMPLETE — it only ever shows what matched the pattern
 * you happened to write. So a claim carrying one of these needs a receipt that
 * could have enumerated the set, not one that merely found a member of it.
 */
const ABSOLUTE_RE = new RegExp(
  [
    String.raw`\b(?:all|every|each|any|none|neither|both|only|always|never|entire|whole|complete|exhaustive|everywhere|nowhere)\b`,
    String.raw`\bnothing else\b`,
    String.raw`\bno other\b`,
    // COUNTED claims — "one additive field", "16 call sites", "a single
    // caller", "two lines in two files". Added after the law layer was caught
    // missing a real one: an agent sizing an unresearched change as "one
    // additive field" is making a quantified claim about a set it never
    // enumerated, and that is the single most common shape of a confident
    // under-estimate. Bare numerals were covered before only when followed by
    // a noun from a short hand-written list, which is exactly the selective
    // curation the exhaustive-coverage argument warns against.
    //
    // This is broad on purpose. It is kept quiet by the two conditions the
    // rule already imposes: the sentence must carry a code target, and NO
    // target may hold a full receipt. "I read one file" has a receipt and
    // stays silent; "the fix is one line" with nothing read does not.
    String.raw`\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|a single|a couple of|a handful of)\s+\w+`,
  ].join('|'),
  'i'
);

const HEDGE_RE = new RegExp(
  String.raw`\b(?:should be|probably|likely|presumably|i assume|assuming|my guess|appears to|seems to|seem to|i think|i believe|in theory|most likely|might be|may be|could be|as far as i can tell|iirc|if i recall)\b`,
  'i'
);

/**
 * EXECUTION-flavoured verification only.
 *
 * "verified", "confirmed" and "validated" used to be here and were removed after
 * the first real-session measurement. They are satisfiable by READING: a claim
 * like "erasure verified covered — userErasure.ts:221 deletes loans" was being
 * rejected for having no passing command behind it, on a turn holding 77 full
 * read receipts. Reading the code IS the verification for a claim about what the
 * code says; demanding a command there is simply the wrong bar.
 *
 * What remains is the class of claim only an EXECUTION can settle — the suite
 * ran, the build compiled, the linter passed. For those, a green sentence with
 * no exit-zero command behind it is exactly the phantom verification the whole
 * project was built to catch.
 */
const VERIFICATION_RE = new RegExp(
  String.raw`\b(?:tested|tests? (?:pass|passed|passes|passing)|it works|working correctly|no errors|builds? success|compiles|build is green|all green|suite (?:is )?green|lint passes|smoke(?:d|s)? (?:clean|green|fine))\b`,
  'i'
);

/**
 * A verification WORD is not a verification CLAIM.
 *
 * Measured over 194 real sessions, this was the dominant false positive by a
 * wide margin — around 16 of every 19 firings of the green law. The word
 * "tested" was matching in sentences that assert the OPPOSITE, or that use it
 * as an adjective, or that quote it while discussing verification itself:
 *
 *   "capture hooks exist for one agent; Cursor/Aider aren't tested"   negation
 *   "branch coverage was low because the new branches weren't tested" negation
 *   "the multiplier logic is unit-tested"                             hyphenated
 *   "empty ⇒ open by the tested logic"                                adjectival
 *   "the verification verb is in a future frame (should work)"        quoting
 *
 * Every one of those is an agent being careful, and flagging them punishes
 * precisely the behaviour the law exists to encourage. A negated or attributive
 * use is disqualified before the claim is ever graded.
 */
const NEGATED_VERIFICATION_RE = new RegExp(
  [
    // "not / never / isn't / aren't / weren't ... tested|passing|works|green"
    String.raw`\b(?:not|never|no|without|isn'?t|aren'?t|wasn'?t|weren'?t|don'?t|doesn'?t|didn'?t|cannot|can'?t|un)\b[^.!?]{0,24}?\b(?:tested|passing|passes|pass|green|works|compiles)\b`,
    // hyphenated adjective: "unit-tested", "battle-tested", "well-tested"
    String.raw`\w-tested\b`,
    // attributive: "the tested logic", "a tested path"
    String.raw`\b(?:the|a|an|that|this|those|these|its|their)\s+tested\b`,
    // future / hypothetical framing: "should work", "will pass", "let's see if it works"
    String.raw`\b(?:should|would|will|might|may|could|hope|expect|see if|check if|to be)\b[^.!?]{0,24}?\b(?:work|works|pass|passes|passing|green|compile|compiles)\b`,
  ].join('|'),
  'i'
);

// --- speech-act filters (see header note on the deliberate duplication) ------

const HEADING_RE = /^\s*#{1,6}\s+/;
const QUESTION_RE = /\?\s*$/;
const IMPERATIVE_RE =
  /^\s*(?:please\s+|just\s+|then\s+|now\s+|first\s+|next\s+)?(?:click|open|tell|go|run|try|check|set|type|paste|copy|visit|press|select|choose|enable|disable|install|restart|reload|send|share|see|use|pick|note|consider|avoid|remember|find|look|review|inspect|verify|confirm|read|let)\b/i;
const CONDITIONAL_RE = /^\s*(?:if|unless|once|should you|would you|whenever|suppose|say)\b/i;
const OFFER_RE =
  /^\s*(?:i can\b|i'?ll\b|i could\b|i'?d\b|want me to|happy to|let me know|shall i|my recommendation|my suggestion|next step|next up|to do\b|todo\b)|\bwant me to\b|\bsay the word\b/i;
// When the subject is a person or the tooling ecosystem rather than this
// codebase, the sentence describes the world, not a checkable system fact.
const EXTERNAL_SUBJECT_RE =
  /^\s*(?:you|we|i|the user|the founder|claude|chatgpt|github|npm|node|macos|windows|linux|the browser|chrome|docs?|the docs?|the spec)\b/i;

function splitSentences(text) {
  return text
    .split(/(?<=[.!?:])\s+(?=[A-Z0-9`*\-(])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Mask quoted/backticked spans so a word being DISCUSSED is not read as a word
// being USED. Without this, a turn that explains a law trips that same law —
// which would make the whole layer unusable in exactly the conversations where
// it matters most.
function maskQuoted(s) {
  return s
    .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
    .replace(/"[^"]*"/g, (m) => ' '.repeat(m.length))
    .replace(/'[^']*'/g, (m) => ' '.repeat(m.length))
    // Markdown emphasis is how an agent quotes a phrase it is DISCUSSING when
    // backticks would be too code-like: "the verb is in a future frame (*should
    // work*, *let's see if it works*)". Measured against real sessions, that
    // exact sentence — from a turn analysing verification detection — was the
    // last surviving false positive of the green law. Emphasis is quotation.
    .replace(/\*\*[^*]+\*\*/g, (m) => ' '.repeat(m.length))
    .replace(/\*[^*\n]+\*/g, (m) => ' '.repeat(m.length));
}

/**
 * Is this sentence an assertion about how the system IS?
 *
 * Conservative by construction: everything ambiguous is dropped. A law layer
 * that blocks a turn is expensive when wrong, so silence beats noise. The cost
 * of a miss is one unflagged sentence; the cost of a false block is the agent
 * spinning against a rule it cannot satisfy.
 */
function isFactualAssertion(sentence) {
  const t = sentence.trim();
  if (!t || t.length < 12) return false;
  if (QUESTION_RE.test(t)) return false;
  if (HEADING_RE.test(t)) return false;
  if (IMPERATIVE_RE.test(t)) return false;
  if (CONDITIONAL_RE.test(t)) return false;
  if (OFFER_RE.test(t)) return false;
  if (EXTERNAL_SUBJECT_RE.test(t)) return false;

  const masked = maskQuoted(t);
  return STATE_VERB_RE.test(masked) || EXISTENTIAL_RE.test(masked) || NEGATIVE_UNIVERSAL_RE.test(masked);
}

/**
 * Only targets a receipt could plausibly be matched against. `phrase` targets
 * ("user authentication") are dropped: they are useful for the reconciler's
 * fuzzy work-matching, but as the anchor of a blocking law they would fire on
 * ordinary prose. Restricting to path/symbol/literal is the main false-positive
 * control in the whole layer.
 */
function evaluableTargets(sentence) {
  return extractTargets(sentence).filter((t) => t.kind === 'path' || t.kind === 'symbol' || t.kind === 'literal');
}

/**
 * Extract the factual assertions from a turn's claim text.
 *
 * Each returned assertion carries the flags the evidentiary rules need, so the
 * evaluator never re-parses prose — it only joins these against receipts.
 */
function extractAssertions(claimText) {
  if (!claimText || !claimText.trim()) return [];
  const cleaned = sanitize(claimText);
  if (!cleaned.trim()) return [];

  const out = [];
  splitSentences(cleaned).forEach((sentence, i) => {
    if (!isFactualAssertion(sentence)) return;
    const targets = evaluableTargets(sentence);
    const masked = maskQuoted(sentence);
    const isVerification = VERIFICATION_RE.test(masked) && !NEGATED_VERIFICATION_RE.test(masked);
    // Keep the marker that fired, not just the boolean. A universal quantifier
    // ("all", "none", "never") and a bare count ("two things") are both
    // unenumerated, but they are not equally dangerous, and a finding that
    // cannot say which one it saw cannot be triaged.
    const absoluteMatch = ABSOLUTE_RE.exec(masked);
    // A verification claim ("tests pass") is worth grading even with no target,
    // because the receipt it needs is a passing COMMAND, not a file. Everything
    // else needs a target or there is nothing to check it against.
    if (!targets.length && !isVerification) return;

    out.push({
      id: `assert${i + 1}`,
      text: sentence,
      targets,
      absolute: !!absoluteMatch,
      absoluteMarker: absoluteMatch ? absoluteMatch[0].trim() : null,
      hedged: HEDGE_RE.test(masked),
      verification: isVerification,
    });
  });
  return out;
}

module.exports = {
  extractAssertions,
  isFactualAssertion,
  evaluableTargets,
  maskQuoted,
  splitSentences,
  ABSOLUTE_RE,
  HEDGE_RE,
  VERIFICATION_RE,
};