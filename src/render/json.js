'use strict';

/**
 * json.js
 *
 * Machine-readable rendition of the same reconciler output the terminal/HTML
 * renderers consume. Third sibling of html.js and terminal.js — same input, new
 * format. Reads existing data; does not re-run or change detection.
 *
 * Contract: schema_version 1.0. The emitter is pure and deterministic: same
 * event log + same option set → byte-identical JSON, including `generated_at`
 * (derived from the last event ts in the window, never wall-clock).
 *
 * Two confidence axes are reported separately:
 *   - extraction_confidence: confidence the text was correctly identified as a
 *     claim of this type. This is the field the downstream accuracy report
 *     uses to measure claim-ID calibration.
 *   - verdict_confidence: confidence the outcome is right, GIVEN correct parse.
 * They are split, not fused, because fusing them makes calibration analysis
 * impossible.
 *
 * `claim_type` ships `other`-heavy on purpose. The reconciler today tags
 * outcomes, not claim types; a real classifier is deliberately out of scope
 * and will be the first thing the corpus loop drives. When the type is `other`
 * we also emit `classification_features` — categories, counts, and pattern-ID
 * references only, NEVER raw substrings from the claim text. This is the
 * privacy guarantee that lets the feature breadcrumbs ship by default without
 * leaking the original phrasing.
 *
 * Sanitization runs per string-valued field during emit, before serialization,
 * on every path-bearing field — defaults AND opt-ins, not just the `--include`
 * fields. Reuses src/render/redact.js (already exposes string-level helpers).
 */

const { readSession, TYPES } = require('../store/eventlog');
const { buildRedactor } = require('./redact');

const SCHEMA_VERSION = '1.0';

// Opt-in raw text fields. Today only claim_text is implemented. The others are
// reserved and documented so the schema doesn't break when they land.
const KNOWN_INCLUDE_FIELDS = new Set([
  'claim_text',
  // reserved, not implemented in 1.0:
  // 'prompt_text',
  // 'diff_hunks',
  // 'command_output_snippets',
]);

const SEVEN_OUTCOMES = new Set([
  'verified',
  'partial',
  'phantom',
  'phantom_verification',
  'unverifiable',
  'undisclosed',
  'silently_dropped',
]);

// Map a reconciler claim verb set → coarse claim_type. Ships `other`-heavy on
// purpose; this is a deliberate scope call. A real classifier is the first
// thing the accuracy loop will drive from the corpus.
const ADD_VERBS = new Set(['added', 'created', 'wrote', 'implemented', 'introduced', 'installed']);
const FIX_VERBS = new Set(['fixed', 'updated', 'replaced', 'refactored', 'reverted', 'migrated']);
const DID_VERBS = new Set(['removed', 'deleted', 'configured', 'enabled', 'set up', 'cleaned up', 'optimized']);

function deriveClaimType(claim) {
  if (!claim) return 'other';
  if (claim.verificationClaim) return 'tested';
  const verbs = (claim.verbs || []).map((v) => String(v).toLowerCase());
  if (verbs.some((v) => ADD_VERBS.has(v))) return 'added';
  if (verbs.some((v) => FIX_VERBS.has(v))) return 'fixed';
  if (verbs.some((v) => DID_VERBS.has(v))) return 'did';
  if (claim.hedged && verbs.length === 0) return 'unverifiable';
  return 'other';
}

// Extraction confidence: how sure are we this text IS a claim of this type?
// Coarse buckets; the corpus will tell us where the boundaries belong.
function deriveExtractionConfidence(claim) {
  if (!claim) return 'low';
  const hasVerbs = (claim.verbs || []).length > 0;
  const hasVerifications = !!claim.verificationClaim;
  const hasTargets = (claim.targets || []).length > 0;
  if ((hasVerbs || hasVerifications) && hasTargets && !claim.hedged) return 'high';
  if ((hasVerbs || hasVerifications) && hasTargets) return 'medium';
  if (hasVerbs || hasVerifications || hasTargets) return 'medium';
  return 'low';
}

// Verdict confidence: how sure are we the outcome is right, given the parse
// was correct? Causes drop us a notch.
function deriveVerdictConfidence(claimResult) {
  if (!claimResult) return 'low';
  const causes = claimResult.causeHints || [];
  const evidence = claimResult.evidence || [];
  const outcome = claimResult.outcome;
  if (outcome === 'unverifiable') return 'medium';
  if (causes.length >= 2) return 'low';
  if (causes.length === 1) return 'medium';
  if (outcome === 'phantom' || outcome === 'phantom_verification') return 'high';
  if (evidence.length > 0) return 'high';
  return 'medium';
}

// Pattern-IDs the extractor matched. These are STABLE category identifiers,
// not regex captures from the claim text — so they are safe to ship by default
// without leaking the original phrasing.
function derivePatternIds(claim) {
  const ids = [];
  if (!claim) return ids;
  if ((claim.verbs || []).length > 0) ids.push('claim.action_verb');
  if (claim.verificationClaim) ids.push('claim.verification');
  if (claim.hedged) ids.push('claim.hedged');
  if ((claim.targets || []).length > 0) ids.push('claim.has_target');
  // We always run the extractor through the assertive-anchor gate at extraction
  // time; presence in the emitted list confirms it passed.
  ids.push('claim.assertive_anchor');
  return ids;
}

// Classification features: categories, counts, pattern-IDs ONLY. NEVER raw
// substrings from the claim text (no hedge tokens, no verb tokens, no target
// values). The point is to ship the breadcrumbs the extractor already computed
// without back-dooring the text past the §1.3b exclusion.
function deriveClassificationFeatures(claim) {
  if (!claim) return {};
  const targets = claim.targets || [];
  const targetKinds = {};
  for (const t of targets) {
    const k = t && t.kind ? String(t.kind) : 'unknown';
    targetKinds[k] = (targetKinds[k] || 0) + 1;
  }
  return {
    hedge_count: (claim.hedgeWords || []).length,
    verb_count: (claim.verbs || []).length,
    verification_count: (claim.verificationWords || []).length,
    target_count: targets.length,
    target_kinds: targetKinds,
    is_hedged: !!claim.hedged,
    is_verification: !!claim.verificationClaim,
    pattern_ids: derivePatternIds(claim),
  };
}

// Outcome mapping. The matcher emits 5 claim-level outcomes plus 2 standalone
// buckets (undisclosed, silently_dropped); together that's the seven the brief
// defines. We don't remap names — we preserve the existing seven.
function normalizeClaimOutcome(outcome) {
  if (SEVEN_OUTCOMES.has(outcome)) return outcome;
  // matcher emits no other values for claim-level today; fall through honestly
  return outcome || 'unverifiable';
}

function deriveLastEventTs(sessionEvents) {
  let last = null;
  for (const e of sessionEvents) {
    if (e && e.ts && (last == null || e.ts > last)) last = e.ts;
  }
  return last;
}

// Build the per-claim entry. Sanitization runs per field; opt-in text fields
// are gated by `included` BEFORE being passed through the redactor.
function emitClaim(claimResult, includedSet, R) {
  const c = claimResult.claim || {};
  const outcome = normalizeClaimOutcome(claimResult.outcome);
  const features = deriveClassificationFeatures(c);

  // Evidence references — paths/commands sanitized, content bodies never
  // included (the matcher's evidence carries refs not bodies).
  const evidence = (claimResult.evidence || []).map((e) => {
    const out = { kind: e.kind || e.type || 'event' };
    if (e.path != null) out.ref = R.path(e.path);
    else if (e.rel_path != null) out.ref = R.path(e.rel_path);
    else if (e.command != null) out.ref = R.text(e.command);
    else if (e.host != null) out.ref = R.text(e.host);
    if (typeof e.exit_code === 'number') out.exit_code = e.exit_code;
    return out;
  });

  const entry = {
    id: c.id || null,
    claim_type: deriveClaimType(c),
    outcome,
    extraction_confidence: deriveExtractionConfidence(c),
    verdict_confidence: deriveVerdictConfidence(claimResult),
    evidence,
    cause_hint: (claimResult.causeHints && claimResult.causeHints[0]) || null,
    label: { value: null, source: null, labeled_at: null },
  };

  // classification_features: emit when there are any signals worth recording.
  // Always when claim_type=other (the breadcrumb case the brief calls out),
  // and also more broadly so the corpus has the calibration data — the rule
  // is "categories+counts+pattern-IDs only", never raw substrings.
  const hasAnyFeature =
    features.hedge_count > 0 ||
    features.verb_count > 0 ||
    features.verification_count > 0 ||
    features.target_count > 0 ||
    (features.pattern_ids || []).length > 0;
  if (hasAnyFeature) entry.classification_features = features;

  // Opt-in raw text. Sanitization ALWAYS runs on included fields; --include
  // gates entry into the pipeline, not whether sanitization is applied.
  if (includedSet.has('claim_text') && c.text != null) {
    entry.claim_text = R.text(c.text);
  }

  return entry;
}

function emitTurnReport(report, includedSet, R) {
  const claims = (report.claims || []).map((cr) => emitClaim(cr, includedSet, R));

  // Silently-dropped subtasks. Surface as task references, NEVER raw task
  // text. `task_ref` is an opaque handle — if/when prompt_text becomes an
  // opt-in, the raw string can ride alongside.
  const silentlyDropped = (report.subtasks || [])
    .filter((s) => s.outcome === 'silently_dropped')
    .map((s) => ({ task_ref: (s.task && s.task.id) || null }));

  // Undisclosed file changes. ref is a path, always sanitized.
  const undisclosed = (report.undisclosed || []).map((u) => {
    const ref = R.path(u.path);
    const out = { ref };
    if (u.occurrences && u.occurrences > 1) out.occurrences = u.occurrences;
    return out;
  });

  // Summary mirrors the seven outcomes — counted from the matcher summary
  // plus the standalone buckets. We preserve names, never invent.
  const s = report.summary || {};
  const summary = {
    verified: s.verified || 0,
    partial: s.partial || 0,
    phantom: s.phantom || 0,
    phantom_verification: s.phantom_verification || 0,
    unverifiable: s.unverifiable || 0,
    undisclosed: undisclosed.length,
    silently_dropped: silentlyDropped.length,
  };

  return {
    session_id: report.session_id,
    turn: report.turn_id,
    claims,
    undisclosed_changes: undisclosed,
    silently_dropped: silentlyDropped,
    summary,
  };
}

/**
 * Build the JSON payload. Pure function over inputs — no fs reads inside the
 * core (the CLI wires session events and reports in). Same inputs in →
 * byte-identical JSON out.
 *
 * @param {object} args
 * @param {string} args.sessionId
 * @param {string} args.agent
 * @param {Array}  args.reports        list of persisted per-turn reports (full envelope from src/reconcile/index.js)
 * @param {Array}  args.events         session events (for deterministic last-ts; pass empty array if unavailable)
 * @param {string} [args.turn]         emit only this turn id (e.g. 't12')
 * @param {Array}  [args.include]      raw text fields to include (e.g. ['claim_text'])
 * @param {object} [args.redactOpts]   forwarded to buildRedactor ({home, root})
 */
function buildJsonPayload(args) {
  const {
    sessionId,
    agent,
    reports = [],
    events = [],
    turn = null,
    include = [],
    redactOpts = {},
  } = args || {};

  const includedSet = new Set(
    (include || []).filter((f) => KNOWN_INCLUDE_FIELDS.has(f))
  );
  const R = buildRedactor(redactOpts);

  let selected = reports;
  if (turn) selected = reports.filter((r) => r.turn_id === turn);

  const turns = selected.map((r) => emitTurnReport(r, includedSet, R));

  // Aggregate summary across emitted turns.
  const agg = {
    verified: 0, partial: 0, phantom: 0, phantom_verification: 0,
    unverifiable: 0, undisclosed: 0, silently_dropped: 0,
  };
  for (const t of turns) {
    for (const k of Object.keys(agg)) agg[k] += (t.summary && t.summary[k]) || 0;
  }

  const lastTs = deriveLastEventTs(events);

  const payload = {
    schema_version: SCHEMA_VERSION,
    session_id: sessionId,
    agent: agent || null,
    generated_at: lastTs, // deterministic: max event ts in the session window
    included_fields: Array.from(includedSet).sort(),
    turns,
    summary: agg,
  };

  return payload;
}

function renderJson(args) {
  const payload = buildJsonPayload(args);
  return JSON.stringify(payload, null, 2);
}

module.exports = {
  SCHEMA_VERSION,
  KNOWN_INCLUDE_FIELDS,
  buildJsonPayload,
  renderJson,
  // Exposed for tests + the feedback module so it can reuse the same per-claim
  // mapping when it builds precision-corpus-superset entries.
  emitClaim,
  emitTurnReport,
  deriveClaimType,
  deriveExtractionConfidence,
  deriveVerdictConfidence,
  deriveClassificationFeatures,
  deriveLastEventTs,
};
