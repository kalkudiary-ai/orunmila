# Changelog

All notable changes to orunmila are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While orunmila is pre-1.0, breaking changes may land in any `0.x` release.

## [Unreleased]

### Added

- **Machine-readable JSON emitter (`orunmila json`).** Third sibling of the
  terminal and HTML renderers — same reconciler output, new format.
  schema_version `1.0`. Pure and deterministic: same event log + same options
  → byte-identical JSON, including `generated_at` (derived from the last
  event ts, not wall-clock). Two confidence axes per claim are emitted
  separately — `extraction_confidence` (is this text a claim of this type?)
  and `verdict_confidence` (is the outcome right given correct parse?) —
  because fusing them makes calibration analysis impossible. `claim_type`
  ships `other`-heavy on purpose; building a real classifier is the first
  thing the corpus loop will drive. Reserves a 3-field `label` slot
  (`value`/`source`/`labeled_at`) so an optional labeling pass can land
  later with no schema bump. See [docs/SCHEMA.md](docs/SCHEMA.md).
- **Homeward feedback pipe (`orunmila feedback`).** Writes sanitized
  per-session accuracy cases to a local `.orunmila-feedback/` drop folder.
  Each `cases[i]` entry is a **strict superset of `test/cases/precision/*.json`** —
  the precision corpus the engine already scores against — so contributing
  back is a copy, not a translation. INDEX.md points home with exact
  contribution steps.
- **Corpus ingest (`orunmila feedback-import`).** Walks a drop folder and
  copies `cases[]` entries into `test/cases/precision/` as standalone case
  files. Non-destructive: never overwrites without `--force`; skips and
  reports collisions.
- **Per-field text inclusion (`--include`).** Raw text fields are excluded
  by default — `--include claim_text` opts the claim text in. Reserved
  future opt-ins: `prompt_text`, `diff_hunks`, `command_output_snippets`.
  Sanitization (home-prefix collapse + `.orunmila/redact`) is applied
  per-string-field DURING emit (never post-serialization), on default AND
  opt-in fields. `--include` only gates which raw text fields ENTER the
  pipeline; sanitization always runs on what exits. Keeps "privacy-clean by
  construction" literally true even with `--include claim_text`.
- **`classification_features` breadcrumbs.** When a claim's type can't be
  cleanly resolved, the JSON emitter records the categories, counts, and
  pattern-IDs the extractor already computed (`hedge_count`, `verb_count`,
  `target_kinds`, `pattern_ids: ["claim.assertive_anchor", …]`) — never
  raw substrings from the claim text. This is the privacy guarantee that
  lets the feature signal ship by default without leaking the original
  phrasing when `--include claim_text` is off.
- **Nickname: *The Diviner*.** Adopted across user-facing surfaces —
  README hero, benchmark divinations doc, dashboard intro. Reflects
  Orunmila's role as the Yoruba orisha of wisdom and divination, and the
  tool's role as the one that reads what an agent actually did.
- **Glossary tab in the HTML report.** Every outcome, channel, and metric
  defined in plain English with severity coding, so a first-time viewer
  can self-onboard without leaving the page.
- **3D Graph tab.** Force-directed WebGL view of the session graph with
  hover/click detail, particle-animated edges, and channel/outcome filters.
  Rewritten to use a single-script bundled UMD (no chained loader / no
  context leaks) with a lenient `rendererConfig` for restrictive Chrome
  states.
- **Model personality summaries** in `bench-results/README.md` — one-line
  character reads for every benchmarked model, grounded in the specific
  metric that distinguishes it (ConfIdx, phantom rate, claim volume, etc.).

### Changed

- **Report tab reordered**: stats → copy-paste prompt → findings. The
  prompt is the action; it shouldn't be buried under the findings list.
- **Dashboard default port** is now `3773` (was `3000`). Override with
  `PORT=… node bin/dashboard.js`.
- **"Results" → "Divinations"** in user-facing labels (`bench-results/README.md`,
  main README). Directory paths and code identifiers are unchanged for
  backwards compatibility.

### Fixed

- **3D Graph black-screen / failed-load.** Previous version chained three
  separate `<script>` loads (three.js + OrbitControls + 3d-force-graph),
  with `examples/js/controls/OrbitControls.js` removed in three.js v0.148+,
  so the chain stalled. Loading three.js separately also conflicted with
  the bundled copy inside 3d-force-graph, stacking WebGL contexts until
  Chrome's per-process cap blacked out the canvas. New loader uses a
  single UMD that bundles its own three.js, disposes the previous
  instance on re-render, and falls back to jsdelivr if unpkg fails.

- **Antigravity adapter.** Native support for Google's agent-first IDE —
  `orunmila install --agent antigravity` writes hooks into `.agents/hooks.json`
  (or `~/.gemini/config/hooks.json` with `--global`). Handles the nested
  `toolCall.name` / `toolCall.args` payload and Antigravity's tool names
  (`edit_file`, `view_file`, `run_command`, `grep_search`, `find_by_name`).
- **`orunmila stats` command.** Cross-agent aggregate statistics: reliability
  scores, phantom rates, tool-use profiles, and a side-by-side comparison
  table when multiple agents have been captured.
- **Benchmark runner with full reconciliation.** `bin/bench.js` runs the
  10-task corpus against any agent's CLI with orunmila hooks installed,
  capturing phantoms, phantom verifications, silently dropped asks, wild
  writes, and reliability scores per task — not just pass/fail.
  Supports `--model` for tier comparison (e.g. `--model haiku` vs `--model
  opus`). Results auto-save to `bench-results/` as structured JSON.
  Supports Claude Code and Gemini CLI (`--agent gemini-cli`).

## [0.1.0] — 2026-06-20

First public release. orunmila dye-stains an AI coding agent's session:
it verifies what the agent *claimed* against what it *actually did*, and
renders the result as a colored map of the codebase.

### Added

- **The reconciler (the skeptic).** Reconciles each turn's narrative against
  the event log and stains only the mismatches: `phantom`,
  `phantom_verification`, `silently_dropped`, `undisclosed`, and
  `untracked_write`. Verified claims are stained green.
- **The glove (the complete trail).** The inverse lens on the same event log:
  every read, write, command, and network call is captured and trailed, and
  turn-scoped lineage infers which writes were derived from which reads
  (labelled as a heuristic where the user can see it).
- **Filesystem Sentinel.** An independent on-disk observer that detects writes
  the agent never reported (`untracked_write`), correlated into a turn by a
  time window.
- **Stain-first visual report.** A single self-contained HTML page with
  tabbed Graph / Tree / Timeline / Dashboard views.
- **Claude Code capture hooks** (`install`), with an agent-agnostic registry
  (`src/capture/agents.js`) so new agents are a registry entry, not a fork.
- **`orunmila demo`.** Renders a sample unified report from a scripted session
  with zero setup — the real renderer fed scripted events.
- **Render-time redaction.** Home-prefix collapse on by default, plus an
  opt-in `.orunmila/redact` list, for safely sharing a report.
- Zero runtime dependencies; no network calls by the tool itself; no account
  or API key. Everything stays local in `~/.orunmila/`.

[Unreleased]: https://github.com/kalkudiary-ai/orunmila/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kalkudiary-ai/orunmila/releases/tag/v0.1.0
