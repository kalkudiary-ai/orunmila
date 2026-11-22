'use strict';

/**
 * src/opon/corroborate/claims.js — claim capture without AI, for station 6
 * (brief v4 lines 431-433, 443; guarantee 8; Phase 3 slice C2, LD186).
 *
 *   claimsOf(mark, { strictProof }) -> [{ claim, text, files, commands, hedged }]
 *
 * A `claimed` mark's text, as the raw log holds it, read by today's rule-based
 * reader (src/reconcile/claim-extractor.js: word lists and patterns, shared with
 * the law gate and held to the labelled corpus), unchanged. Plain code: no
 * language model, no network, no clock.
 *
 * - A command claim (line 433: "tests pass", "build succeeds"): the execution
 *   phrases the shared reader finds in the claim (`commands`).
 * - A file claim (line 432: "I updated config.ts"): a claim with an action verb
 *   used, not quoted, and a path of its own (`files`, as the agent wrote them;
 *   matching them to normalised targets is C3's). A path inherited from an
 *   earlier sentence (the reader's anaphora rule) makes no file claim.
 * - Only claims of either kind are returned; `hedged` is the reader's tag.
 * - A claim whose text could not be confirmed (`claim_unconfirmed`, N10) gives
 *   none: text that may be another turn's is never read as this turn's.
 *
 *   mentionsOf(mark, { strictProof }) -> [path as written]
 *
 * For a silent change (line 434: a change "the agent never mentioned in its
 * claims"; slice C3d2, LD194): every path target in every claim the same reader
 * reads in the text, with or without an action verb, as the agent wrote it.
 * None for a claim that could not be confirmed.
 */

const { extractClaims } = require('../../reconcile/claim-extractor');
const { findExecutionClaims } = require('../../reconcile/verification-claim');

/** The claims the shared reader reads in a `claimed` mark's text; none for one that could not be confirmed (N10). */
function readClaims(mark, strictProof) {
  const d = mark && mark.detail && typeof mark.detail === 'object' ? mark.detail : {};
  if (!mark || mark.says !== 'claimed' || d.claim_unconfirmed === true || typeof d.text !== 'string') return [];
  return extractClaims(d.text, { strictProof });
}
/** A claim's path targets, as written. */
const pathsOf = (c) => c.targets.filter((t) => t.kind === 'path').map((t) => t.raw);

function claimsOf(mark, { strictProof = false } = {}) {
  const out = [];
  for (const c of readClaims(mark, strictProof)) {
    const files = c.verbs.length && !c.inheritedTargets ? [...new Set(pathsOf(c))] : [];
    const commands = [...new Set(findExecutionClaims(c.text))];
    if (files.length || commands.length) out.push({ claim: c.id, text: c.text, files, commands, hedged: c.hedged });
  }
  return out;
}

function mentionsOf(mark, { strictProof = false } = {}) {
  return [...new Set(readClaims(mark, strictProof).flatMap(pathsOf))];
}

module.exports = { claimsOf, mentionsOf };
