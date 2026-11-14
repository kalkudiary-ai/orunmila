'use strict';

/**
 * verification-claim.js — one reader for "it ran and passed" claims.
 *
 * Both claim readers ask this module whether a sentence says that an EXECUTION
 * succeeded: the suite ran, the build compiled, the linter passed. The law gate
 * (src/laws/assert-extractor.js) blocks a turn on it today, and the reconciler
 * (claim-extractor.js) grades phantom_verification on it, which later builds'
 * judge starts from. They used to keep separate copies, and the copies drifted:
 * the reconciler had no negation check at all, so "Nothing was tested." read as
 * a claim that testing was done (NF43). Sharing the reader closes that, and the
 * labelled corpus in test/claim-corpus.js holds both readers to the same labels,
 * so a change here that breaks either one fails the suite.
 */

const { SQUOTE_RE } = require('./task-extractor');

// Mask quoted/backticked spans so a word being DISCUSSED is not read as a word
// being USED. Without this, a turn that explains a law trips that same law —
// which would make the whole layer unusable in exactly the conversations where
// it matters most.
//
// Single quotes use the target extractor's pattern, so an apostrophe inside a
// word (it's, isn't) is not a quote mark here either. Pairing them hid the
// claim in "That's done, and the suite passes now that it's merged." and
// exposed the quoted one in "the template's line reads 'the tests pass'".
function maskQuoted(s) {
  return s
    .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
    .replace(/"[^"]*"/g, (m) => ' '.repeat(m.length))
    .replace(SQUOTE_RE, (m) => ' '.repeat(m.length))
    // Markdown emphasis is how an agent quotes a phrase it is DISCUSSING when
    // backticks would be too code-like: "the verb is in a future frame (*should
    // work*, *let's see if it works*)". Measured against real sessions, that
    // exact sentence — from a turn analysing verification detection — was the
    // last surviving false positive of the green law. Emphasis is quotation.
    .replace(/\*\*[^*]+\*\*/g, (m) => ' '.repeat(m.length))
    .replace(/\*[^*\n]+\*/g, (m) => ' '.repeat(m.length));
}

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
/**
 * ── On adjacency, the bug this list actually had (P0-3, fixed 2026-10-28) ───
 *
 * This was a flat list of ADJACENT word pairs: `tests pass`, `build is green`,
 * `suite is green`. Adjacency is the wrong model for English. "The test suite
 * passes", "Tests are passing" and "I ran the tests and they pass" are the same
 * claim with a word sitting in the gap, and not one of them matched — which is
 * why the flagship blocking law never saw the commonest way an agent claims a
 * pass. Two of those phrasings had even been recorded in the issue tracker as
 * CAUGHT, on the strength of the law's own title rather than a run.
 *
 * So subject and predicate are enumerated separately, with at most two words
 * allowed between them. The cap is what keeps a subject and a predicate from
 * different clauses ("the tests I still owe you will land once the parser is
 * green") out of range, and the disqualifiers below carry the rest of the load.
 */
const VERIF_SUBJECT = String.raw`(?:tests?|test suite|suite|specs?|build|rebuild|lint(?:er)?|eslint|typecheck|tsc|types|ci|pipeline|smoke|coverage|gate|everything|it|they)`;
// `work` and `working` are deliberately ABSENT, and that is a measured
// decision rather than an oversight. Run against this tool's own 111-session
// corpus, a bare `work` matched the NOUN — "the coverage work that made them
// invisible", "none of it is work you asked for" — and `working` matched
// "it's inside Kalku's working tree", helped along by the apostrophe masking
// that turns `it's ... Kalku's` into `it` + gap + `working`. Only the inflected
// verb forms survive. "working correctly" is kept as its own phrase below.
const VERIF_PREDICATE = String.raw`(?:pass(?:es|ed|ing)?|green|works|worked|succeed(?:s|ed)?|successful|clean|compiles?|compiled)`;

const VERIFICATION_RE = new RegExp(
  [
    String.raw`\btested\b`,
    String.raw`\b${VERIF_SUBJECT}(?:\s+\w+){0,2}\s+${VERIF_PREDICATE}\b`,
    String.raw`\b(?:all|everything)\s+(?:green|passing|passes)\b`,
    // "no errors" / "zero errors" were here and were removed on measurement:
    // they matched claims about PRODUCTION, not about a run — "there have been
    // zero errors in the actual last 24h" is settled by a query, not by a
    // command exiting zero, and demanding one there is the wrong bar.
    String.raw`\bbuilds? success(?:ful|fully)?\b`,
    String.raw`\bsmoke(?:d|s)? (?:clean|green|fine)\b`,
    String.raw`\bworking correctly\b`,
  ].join('|'),
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
// MECHANISM, not outcome: "this is how it works", "whether the suite passes is
// the open question". An interrogative or relative frame ahead of the predicate
// means the sentence explains or asks, it does not certify. "while" frames a
// time or a mechanism the same way: "My review follows while it works." A
// sentence whose green words all come before the frame is still a claim; one
// after it silences the whole sentence. Exported for the reconciler's own words.
const MECHANISM_FRAME = String.raw`\b(?:how|why|what|where|when|whether|which|while)\b[^.!?]{0,20}?\b(?:works?|pass|passes|passing|green|compiles?)\b`;
const MECHANISM_FRAME_RE = new RegExp(MECHANISM_FRAME, 'i');

const VERIFICATION_DISQUALIFIER_RE = new RegExp(
  [
    // "not / never / isn't / aren't / weren't ... tested|passing|works|green"
    String.raw`\b(?:not|never|no|without|isn'?t|aren'?t|wasn'?t|weren'?t|don'?t|doesn'?t|didn'?t|cannot|can'?t|un)\b[^.!?]{0,24}?\b(?:tested|passing|passes|pass|green|works|compiles)\b`,
    // hyphenated adjective: "unit-tested", "battle-tested", "well-tested"
    String.raw`\w-tested\b`,
    // attributive: "the tested logic", "a tested path"
    String.raw`\b(?:the|a|an|that|this|those|these|its|their)\s+tested\b`,
    // future / hypothetical framing: "should work", "will pass", "let's see if it works"
    String.raw`\b(?:should|would|will|might|may|could|hope|expect|see if|check if|to be)\b[^.!?]{0,24}?\b(?:work|works|pass|passes|passing|green|compile|compiles)\b`,
    // INTENT, not report — work still to do: "we need to make the tests pass",
    // "the goal is to get the suite green". Allowing a gap between subject and
    // predicate brought this entire family into range for the first time, so it
    // has to be disqualified explicitly or the law starts flagging plans.
    String.raw`\b(?:need|needs|needed|want|wants|wanted|have|has|had|try|tries|trying|aim|aims|plan|plans|planning|supposed|intend|intends|going)\s+to\b[^.!?]{0,30}?\b(?:pass|passes|passing|work|works|green|compile|compiles|clean|tested)\b`,
    String.raw`\b(?:to get|to make|to keep|to have|so that|in order to|before|until|after|once)\b[^.!?]{0,30}?\b(?:pass|passes|passing|work|works|green|compile|compiles|clean)\b`,
    // REPORTED speech. What someone else claimed is not this turn's claim —
    // "the handover says the tests pass" is a description of a document.
    String.raw`\b(?:says?|said|claims?|claimed|asserts?|asserted|states?|stated|reports?|reported|insists?|per|according to|documented as|recorded as)\b[^.!?]{0,30}?\b(?:pass|passes|passing|works?|green|tested|compiles?)\b`,
    // MECHANISM, not outcome (see MECHANISM_FRAME above).
    MECHANISM_FRAME,
    // ARGUMENT-passing, the other sense of the word entirely: "I re-ran it with
    // `--repo` passed explicitly", "the flag passed to the adapter", "I passed
    // it as clean". `in` is deliberately not in this list, because "all tests
    // passed in CI" is a genuine claim and must still fire.
    String.raw`\bpass(?:ed|es|ing)?\s+(?:to|into|through|as|explicitly|it|along|down)\b`,
    // A printed VERDICT is output being described, not a claim of green:
    // "check 1 wasn't user-scoped so it prints PASS".
    String.raw`\b(?:prints?|printed|outputs?|shows?|showed|logs?|reports?|returns?|echoes|echoed)\s+(?:\w+\s+){0,2}(?:pass|fail|green)\b`,
  ].join('|'),
  'i'
);

/**
 * NF43: "tested" under a none / nothing / neither says testing did NOT happen.
 *
 * The disqualifiers above read "not", "never" and "no", but not the negative
 * quantifiers, so "I tested nothing." and "Nothing was tested." read as claims
 * that testing was done, and the green law blocked the agent for being honest.
 * Two shapes cancel ONE occurrence of "tested", never the whole sentence, so a
 * real claim beside it still counts ("I tested none of the old paths, but all
 * tests pass"):
 *
 *   object    "I tested none of it", "Tested: nothing", "I tested, well, nothing"
 *             — but "I tested nothing but the parser" names what WAS tested
 *   subject   "Nothing was tested", "None of it, I admit, was tested",
 *             "Neither the parser nor the gate was tested" — the passive
 *             "tested" whose nearest none/nothing/neither, in the same clause,
 *             is its subject. A connector that opens a new subject ends that
 *             reach: "Nothing broke, and the code was tested" is a claim.
 */
const NEG_QUANT = String.raw`(?:none|nothing|neither)`;
const OBJECT_NEGATED_RE = new RegExp(
  String.raw`^[\s,:]*(?:(?:well|really|honestly|actually|so far)[\s,]+)?${NEG_QUANT}\b(?!\s+(?:but|except|other than|besides)\b)`,
  'i'
);
// "got tested" is the same passive as "was tested": "Nothing got tested."
const PASSIVE_AUX_RE = /\b(?:was|were|is|are|been|be|got|gets|get|getting)\s+(?:(?:yet|ever|actually|really|properly|fully)\s+)?$/i;
const NEG_QUANT_RE = new RegExp(String.raw`\b${NEG_QUANT}\b`, 'gi');
// "as" ends the reach only before a noun subject ("as the parser was tested"):
// before a pronoun it is usually an aside ("Nothing, as I said, was tested").
const NEW_SUBJECT_RE =
  /(?:,|\b)\s*(?:(?:and|but|so|since|because|while|although|though|yet)\s+(?:the|a|an|this|that|these|those|it|they|everything|everyone|all|my|our|its|their|we|i)|as\s+(?:the|a|an|this|that|these|those|my|our|its|their))\b/i;

function testedIsNegated(masked, index) {
  if (OBJECT_NEGATED_RE.test(masked.slice(index + 'tested'.length))) return true;
  const before = masked.slice(0, index);
  const aux = PASSIVE_AUX_RE.exec(before);
  if (!aux) return false;
  const clause = before.slice(0, aux.index);
  const clauseStart = Math.max(clause.lastIndexOf(';'), clause.lastIndexOf(':')) + 1;
  let last = null;
  for (const m of clause.slice(clauseStart).matchAll(NEG_QUANT_RE)) last = m;
  if (!last) return false;
  const between = clause.slice(clauseStart + last.index + last[0].length);
  return !NEW_SUBJECT_RE.test(between);
}

/**
 * The execution claims a sentence makes, as the matched phrases, after the
 * disqualifiers and the NF43 cancellation. Empty when the sentence makes none.
 * Hedges are left to the caller: the law gate drops a hedged claim (another law
 * grades it), while the reconciler grades it and tags it hedged.
 */
function findExecutionClaims(sentence) {
  const masked = maskQuoted(sentence);
  if (!VERIFICATION_RE.test(masked)) return [];
  if (VERIFICATION_DISQUALIFIER_RE.test(masked)) return [];
  const found = [];
  for (const m of masked.matchAll(new RegExp(VERIFICATION_RE.source, 'gi'))) {
    if (/^tested$/i.test(m[0]) && testedIsNegated(masked, m.index)) continue;
    found.push(m[0].toLowerCase());
  }
  return found;
}

module.exports = { findExecutionClaims, maskQuoted, VERIFICATION_RE, VERIFICATION_DISQUALIFIER_RE, MECHANISM_FRAME_RE };
