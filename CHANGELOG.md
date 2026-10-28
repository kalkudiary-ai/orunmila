# Changelog

All notable changes to orunmila are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While orunmila is pre-1.0, breaking changes may land in any `0.x` release.

## [Unreleased]

### Fixed

- **The gate no longer judges the previous turn's claim text (P0-4).**
  `runGate` reads its claim from `lastAssistantText(transcript_path)`. When the
  Stop hook fired before the host had flushed that turn's final assistant
  message, it got the PREVIOUS turn's text and judged words the agent had not
  written in the turn being judged — measured in a real session as two
  consecutive turns with byte-identical captured claims, where the gate
  re-flagged a sentence that had already been retracted. It landed on the
  blocking path: an agent that withdrew an unbacked claim could be blocked again
  on the stale text, spending the per-turn block budget on a phantom and leaving
  the gate stood down for anything real that followed. The claim text is now
  fingerprinted onto the turn state and compared against the previous turn's; a
  byte-identical match declines to judge rather than judging stale data, and
  records `skipped_stale_claim` so it stays measurable instead of silent.

## [0.2.0] — 2026-10-28

### Added

- **The law layer and the Closeout Gate** — present in the code since August and
  documented nowhere until now, which made the project's strongest feature
  invisible to anyone reading the repo. It runs on Claude Code's Stop hook and
  can **refuse** a turn whose claims the turn's own evidence does not support —
  the only path in orunmila that can refuse anything, built deliberately outside
  `src/capture/`, which stays observe-only and exits zero forever. Six laws ship
  in `src/laws/packs/canon.json`; two block (`no-green-without-command`,
  `no-grep-as-basis`) and four advise. New commands: `orunmila laws`,
  `laws --check` (replay a law set over a captured session, read-only, before
  trusting it), `laws --init`. Kill switch: `ORUNMILA_LAWS=off`. Per-turn block
  budget (default 2) so a blocking Stop hook can never pin an agent in a
  blocked-respond-blocked loop; when the budget is spent, findings degrade to
  advice **and the exhaustion is recorded**, because a gate that gives up
  silently looks like a pass. Claude Code only.
- **The two lenses, named and separately installable.** orunmila does two
  different jobs and they were not separable in any surface a user touches.
  **The Stain Map** records and reports, never refuses, works on every supported
  agent. **The Closeout Gate** refuses, Claude Code only. Install paths now match
  the shape of the want: `orunmila install` (Stain Map alone),
  `install --with-gate` (both), `install --gate-only` (add the gate to an
  existing Stain Map install). `--with-laws` remains accepted forever as the
  original spelling of `--with-gate` — it is in install instructions people have
  already followed.
- **`orunmila lenses`** — the two lenses side by side on nine axes, plus which
  are installed right now and where their hooks live. Read out of the agent's own
  config rather than anything orunmila wrote down, because the user may have
  edited it by hand.
- **Lens state in `orunmila status`**, which now leads with it and flags
  `ORUNMILA_LAWS=off`: an installed-but-env-disabled gate must not read as
  simply "on".
- **Two corpus cases for the false-green defects below**
  (`test/cases/16`, `test/cases/17`), growing the labelled set from 15 turns /
  32 assertions to 17 / 38.

- **Machine-readable trail (`orunmila trail --json`).** The glove (complete
  trail + lineage) now has a JSON sibling alongside its HTML render — the
  existing `trailForSession` model, serialized. Carries its OWN
  `schema_version` (`1.0`) rather than borrowing the reconciler's `json`
  schema, because the trail is recordings, not verdicts (no
  `claim_type`/`outcome`/`verdict_confidence`). Honors `--out <path>` (else
  stdout); the redaction notice is written to stderr so piped stdout stays
  valid JSON. Reuses the existing render-time privacy pass (home-prefix
  collapse + `.orunmila/redact`).
- **`--facts-only` projection for `trail --json`.** Drops the inferred
  lineage layer — per-turn `edges` and every artifact's `touched_by` /
  `touched` — leaving pure recordings: touches, diffs, commands, exit codes,
  hashes, channels, sub-agent attribution. For a facts-first review that
  wants ground truth with no heuristic edges (the read→write links are a
  turn-scoped guess, honestly stamped `inferred:true`, but a guess). The
  output self-declares its mode via a top-level `facts_only` boolean. One
  boolean, not a field-selection DSL.
- **`sentinel_active` on the trail model.** A top-level boolean saying whether
  the independent disk observer (the Filesystem Sentinel, run via
  `orunmila watch`/`watch-fs`) contributed any writes to THIS session's turn
  windows. `false` means "the sentinel saw nothing here" — the trail is
  hook-announced touches only, with no out-of-band cross-check. Never left
  silent, so absence of independent observation is a visible fact.

### Changed

- **`review/ISSUES.md` is a live dated tracker instead of a one-time review
  write-up.** It had drifted into being actively misleading on a public repo —
  its first entry still announced that the Filesystem Sentinel did not exist,
  months after the sentinel shipped and was measured, and it still reported
  phantom precision at 25% when it measures 100%. Every status is now
  re-derived from the code with the file that closed it cited, and four
  production-found defects are logged that review never saw. `PRD.md` moves to
  `docs/PRD.md` with a banner saying it is design history, not a status report.
- **`CONTRIBUTING.md` no longer points contributors at a gap that is closed.**
  It described extractor precision as "the known-open precision gaps"; precision
  measures 100% on the negative corpus. It now points at the tracker for every
  issue with its status, and names `test/cases/precision/` as the
  false-positive guard to add cases to.
- **README restructured so the two lenses are above the fold**, with a real
  captured-session report as the opening exhibit, a `How accurate is it?` section
  where every figure names the command or file that produced it, and a
  `What it cannot see` section that lists the open defects by id. Both install
  routes — npm and a git clone — are documented, and both carry both lenses.
- **Coverage thresholds now reflect reality and act as a ratchet floor.**
  `.c8rc.json` asked for 97% lines/statements/functions and 86% branches; the
  repo had never met any of them, so `prepublishOnly` blocked every publish.
  `bin/dashboard.js` (30KB of untested local server, caught by the `bin/**`
  glob) joins `bin/bench.js` in `exclude` — on its own it was understating the
  real figure by ~5.5 points — and the thresholds sit just under measured
  (92/92/91/81). The gate now passes on a clean tree, so from here it catches
  regressions instead of failing unconditionally. Raising the floor is tracked
  as P2-7 with the four specific gaps.
- **`install --agent claude-code` now refuses a second registration.** The
  idempotency guard matches an existing orunmila capture hook by script
  BASENAME (`user-prompt-submit.js`, `pre-tool-use.js`, `post-tool-use.js`,
  `stop.js`), not exact command string — so a second install pointing at a
  DIFFERENT copy of orunmila (e.g. `~/.claude/orunmila/...` vs
  `tools/orunmila/...`) is caught. Two live registrations double every
  captured event and double-bump the turn counter (the dual-install
  corruption). Install now refuses with a non-zero exit and prints WHERE the
  existing hook lives, rather than silently adding a duplicate.

### Fixed

- **Three false-green paths in reconciliation**, all found by capturing one
  ordinary session and reading the report rather than trusting the corpus. All
  three made a claim score `verified` when its evidence did not support it —
  the worst direction of error for this tool, because the product is someone
  trusting a green stain.
  - A **compound claim joined by a plain "and" was graded as one unit**, so a
    true half verified a false half: *"I added input validation to login.js and
    wrote a test in login.test.js"* passed on the `login.js` write alone. The
    asymmetry that allowed it — the *ask* side has always split on plain "and";
    only the *claim* side did not. The split is conditional, because splitting
    on every "and" separates *"PR #26"* from *"and shipped it"* and breaks VCS
    provenance: it now fires only when both halves independently pass the
    speech-act gate.
  - A **double-extension basename extracted as its tail**: `login.test.js`
    became the target `test.js`, which every `*.test.js` in a repo shares, so a
    claim about one test file was satisfied by a write to any other. Same class
    as the long-closed P1-2, one level up. `app.config.ts` and `foo.spec.tsx`
    come back whole now too.
  - A **weak target stood in for a named file nothing had touched.** Fixing the
    basename did not fix the verdict: the claim also carried the one-word phrase
    target `test`, which matched `test(` inside the other file's diff, and
    `eventsMentioning` accepted any target of any kind. Weak evidence may now
    corroborate a specific claim; it may never replace it.
- **Trail redaction now scrubs nested touch rows, the `touched` lineage array,
  and `output_path` sidecars.** `redactArtifact` previously redacted
  `touched_by` but left an artifact's nested `touches[]`, its `touched[]`
  array, and every row's `output_path` (an absolute path under
  `~/.orunmila/output/`) raw. The HTML renderer didn't surface those fields so
  the gap was latent; the new `trail --json` serializes them verbatim, which
  would have leaked the OS username / absolute paths into a shareable
  artifact. All three are now path-redacted like every other trail field.

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

[Unreleased]: https://github.com/kalkudiary-ai/orunmila/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/kalkudiary-ai/orunmila/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kalkudiary-ai/orunmila/releases/tag/v0.1.0
