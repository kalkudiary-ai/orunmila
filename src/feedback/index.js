'use strict';

/**
 * feedback/index.js
 *
 * The homeward feedback pipe (Build Brief v2.1 §2). Writes sanitized
 * per-session "accuracy cases" to a local drop folder so they can be pushed
 * back into Orunmila's own precision/test corpus to sharpen claim detection
 * over time.
 *
 * Hard contracts:
 *   - LOCAL ONLY. No network, no auto-PRs, no telemetry.
 *   - REUSES src/render/redact.js for the privacy sanitization passes — never
 *     a second redactor. `--include` gates which raw TEXT fields enter the
 *     pipeline; sanitization always runs on what does enter, plus on every
 *     path-bearing default field.
 *   - The per-claim `cases[]` entries are a STRICT SUPERSET of
 *     test/cases/precision/*.json (verified against
 *     test/cases/precision/14-markdown-headings-and-tables.json and
 *     consumed by test/accuracy.js:54 with Object.assign so additive fields
 *     never break the loader). `feedback-import` writes each `cases[i]`
 *     into the corpus as a standalone `.json` — pure `cp` of the entry.
 *   - Deterministic: same event log + same option set → byte-identical file.
 *     The filename embeds the last-event date (not wall-clock), so re-running
 *     on the same session produces an idempotent overwrite, NOT a collision.
 *     Do not add a `-2.json` suffix scheme.
 *   - Zero new runtime dependencies; offline + MIT preserved.
 *
 * Note about cases[] population: a precision case is only USEFUL when its
 * `claim` field carries the actual text — the test loader feeds it through
 * the live reconciler. So `cases[]` is populated only when `--include
 * claim_text` is requested. Without it, the drop file is still written (with
 * the §1.1 report + ambient signals + an empty `cases[]`), but the corpus
 * loop has nothing to ingest. The README in the drop folder calls this out.
 */

const fs = require('fs');
const path = require('path');

const { buildJsonPayload, KNOWN_INCLUDE_FIELDS, deriveClaimType,
  deriveExtractionConfidence, deriveVerdictConfidence,
  deriveClassificationFeatures, deriveLastEventTs } = require('../render/json');
const { buildRedactor } = require('../render/redact');

const REPO_URL = 'https://github.com/kalkudiary-ai/orunmila';
const REPO_PRECISION_DIR = 'test/cases/precision/';

// --- Pure shapers (no fs) --------------------------------------------------

/**
 * Build a precision-corpus-superset entry from a single claimResult + its
 * containing turn report. Strict superset of test/cases/precision/*.json:
 *   { name, note, source, kind, prompt, claim, events, expect }
 * plus our additions (claim_type, outcome, extraction_confidence,
 * verdict_confidence, evidence, label, classification_features).
 *
 * When `claim_text` is NOT in includedSet, `claim` is null and `events` is []
 * — the case is shape-valid but not corpus-runnable. The drop file's README
 * explains this to the human reader.
 */
function buildCorpusCase({ claimResult, report, sessionId, includedSet, R, turnEvents }) {
  const c = (claimResult && claimResult.claim) || {};
  const outcome = claimResult.outcome || 'unverifiable';
  const includeClaim = includedSet.has('claim_text');

  // The corpus loader passes `c.events` straight into reconcileTurn; we only
  // emit events when the claim text is included (otherwise the loader has no
  // claim to reconcile and the case is decorative).
  const eventsForCase = includeClaim ? (turnEvents || []).map((e) => sanitizeEvent(e, R)) : [];

  const entry = {
    // ---- precision-corpus shape (strict superset) ----
    name: `feedback: ${sessionId}/${report.turn_id}/${c.id || 'claim?'} — ${outcome}`,
    note: 'Auto-generated from a live session. '
      + (includeClaim
        ? 'Claim/events populated via --include claim_text.'
        : 'Claim text not included (re-run with --include claim_text to make this case corpus-runnable).')
      + ' Human review can override the verdict via the label slot.',
    source: `feedback:session=${sessionId};turn=${report.turn_id};claim=${c.id || ''}`,
    kind: 'positive', // a live-detected claim; flip to 'negative' via label if human marks not_claim
    prompt: null,     // future: populated when --include prompt_text lands
    claim: includeClaim ? R.text(c.text || '') : null,
    events: eventsForCase,
    expect: {
      // Use the actual outcome as the regression anchor. A future labeling
      // tool can rewrite this from the `label.value` if a human overrides.
      claim_outcomes_include: [outcome],
    },

    // ---- additive fields (corpus loader ignores via Object.assign) ----
    claim_type: deriveClaimType(c),
    outcome,
    extraction_confidence: deriveExtractionConfidence(c),
    verdict_confidence: deriveVerdictConfidence(claimResult),
    evidence: (claimResult.evidence || []).map((e) => sanitizeEvidence(e, R)),
    label: { value: null, source: null, labeled_at: null },
    classification_features: deriveClassificationFeatures(c),
  };

  return entry;
}

function sanitizeEvidence(e, R) {
  const out = { kind: e.kind || e.type || 'event' };
  if (e.path != null) out.ref = R.path(e.path);
  else if (e.rel_path != null) out.ref = R.path(e.rel_path);
  else if (e.command != null) out.ref = R.text(e.command);
  else if (e.host != null) out.ref = R.text(e.host);
  if (typeof e.exit_code === 'number') out.exit_code = e.exit_code;
  return out;
}

// An event going into a corpus case needs the same shape the test loader
// expects. Strip volatile fields (timestamps, session ids) so the case is
// deterministic and portable.
function sanitizeEvent(e, R) {
  if (!e) return e;
  const out = { type: e.type };
  if (e.path != null) out.path = R.path(e.path);
  if (e.rel_path != null) out.rel_path = R.path(e.rel_path);
  if (e.diff != null) out.diff = R.text(e.diff);
  if (e.command != null) out.command = R.text(e.command);
  if (e.host != null) out.host = R.text(e.host);
  if (e.failed != null) out.failed = e.failed;
  if (typeof e.exit_code === 'number') out.exit_code = e.exit_code;
  return out;
}

/**
 * Build the full session-level feedback payload: the §1 report PLUS a
 * `cases[]` array of corpus-superset entries.
 */
function buildFeedbackPayload(args) {
  const {
    sessionId, agent, reports = [], events = [],
    include = [], redactOpts = {},
  } = args || {};

  const includedSet = new Set(
    (include || []).filter((f) => KNOWN_INCLUDE_FIELDS.has(f))
  );
  const R = buildRedactor(redactOpts);

  // Reuse the §1 emitter for the `report` block so the two surfaces never drift.
  const report = buildJsonPayload({
    sessionId, agent, reports, events, include, redactOpts,
  });

  // Build cases[] from every claim across every turn. We hand each
  // buildCorpusCase the turn's events so the case becomes self-contained.
  const cases = [];
  for (const turnReport of reports) {
    const turnEvents = (turnReport.events || []); // most persisted reports don't carry events
    for (const claimResult of (turnReport.claims || [])) {
      cases.push(buildCorpusCase({
        claimResult,
        report: turnReport,
        sessionId,
        includedSet,
        R,
        turnEvents,
      }));
    }
  }

  return {
    schema_version: report.schema_version,
    session_id: sessionId,
    agent: agent || null,
    generated_at: deriveLastEventTs(events),
    included_fields: report.included_fields,
    report,
    cases,
  };
}

// --- IO helpers (write the drop folder) ------------------------------------

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// Derive a YYYY-MM-DD date stamp from an ISO timestamp deterministically.
// Returns 'unknown-date' if no timestamp is available (rare; only when a
// session has zero events, which shouldn't happen in practice).
function dateStamp(iso) {
  if (!iso) return 'unknown-date';
  // ISO ts: 2026-06-27T13:45:02.123Z → 2026-06-27
  return String(iso).slice(0, 10);
}

function writeIndexAndReadme(dir) {
  const indexPath = path.join(dir, 'INDEX.md');
  const readmePath = path.join(dir, 'README.md');

  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, [
      '# Orunmila feedback drop',
      '',
      'Push these sanitized session cases to Orunmila to improve claim detection.',
      `Upstream: ${REPO_URL}`,
      '',
      `Each \`sessions/<date>-<session>.json\` file contains a per-session report plus a \`cases[]\` array.`,
      `Each entry in \`cases[]\` is a strict superset of \`${REPO_PRECISION_DIR}*.json\` —`,
      `they drop into the corpus as standalone files via \`orunmila feedback-import <dir>\`.`,
      '',
      'Privacy: home paths collapsed to `~` and `.orunmila/redact` masked by default.',
      'Raw claim text rides home only when you opt in with `--include claim_text`.',
      '',
    ].join('\n'));
  }

  // INDEX.md is regenerated each run — it's a listing.
  const sessionsDir = path.join(dir, 'sessions');
  let files = [];
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')).sort();
  } catch { /* dir may not exist yet */ }

  const lines = [
    '# Feedback drop — INDEX',
    '',
    `Drop folder: \`${path.relative(process.cwd(), dir) || '.'}\``,
    `Upstream:    ${REPO_URL}`,
    '',
    '## How to contribute these cases to Orunmila',
    '',
    '1. Clone or pull the upstream repo.',
    '2. Copy each `sessions/<file>.json` into a temporary directory.',
    `3. From inside the Orunmila checkout, run \`orunmila feedback-import <that-dir>\` —`,
    `   it iterates \`cases[]\` and writes each entry into \`${REPO_PRECISION_DIR}\` as a`,
    '   standalone case file. The format is a strict superset of the existing precision',
    `   cases, so \`test/accuracy.js\` picks them up automatically.`,
    `4. Run \`node test/accuracy.js\` to see the new cases in the precision report,`,
    '   commit, open a PR.',
    '',
    '## Files',
    '',
    ...(files.length
      ? files.map((f) => `- sessions/${f}`)
      : ['(none yet)']),
    '',
  ];
  fs.writeFileSync(indexPath, lines.join('\n'));
}

/**
 * Write a sanitized feedback file for a session.
 *   args.sessionId, args.agent, args.reports, args.events
 *   args.dir            destination root (default '.orunmila-feedback')
 *   args.include        opt-in text fields
 *   args.redactOpts     forwarded to buildRedactor
 * Returns { file, payload, dir }.
 */
function writeFeedback(args) {
  const dir = args.dir || path.join(process.cwd(), '.orunmila-feedback');
  ensureDir(path.join(dir, 'sessions'));

  const payload = buildFeedbackPayload(args);
  const stamp = dateStamp(payload.generated_at);
  const fileName = `${stamp}-${args.sessionId}.json`;
  const filePath = path.join(dir, 'sessions', fileName);

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  writeIndexAndReadme(dir);

  return { file: filePath, payload, dir };
}

// --- Ingest side: write cases[] entries into the precision corpus ----------

/**
 * Walk a directory of feedback files and copy each `cases[i]` into
 * test/cases/precision/. Non-destructive: never overwrite without --force.
 */
function importFeedback({ dir, corpusDir, force = false, logger = () => {} }) {
  const stats = { read: 0, written: 0, skipped: 0, skippedReasons: [] };
  if (!fs.existsSync(dir)) {
    throw new Error(`Feedback dir not found: ${dir}`);
  }
  fs.mkdirSync(corpusDir, { recursive: true });

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  // Some drop folders nest sessions/ under the root — accept either layout.
  const sessionsDir = path.join(dir, 'sessions');
  const sessionFiles = fs.existsSync(sessionsDir)
    ? fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')).map((f) => path.join(sessionsDir, f))
    : [];
  const flatFiles = files.map((f) => path.join(dir, f)).filter((p) => fs.statSync(p).isFile());
  const allInputs = sessionFiles.concat(flatFiles);

  for (const inputPath of allInputs) {
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    } catch (e) {
      stats.skipped++;
      stats.skippedReasons.push(`${path.basename(inputPath)}: invalid JSON (${e.message})`);
      continue;
    }
    const cases = Array.isArray(payload && payload.cases) ? payload.cases : [];
    if (!cases.length) {
      stats.skipped++;
      stats.skippedReasons.push(`${path.basename(inputPath)}: no cases[] (re-run feedback with --include claim_text)`);
      continue;
    }

    for (const caseEntry of cases) {
      stats.read++;
      const safeName = caseEntryFilename(caseEntry, payload);
      const dest = path.join(corpusDir, safeName);
      if (fs.existsSync(dest) && !force) {
        stats.skipped++;
        stats.skippedReasons.push(`${safeName}: exists (use --force to overwrite)`);
        logger(`skip  ${safeName}  (exists)`);
        continue;
      }
      // Skip non-corpus-runnable cases (claim text absent) so the corpus
      // doesn't fill with shape-only entries that fail to reconcile.
      if (!caseEntry.claim) {
        stats.skipped++;
        stats.skippedReasons.push(`${safeName}: no claim text (re-run with --include claim_text)`);
        logger(`skip  ${safeName}  (no claim text)`);
        continue;
      }
      fs.writeFileSync(dest, JSON.stringify(caseEntry, null, 2) + '\n');
      stats.written++;
      logger(`write ${safeName}`);
    }
  }

  return stats;
}

function caseEntryFilename(caseEntry, payload) {
  // Try to derive something stable & human-readable. Falls back to a content
  // hash if the source string isn't usable as a path token.
  const source = caseEntry.source || '';
  const session = (payload && payload.session_id) || 'session';
  const m = source.match(/turn=([^;]+);claim=([^;]+)/);
  const slug = m ? `${m[1]}-${m[2]}` : 'feedback';
  return `feedback-${session.slice(0, 8)}-${slug}.json`.replace(/[^A-Za-z0-9._-]/g, '_');
}

module.exports = {
  buildFeedbackPayload,
  writeFeedback,
  importFeedback,
  writeIndexAndReadme,
  REPO_URL,
};
