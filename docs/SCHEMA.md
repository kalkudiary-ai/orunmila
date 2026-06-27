# Orunmila JSON schema

`orunmila json` and `orunmila feedback` emit a machine-readable rendition of
the same reconciler output the terminal and HTML renderers consume. This is
**schema_version 1.0**.

## Versioning rule

> **Additive fields and new enum VALUES bump MINOR. Renamed/removed fields
> and changed enum SEMANTICS bump MAJOR.**

`classification_features`, `label`, and opt-in text fields (`claim_text`,
future `prompt_text`/`diff_hunks`/`command_output_snippets`) are additive and
optional → they will never break 1.x. Downstream consumers should pin to
`>=1.0 <2.0`.

## `orunmila json` — per-session payload

```json
{
  "schema_version": "1.0",
  "session_id": "string",
  "agent": "claude-code",
  "generated_at": "ISO-8601",      // deterministic: max event ts in the session window
  "included_fields": [],            // raw text fields opted in via --include
  "turns": [
    {
      "session_id": "...",
      "turn": "t12",
      "claims": [
        {
          "id": "claim1",
          "claim_type": "did | tested | fixed | added | unverifiable | other",
          "outcome": "verified | partial | phantom | phantom_verification | unverifiable",
          "extraction_confidence": "high | medium | low",
          "verdict_confidence": "high | medium | low",
          "evidence": [
            { "kind": "diff",    "ref": "~/proj/app/auth.js" },
            { "kind": "command", "ref": "npm test", "exit_code": 0 }
          ],
          "cause_hint": null,
          "label": { "value": null, "source": null, "labeled_at": null },
          "classification_features": {
            "hedge_count": 0,
            "verb_count": 1,
            "verification_count": 0,
            "target_count": 1,
            "target_kinds": { "phrase": 1 },
            "is_hedged": false,
            "is_verification": false,
            "pattern_ids": ["claim.assertive_anchor", "claim.action_verb", "claim.has_target"]
          },
          "claim_text": "added validation to the inquiry endpoint"  // ONLY if --include claim_text
        }
      ],
      "undisclosed_changes": [{ "ref": "~/proj/scratch/x.js", "occurrences": 2 }],
      "silently_dropped":   [{ "task_ref": "task1" }],
      "summary": {
        "verified": 1, "partial": 0, "phantom": 0, "phantom_verification": 0,
        "unverifiable": 0, "undisclosed": 1, "silently_dropped": 1
      }
    }
  ],
  "summary": { "verified": 1, "partial": 0, "phantom": 0, "phantom_verification": 0,
               "unverifiable": 0, "undisclosed": 1, "silently_dropped": 1 }
}
```

### Fields

- **`generated_at`** — derived from the **maximum event timestamp** in the
  session window. Wall-clock is never read. This is what makes the emitter
  byte-deterministic.
- **`included_fields`** — exhaustive list of opt-in text fields present in
  this payload. Consumers should consult this array directly rather than
  inferring from field presence/absence.
- **Two confidence axes** —
  - `extraction_confidence`: how sure is the engine that this *text* is a
    claim of this *type*? Use this for claim-ID calibration.
  - `verdict_confidence`: how sure is the engine that the outcome is right,
    **given** the parse was correct?
  They are deliberately not fused; fusing them makes calibration analysis
  impossible.
- **`claim_type`** — coarse classification (`did | tested | fixed | added |
  unverifiable | other`). Ships `other`-heavy on purpose in 1.0. The real
  classifier is intentionally out of scope; the accuracy loop will drive it
  from the corpus.
- **`classification_features`** — categories, counts, and pattern-ID
  references **only**. Never raw substrings from the claim text. This is the
  privacy guarantee that lets the feature breadcrumbs ship by default even
  when `--include claim_text` is off.
- **`label`** — reserved slot, all-null by default in 1.0. Lets an optional
  labeling pass land later without a schema bump:
  - `value`: `null | "claim" | "not_claim" | "ambiguous"`
  - `source`: `null | "human" | "auto"` (so future auto-labels never
    poison the human ground-truth set)
  - `labeled_at`: `null | ISO-8601`
- **`evidence[].ref`** — path/command/host references. Always sanitized
  (home-prefix collapse + `.orunmila/redact`), regardless of `--include`.
- **`undisclosed_changes[].ref`** — sanitized path of a file change covered
  by no claim and no subtask.
- **`silently_dropped[].task_ref`** — opaque handle into the prompt-task
  index. **Never** raw task text; raw text would gate on a future
  `--include prompt_text`.

### `--include` (raw text opt-ins)

Default: nothing. The emitter ships shape (counts, categories, pattern-IDs)
only.

| field          | opt-in flag                | what it adds                    |
|----------------|----------------------------|---------------------------------|
| `claim_text`   | `--include claim_text` (or `--include-text` shorthand) | sanitized agent claim text |
| `prompt_text`  | reserved (not in 1.0)      | sanitized user prompt text      |
| `diff_hunks`   | reserved (not in 1.0)      | sanitized diff bodies           |
| `command_output_snippets` | reserved (not in 1.0) | sanitized command output |

Sanitization runs on **every string-valued field that exits**, defaults AND
opt-ins — not only `--include` fields. `--include` controls which raw text
fields *enter* the pipeline; sanitization always runs on what does.

## `orunmila feedback` — per-session drop file

The feedback file wraps the `orunmila json` payload (as `report`) and adds a
`cases[]` array. Each entry in `cases[]` is a **strict superset of
`test/cases/precision/*.json`** so `orunmila feedback-import` can copy each
entry into the precision corpus with no translation:

```json
{
  "schema_version": "1.0",
  "session_id": "...",
  "agent": "claude-code",
  "generated_at": "ISO-8601",
  "included_fields": ["claim_text"],
  "report": { /* the `orunmila json` payload */ },
  "cases": [
    {
      "name":   "feedback: <session>/<turn>/<claim> — <outcome>",
      "note":   "Auto-generated from a live session ...",
      "source": "feedback:session=<sid>;turn=<tid>;claim=<cid>",
      "kind":   "positive",
      "prompt": null,
      "claim":  "added validation to the inquiry endpoint",
      "events": [ /* sanitized */ ],
      "expect": { "claim_outcomes_include": ["verified"] },

      "claim_type": "added",
      "outcome": "verified",
      "extraction_confidence": "high",
      "verdict_confidence": "high",
      "evidence": [ /* sanitized refs */ ],
      "label": { "value": null, "source": null, "labeled_at": null },
      "classification_features": { /* categories + counts + pattern-IDs */ }
    }
  ]
}
```

When `--include claim_text` is not passed, `cases[i].claim` is `null` and
`cases[i].events` is empty — the case stays shape-valid but is not
corpus-runnable. The drop folder's README explains this in plain English.
`feedback-import` skips cases with no claim text rather than polluting the
corpus.

## Stable enums

- **`outcome`** (claim-level): `verified | partial | phantom |
  phantom_verification | unverifiable`. Top-level `undisclosed_changes[]`
  and `silently_dropped[]` carry the other two of the seven canonical
  outcomes.
- **`claim_type`**: `did | tested | fixed | added | unverifiable | other`.
- **`extraction_confidence`** / **`verdict_confidence`**: `high | medium | low`.
- **`label.value`**: `null | claim | not_claim | ambiguous`.
- **`label.source`**: `null | human | auto`.

Adding new values to any of these is a MINOR bump. Renaming or changing the
semantics of an existing value is MAJOR.
