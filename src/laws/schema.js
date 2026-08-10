'use strict';

/**
 * schema.js — what a law IS, and the validator that refuses a malformed one.
 *
 * The law layer is orunmila's fourth and fifth lenses on the same session:
 *
 *   layer 4 — THE CANON.  The built-in pack shipped with orunmila
 *             (src/laws/packs/canon.json). Everyone gets it.
 *   layer 5 — YOUR OWN.   A user's personal laws (~/.orunmila/laws.json) and a
 *             project's laws (<repo>/.orunmila/laws.json). Optional, offered at
 *             install, and able to extend, retune or switch off anything in the
 *             canon by id.
 *
 * A law is DATA, never code. That is the whole point: the working standards a
 * team argues about live in a JSON file the team can read and edit, not in a
 * regex buried in a source tree. The only thing that is code is the small fixed
 * set of EVIDENTIARY rules below, because those are joins over the event log and
 * cannot be expressed as a pattern.
 *
 * Two kinds of law, and the distinction is load-bearing:
 *
 *   kind: 'lexical'      Decidable from text alone. "Never write 'assume'",
 *                        "never say Vercel", "never `git add -A`". A regex over
 *                        the claim text, a command string, or the prompt.
 *
 *   kind: 'evidentiary'  NOT decidable from text. A join between what the agent
 *                        asserted and what the turn's receipts actually support.
 *                        "grep is never the basis for a claim" is this kind: the
 *                        sentence is innocent, the missing receipt is the crime.
 *
 * Severity is what the law DOES when it fires:
 *
 *   'warn'   record it in law_findings; surface at close-out; never interrupt.
 *   'block'  the Stop gate refuses the turn and hands the reason back to the
 *            agent, which must re-run and answer properly.
 *
 * (A third severity, 'deny' — refuse the tool call itself at PreToolUse — was
 * specified before anything implemented it, and has been removed. See below.)
 */

// 'deny' (refuse the tool call itself, at PreToolUse) was specified here before
// anything implemented it. A severity the engine silently ignores is the exact
// failure this project exists to catch — a rule that looks enforced and is not —
// so it is removed until a PreToolUse gate exists to honour it.
const SEVERITIES = new Set(['warn', 'block']);
const KINDS = new Set(['lexical', 'evidentiary']);
const SCOPES = new Set(['claim', 'command', 'prompt', 'any']);

/**
 * The fixed vocabulary of evidentiary rules. These are code (see evaluate.js)
 * because each is a join over the turn's events, not a pattern. A law selects
 * one by name; it cannot invent one. Keeping the set small and named is what
 * stops the law layer from drifting into the distrusted inference layer — every
 * one of these answers a yes/no question about whether a RECEIPT EXISTS.
 */
const EVIDENTIARY_RULES = {
  // The claim's targets have pattern-read (grep/glob) receipts and nothing
  // stronger. A grep licenses "at least these"; it never licenses a claim.
  pattern_read_only: 'A claim resting only on a pattern match (grep/glob), with no full read of the target.',
  // The claim's targets have no receipt of any kind in this turn.
  no_receipt: 'An assertive claim about a target the turn never read, ran, or wrote.',
  // "all / every / none / only / N of them" backed by anything less than an
  // enumeration. This is the sharpest rule in the set: a grep can prove
  // existence, never exhaustiveness.
  absolute_without_enumeration: 'A quantified or absolute claim ("all", "every", "none", "only") without an enumerating receipt.',
  // Hedged language ("should", "probably", "I assume") used to state something
  // as settled fact rather than flagged as unknown.
  hedged_assertion: 'Uncertainty presented as a settled fact instead of being flagged as unverified.',
  // "tests pass / green / it works" with no exit-0 command behind it in the turn.
  verification_without_command: 'A claim of verification with no passing command in the turn to back it.',
};

// A user-supplied pattern is compiled into a RegExp and run against agent text.
// Cap the length: a pathological pattern is the one way a law file could hang
// the gate, and a synchronous RegExp cannot be timed out in Node. A cap plus a
// documented ceiling is the honest mitigation — not a claim of safety.
const MAX_PATTERN_LENGTH = 400;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function compilePatterns(list, errors, where) {
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || !raw.trim()) {
      errors.push(`${where}: pattern must be a non-empty string`);
      continue;
    }
    if (raw.length > MAX_PATTERN_LENGTH) {
      errors.push(`${where}: pattern exceeds ${MAX_PATTERN_LENGTH} characters`);
      continue;
    }
    try {
      out.push(new RegExp(raw, 'i'));
    } catch (e) {
      errors.push(`${where}: invalid regular expression (${e.message})`);
    }
  }
  return out;
}

/**
 * Validate and normalise one law. Returns { law, errors }.
 *
 * A law with ANY error is not silently dropped — the caller reports it. A law
 * file that fails to parse must be loud, because a law that quietly stopped
 * applying is indistinguishable from a law that never fired, and that is the
 * exact failure the whole layer exists to prevent.
 */
function validateLaw(input, { source = '(unknown)', layer = 5 } = {}) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { law: null, errors: [`${source}: law must be an object`] };
  }

  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!id) errors.push(`${source}: law is missing an "id"`);
  if (id && !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    errors.push(`${source}: law id "${id}" must be lower-case kebab-case`);
  }

  const severity = input.severity || 'warn';
  if (!SEVERITIES.has(severity)) {
    errors.push(`${source}: law "${id}" has unknown severity "${severity}" (expected: ${[...SEVERITIES].join(', ')})`);
  }

  const detect = isPlainObject(input.detect) ? input.detect : null;
  if (!detect) errors.push(`${source}: law "${id}" is missing a "detect" block`);

  const kind = detect && detect.kind;
  if (detect && !KINDS.has(kind)) {
    errors.push(`${source}: law "${id}" has unknown detect.kind "${kind}" (expected: ${[...KINDS].join(', ')})`);
  }

  let patterns = [];
  let unless = [];
  let rule = null;
  let scope = 'claim';

  if (detect && kind === 'lexical') {
    scope = detect.scope || 'claim';
    if (!SCOPES.has(scope)) {
      errors.push(`${source}: law "${id}" has unknown detect.scope "${scope}" (expected: ${[...SCOPES].join(', ')})`);
    }
    const rawPatterns = Array.isArray(detect.patterns) ? detect.patterns : [];
    if (!rawPatterns.length) errors.push(`${source}: lexical law "${id}" needs at least one detect.patterns entry`);
    patterns = compilePatterns(rawPatterns, errors, `${source}: law "${id}"`);
    unless = compilePatterns(Array.isArray(detect.unless) ? detect.unless : [], errors, `${source}: law "${id}" (unless)`);
  }

  if (detect && kind === 'evidentiary') {
    rule = detect.rule;
    if (!Object.prototype.hasOwnProperty.call(EVIDENTIARY_RULES, rule)) {
      errors.push(
        `${source}: law "${id}" has unknown detect.rule "${rule}" (expected one of: ${Object.keys(EVIDENTIARY_RULES).join(', ')})`
      );
    }
  }

  if (errors.length) return { law: null, errors };

  return {
    law: {
      id,
      title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : id,
      layer,
      source,
      severity,
      enabled: input.enabled !== false,
      kind,
      // lexical
      scope,
      patterns,
      // Keep the raw strings too: `orunmila laws` prints what the user wrote,
      // not a stringified RegExp, so the printed law matches their file.
      rawPatterns: Array.isArray(detect.patterns) ? detect.patterns.slice() : [],
      unless,
      rawUnless: Array.isArray(detect.unless) ? detect.unless.slice() : [],
      maskQuoted: detect.mask_quoted !== false,
      // evidentiary
      rule,
      // presentation
      message: typeof input.message === 'string' ? input.message : `Law "${id}" was violated.`,
      remedy: typeof input.remedy === 'string' ? input.remedy : '',
      cite: typeof input.cite === 'string' ? input.cite : '',
    },
    errors: [],
  };
}

module.exports = {
  validateLaw,
  SEVERITIES,
  KINDS,
  SCOPES,
  EVIDENTIARY_RULES,
  MAX_PATTERN_LENGTH,
};