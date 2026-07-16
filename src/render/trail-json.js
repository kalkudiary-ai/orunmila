'use strict';

/**
 * trail-json.js
 *
 * Machine-readable rendition of the trail (the glove) — the complete-trail lens
 * built by src/trail. Sibling of render/html.js and render/terminal.js: same
 * `trailForSession` model in, a new format out. It renders an EXISTING model and
 * never re-runs capture or detection.
 *
 * Deliberately NOT built on render/json.js: that emitter is shaped around the
 * reconciler's verdicts (claim_type / outcome / verdict_confidence / cause
 * hints). The trail has none of those concepts — it is recordings, not
 * judgments — so it carries its OWN schema version rather than borrowing the
 * reconciler schema and pretending the shapes match.
 *
 * Two modes:
 *   - default: the full trail, including the lineage layer (per-turn `edges` and
 *     each artifact's `touched_by` / `touched`). Those edges are a turn-scoped
 *     read->write heuristic, each stamped `inferred:true` upstream — honest, but
 *     still an inference.
 *   - factsOnly (--facts-only): the inference layer is dropped entirely, leaving
 *     pure recordings — touches, diffs, commands, exit codes, hashes, channels,
 *     sub-agent attribution. Nothing the tool guessed, only what it observed.
 *
 * Redaction (home-prefix collapse + .orunmila/redact) is applied by the caller
 * BEFORE the model reaches here (render/redact.js), same as the html/trail path.
 * This module is a pure model->string transform.
 */

const SCHEMA_VERSION = '1.0';

// Strip the one inferred field-set off a single artifact record (session-level
// or per-turn). Keeps every recording: touches, touch_count, channels,
// sub_agents, any_failed, path/key/label, and (per-turn) the ordered touches[].
function factsOnlyArtifact(a) {
  const out = {};
  for (const k of Object.keys(a)) {
    if (k === 'touched_by' || k === 'touched') continue; // the inferred lineage layer
    out[k] = a[k];
  }
  return out;
}

// Facts-only projection of the whole trail: drop per-turn `edges`, and the
// `touched_by`/`touched` arrays on every artifact (both the per-turn artifacts
// and the session-level roll-up). The chronological `trail[]` rows are already
// pure recordings and are kept as-is.
function toFactsOnly(trail) {
  return {
    ...trail,
    turns: (trail.turns || []).map((t) => {
      const out = {};
      for (const k of Object.keys(t)) {
        if (k === 'edges') continue; // inferred lineage edges
        if (k === 'artifacts') {
          out.artifacts = (t.artifacts || []).map(factsOnlyArtifact);
          continue;
        }
        out[k] = t[k];
      }
      return out;
    }),
    artifacts: (trail.artifacts || []).map(factsOnlyArtifact),
  };
}

/**
 * Render the trail model to a JSON string.
 *   opts.factsOnly  drop the inferred lineage layer (default false)
 * The output is `schema_version` + `facts_only` (so a consumer knows which mode
 * produced it) followed by the trail model's own fields.
 */
function renderTrailJson(trail, opts = {}) {
  const factsOnly = !!opts.factsOnly;
  const model = factsOnly ? toFactsOnly(trail) : trail;
  const payload = Object.assign(
    { schema_version: SCHEMA_VERSION, facts_only: factsOnly },
    model
  );
  return JSON.stringify(payload, null, 2);
}

module.exports = { renderTrailJson, toFactsOnly, SCHEMA_VERSION };
