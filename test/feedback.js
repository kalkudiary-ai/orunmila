'use strict';

/**
 * test/feedback.js
 *
 * DoD tests for the v2.1 JSON emitter + feedback pipe.
 *
 *   1. Determinism golden-file: same reports + events + options → byte-identical
 *      JSON, including `generated_at` (derived from the last event ts).
 *   2. Sanitization: with `--include claim_text` and a `.orunmila/redact`
 *      containing 'SECRET', a claim text 'added SECRET handling' renders as
 *      'added [redacted] handling' in the JSON, AND the surrounding JSON is
 *      still valid (no broken structure from a post-serialization redact).
 *   3. No-substring: classification_features carries categories/counts/pattern-IDs
 *      only — NEVER raw substrings from the claim text (so the feature
 *      breadcrumbs can ship by default without leaking the original phrasing).
 *
 * Plus a smoke test that the feedback pipe writes a corpus-superset file
 * whose `cases[i]` shape matches the existing precision-corpus loader.
 */

const { assert, fs, path, tmpHome, tmpDir, rmrf, it, runAll } = require('./helpers');

const { renderJson, buildJsonPayload, deriveClassificationFeatures } = require('../src/render/json');
const { writeFeedback, buildFeedbackPayload, importFeedback } = require('../src/feedback');

const SAMPLE_REPORT = {
  session_id: 'sess-1',
  turn_id: 't1',
  generated_at: '2026-01-01T00:00:00.000Z', // wall-clock from old persisted code; emitter ignores this
  claims: [
    {
      claim: {
        id: 'claim1',
        text: 'I added SECRET handling to the auth route.',
        verbs: ['added'],
        targets: [{ value: 'auth route', kind: 'phrase' }],
        keywords: ['auth route'],
        hedged: false,
        hedgeWords: [],
        verificationClaim: false,
        verificationWords: [],
      },
      provenance: 'evidence',
      causeHints: [],
      evidence: [{ kind: 'diff', path: '/Users/jane/proj/app/auth.js' }],
      outcome: 'verified',
    },
    {
      claim: {
        id: 'claim2',
        text: 'I think I might have tested the login flow.',
        verbs: [],
        targets: [{ value: 'login flow', kind: 'phrase' }],
        keywords: ['login flow'],
        hedged: true,
        hedgeWords: ['I think', 'might'],
        verificationClaim: true,
        verificationWords: ['tested'],
      },
      provenance: 'no_command',
      causeHints: ['vague-hedge'],
      evidence: [],
      outcome: 'phantom_verification',
    },
  ],
  subtasks: [
    {
      task: { id: 'task1', text: 'add password reset', targets: [{ value: 'password reset', kind: 'phrase' }] },
      outcome: 'silently_dropped',
      evidence: [],
    },
  ],
  undisclosed: [{ path: '/Users/jane/proj/secret/keys.js', occurrences: 2 }],
  untracked: [],
  summary: {
    verified: 1, partial: 0, phantom: 0, phantom_verification: 1,
    unverifiable: 0, silently_dropped: 1, unverifiable_ask: 0,
    undisclosed_changes: 1, untracked_writes: 0,
  },
};

const SAMPLE_EVENTS = [
  { ts: '2026-06-27T10:00:00.000Z', type: 'user_prompt', text: 'add SECRET handling and a password reset' },
  { ts: '2026-06-27T10:00:05.123Z', type: 'file_write', path: '/Users/jane/proj/app/auth.js' },
  { ts: '2026-06-27T10:00:09.999Z', type: 'turn_claim', text: 'done.' },
];

// Helper: stage a temp working dir with .orunmila/redact and chdir into it.
function withRedactRoot(entries, fn) {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.orunmila'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.orunmila', 'redact'), entries.join('\n') + '\n');
  const cwd0 = process.cwd();
  process.chdir(dir);
  try { return fn(dir); } finally { process.chdir(cwd0); rmrf(dir); }
}

it('determinism: same inputs → byte-identical JSON (incl. generated_at derived from last event ts)', () => {
  tmpHome();
  const a = renderJson({
    sessionId: 'sess-1', agent: 'claude-code',
    reports: [SAMPLE_REPORT], events: SAMPLE_EVENTS,
    include: [], redactOpts: { home: true, root: process.cwd() },
  });
  const b = renderJson({
    sessionId: 'sess-1', agent: 'claude-code',
    reports: [SAMPLE_REPORT], events: SAMPLE_EVENTS,
    include: [], redactOpts: { home: true, root: process.cwd() },
  });
  assert.strictEqual(a, b, 'two renders of identical inputs must be byte-identical');

  const parsed = JSON.parse(a);
  assert.strictEqual(parsed.schema_version, '1.0');
  assert.strictEqual(parsed.generated_at, '2026-06-27T10:00:09.999Z',
    'generated_at must be the max event ts (deterministic), not wall-clock');
});

it('sanitization: --include claim_text + redact list masks SECRET; JSON stays valid', () => {
  tmpHome();
  withRedactRoot(['SECRET'], (root) => {
    const json = renderJson({
      sessionId: 'sess-1', agent: 'claude-code',
      reports: [SAMPLE_REPORT], events: SAMPLE_EVENTS,
      include: ['claim_text'],
      redactOpts: { home: true, root },
    });
    // 1. Must still parse — proves redaction did NOT happen via
    //    string-substitution over the serialized output.
    const parsed = JSON.parse(json);
    // 2. The SECRET substring is gone from the masked claim_text.
    const claim1 = parsed.turns[0].claims[0];
    assert.ok(claim1.claim_text, 'claim_text must be present when --include claim_text');
    assert.ok(!/SECRET/.test(claim1.claim_text),
      'redact list entry SECRET must be masked in claim_text');
    assert.ok(/\[redacted\]/.test(claim1.claim_text),
      'masked spot should be the [redacted] placeholder');
  });
});

it('classification_features carries categories/counts/pattern-IDs only — no raw substrings', () => {
  const claim = SAMPLE_REPORT.claims[1].claim; // hedged + verification claim
  const features = deriveClassificationFeatures(claim);

  // Sanity: the counts are present and reflect the input.
  assert.strictEqual(features.hedge_count, 2);
  assert.strictEqual(features.verification_count, 1);

  // The contract: features serialized into JSON contain NO raw hedge token or
  // verb word from the source claim text. This is what stops `--include
  // claim_text` opt-out from being silently bypassed by feature breadcrumbs.
  const serialized = JSON.stringify(features);
  for (const tok of ['I think', 'might', 'tested', 'login flow']) {
    assert.ok(!serialized.includes(tok),
      `classification_features leaked raw substring '${tok}' from claim text`);
  }

  // Pattern-IDs are stable category identifiers — these ARE allowed.
  assert.ok(features.pattern_ids.includes('claim.verification'));
  assert.ok(features.pattern_ids.includes('claim.hedged'));
});

it('feedback pipe writes a corpus-superset file; cases[i] shape matches precision-corpus loader', () => {
  tmpHome();
  const root = tmpDir();
  process.env.ORUNMILA_FEEDBACK_TEST_CWD = root;
  const cwd0 = process.cwd();
  process.chdir(root);
  try {
    const { file, payload } = writeFeedback({
      sessionId: 'sess-2', agent: 'claude-code',
      reports: [SAMPLE_REPORT], events: SAMPLE_EVENTS,
      dir: path.join(root, '.orunmila-feedback'),
      include: ['claim_text'],
      redactOpts: { home: true, root },
    });
    assert.ok(fs.existsSync(file), 'feedback file should exist');
    assert.strictEqual(payload.cases.length, 2, 'one case per claim');

    // Re-run produces a byte-identical file (idempotent overwrite, not collision).
    const a = fs.readFileSync(file, 'utf8');
    const { file: file2 } = writeFeedback({
      sessionId: 'sess-2', agent: 'claude-code',
      reports: [SAMPLE_REPORT], events: SAMPLE_EVENTS,
      dir: path.join(root, '.orunmila-feedback'),
      include: ['claim_text'],
      redactOpts: { home: true, root },
    });
    assert.strictEqual(file2, file, 'same session → same filename (no -2 suffix)');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), a,
      'rerun must be byte-identical (idempotent overwrite)');

    // cases[i] must carry the corpus shape AT LEAST. The accuracy.js loader
    // reads {prompt, claim, events, expect} via JSON.parse + Object.assign,
    // so additive fields are non-breaking.
    for (const c of payload.cases) {
      assert.ok('name' in c && 'note' in c && 'source' in c && 'kind' in c,
        'corpus metadata fields missing');
      assert.ok('prompt' in c && 'claim' in c && 'events' in c && 'expect' in c,
        'corpus runner fields missing');
      assert.ok(c.expect && (c.expect.claim_outcomes_include || c.expect.not_outcomes),
        'expect block must carry a dimension the runner checks');
      // additive fields the feedback loop relies on
      assert.ok('claim_type' in c && 'outcome' in c, 'feedback additions missing');
      assert.ok('extraction_confidence' in c && 'verdict_confidence' in c, 'split confidence missing');
      assert.ok(c.label && c.label.value === null && c.label.source === null,
        'label slot must be reserved with all-null defaults');
    }
  } finally {
    process.chdir(cwd0);
    rmrf(root);
  }
});

it('feedback-import copies cases[] into the corpus dir; non-destructive on collision', () => {
  tmpHome();
  const root = tmpDir();
  const corpusDir = path.join(root, 'corpus');
  const cwd0 = process.cwd();
  process.chdir(root);
  try {
    writeFeedback({
      sessionId: 'sess-3', agent: 'claude-code',
      reports: [SAMPLE_REPORT], events: SAMPLE_EVENTS,
      dir: path.join(root, '.orunmila-feedback'),
      include: ['claim_text'],
      redactOpts: { home: true, root },
    });
    const stats = importFeedback({
      dir: path.join(root, '.orunmila-feedback'),
      corpusDir,
      force: false,
    });
    assert.ok(stats.written >= 1, 'at least one case should be written');
    const stats2 = importFeedback({
      dir: path.join(root, '.orunmila-feedback'),
      corpusDir,
      force: false,
    });
    assert.strictEqual(stats2.written, 0, 'second import without --force writes nothing');
    assert.ok(stats2.skipped >= 1, 'second import reports the skip');
  } finally {
    process.chdir(cwd0);
    rmrf(root);
  }
});

it('without --include claim_text, claim_text is absent and cases[] are not corpus-runnable', () => {
  tmpHome();
  const root = tmpDir();
  process.chdir(root);
  try {
    const payload = buildJsonPayload({
      sessionId: 'sess-4', agent: 'claude-code',
      reports: [SAMPLE_REPORT], events: SAMPLE_EVENTS,
      include: [], // shape-only default
      redactOpts: { home: true, root },
    });
    for (const t of payload.turns) {
      for (const c of t.claims) {
        assert.ok(!('claim_text' in c),
          'claim_text must be absent by default (privacy guarantee)');
      }
    }
    assert.deepStrictEqual(payload.included_fields, []);

    const fb = buildFeedbackPayload({
      sessionId: 'sess-4', agent: 'claude-code',
      reports: [SAMPLE_REPORT], events: SAMPLE_EVENTS,
      include: [],
      redactOpts: { home: true, root },
    });
    for (const c of fb.cases) {
      assert.strictEqual(c.claim, null, 'cases[i].claim must be null without opt-in');
      assert.deepStrictEqual(c.events, [], 'events stripped without opt-in');
    }
  } finally {
    rmrf(root);
  }
});

runAll('feedback');
