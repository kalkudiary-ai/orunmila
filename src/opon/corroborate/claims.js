// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
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
 *   mentionsOf(mark) -> [path as written]
 *
 * For a silent change (line 434: a change "the agent never mentioned in its
 * claims"; slice C3d2, LD194; C3d3, LD203; C3d3b, LD210 (4)): every path
 * target the reader's target finder sees anywhere in the text (a table row and
 * a code block included), in any sentence, a claim or not, less the harness's wrapper text, and in a code
 * block only a path with a folder part (C3d3c, LD215: `require('./w.ts')` names no file the session can
 * place, and as a bare name it would match every w.ts): the reader takes no claim from
 * "I edited src/a.ts." (its verbs have no `edited`), and that sentence still
 * mentions the file. None for a claim that could not be confirmed.
 */

const { extractClaims } = require('../../reconcile/claim-extractor');
const { findExecutionClaims } = require('../../reconcile/verification-claim');
const { extractTargets } = require('../../reconcile/task-extractor');
const { stripWrapperTags, stripCodeFences } = require('../../reconcile/sanitize');
const { parseClaimsBlock } = require('../../reconcile/claims-block');

/** A `claimed` mark's text, or null for one that could not be confirmed (N10) or is not a claim. */
function confirmedText(mark) {
  const d = mark && mark.detail && typeof mark.detail === 'object' ? mark.detail : {};
  if (!mark || mark.says !== 'claimed' || d.claim_unconfirmed === true || typeof d.text !== 'string') return null;
  return d.text;
}
/** The claims the shared reader reads in a `claimed` mark's text; none for one that could not be confirmed. */
function readClaims(mark, strictProof) {
  const text = confirmedText(mark);
  return text === null ? [] : extractClaims(text, { strictProof });
}
/** A claim's path targets, as written. */
const pathsOf = (c) => c.targets.filter((t) => t.kind === 'path').map((t) => t.raw);

/**
 * MR1b2 (LD339; spec/claims-block.md): the `changed:` paths of the claims block the text ends with, as written, or [].
 * Read whenever the text holds a block: an agent writes one only when asked (MR1b1, ORUNMILA_CLAIMS_BLOCK=1), and the
 * Ọpọ́n takes no setting from the environment (guarantee 3), so it needs no switch of its own.
 */
function blockChanged(mark) {
  const text = confirmedText(mark);
  const block = text === null ? null : parseClaimsBlock(text);
  return block ? [...new Set(block.changed)] : [];
}

function claimsOf(mark, { strictProof = false } = {}) {
  const out = [];
  for (const c of readClaims(mark, strictProof)) {
    const files = c.verbs.length && !c.inheritedTargets ? [...new Set(pathsOf(c))] : [];
    const commands = [...new Set(findExecutionClaims(c.text))];
    if (files.length || commands.length) out.push({ claim: c.id, text: c.text, files, commands, hedged: c.hedged });
  }
  // MR1b2: the block's changed: lines, one file claim of the turn, checked as "I updated <path>" is (C3d1).
  const changed = blockChanged(mark);
  if (changed.length) out.push({ claim: 'block', text: `changed: ${changed.join(', ')}`, files: changed, commands: [], hedged: false });
  return out;
}

const FENCE = /```[\s\S]*?```/g; // a fenced code block, as sanitize.js reads one

function mentionsOf(mark) {
  // C3d3, C3d3b (LD203, LD210 (4)): every path anywhere in the confirmed text, a table row and a code block included;
  // C3d3c (LD215): less harness wrapper text, and in a code block only a path with a folder part.
  const text = confirmedText(mark);
  if (text === null) return [];
  const own = stripWrapperTags(text);
  const pathsIn = (t) => extractTargets(t).filter((x) => x.kind === 'path').map((x) => x.raw);
  const fenced = (own.match(FENCE) || []).flatMap(pathsIn).filter((p) => p.replace(/^\.\//, '').includes('/'));
  return [...new Set([...pathsIn(stripCodeFences(own)), ...fenced, ...blockChanged(mark)])]; // MR1b2: a path the block lists, a bare name too
}

module.exports = { claimsOf, mentionsOf };
