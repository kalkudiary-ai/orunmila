# Changelog

All notable changes to orunmila are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While orunmila is pre-1.0, breaking changes may land in any `0.x` release.

## [Unreleased]

## [0.2.4] — unreleased (built 2026-11-23, waiting for the maintainer's go-ahead)

### Fixed

- **`orunmila --version` prints the version.** It printed the 49-line usage
  text and exited 1. `--version`, `-v` and `version` now print the installed
  version on one line and exit 0. An unknown command still prints the usage and
  exits 1.

### Documented

- **Where Claude Code runs, and the hook paths `orunmila install` writes.**
  The README lists Claude Code in the terminal, VS Code, Antigravity and the
  app, each with how it was checked, and says that each hook is written as
  `node "<path to the installed package>/src/capture/claude-code/<hook>.js"`:
  the hooks work only where that path exists, so install the package globally
  or as a dev dependency rather than through `npx`, and run `orunmila install`
  again on each machine or cloud environment the project's sessions run on.

## [0.2.3] — 2026-11-20

### Fixed

- **A Stop with nothing before it is judged on its own turn (NF62).** Claude
  Code may run the gate before the capture hook, or both at once. On a Stop
  with no prompt or tool call before it, the gate read the turn counter before
  capture advanced it, so it judged the new claim against the previous turn's
  records (a green claim could be cleared by the previous turn's test run) and
  overwrote that turn's record. In one recorded session, 3 of 20 claimed turns
  were judged this way. The gate now finds its turn from the counter and the
  Stop's own final text, whichever hook runs first; when the gate runs first,
  two Stops in a row with the same text and nothing between them still cannot
  be told apart. The turn
  counter's file is also written whole, through a temporary file, so a hook
  reading it while another writes it no longer falls back to turn 1.
- **The Stain Map no longer reads "unverified" as "verified" (NF57).** Its own
  verification words ("verified", "confirmed", "works" and the rest) matched
  inside other words ("unverified", "workstream") and ignored a negation, so
  "Not verified this pass" was graded as a claim that something was verified.
  Each word now counts only as a whole word, and "not", "never", "haven't" and
  the like just before "verified", "confirmed" or "validated" cancel it. Over
  one machine's recorded sessions (1,097 claimed turns), 88 such sentences
  stopped being graded as claims, and no claim was added or changed outcome.
- **An apostrophe inside a word is no longer read as a quote mark (NF31).**
  The gate, the Stain Map and the reader that finds a sentence's targets
  paired the apostrophes of two contractions ("isn't … haven't") as a quoted
  span. That hid the words between them, so "That's done, and the suite passes
  now that it's merged." made no claim, and it turned them into a target the
  receipt law asked a receipt for. All three now share one rule: a single
  quote opens only after a non-letter and closes only before one. Some
  sentences the old rule hid are now judged, so advisories can appear where
  there were none. On the recorded sessions these changes were measured on,
  no turn gained a block, and one false block (the "while it works" sentence
  below) is gone.
- **More honest sentences stay silent, and two real claims are no longer
  missed.** "Nothing got tested." is read like "Nothing was tested.", and a
  "while" frame ("My review follows while it works.") describes a mechanism,
  as "how" and "whether" already did; the Stain Map applies that frame too.
  "Nothing broke, yet the code was tested." and "Nothing regressed, as the
  parser was tested end to end." are claims again. "I haven't tested it this
  session." and "The parser hasn't been tested." are no longer read as claims
  that tests ran (NF61), and "I haven't tested the UI, but all tests pass."
  still counts as one.
- **An honest "I didn't test it" is no longer read as a claim that tests
  passed (NF43).** "I tested none of it.", "Nothing was tested." and "Neither
  branch was tested." were blocked by `no-green-without-command`, and the Stain
  Map scored them as phantom verifications. Both now share one reader for "it
  ran and passed" claims, which knows when a none, nothing or neither cancels a
  "tested"; a real claim beside it ("I tested none of the old paths, but all
  tests pass") still counts. The Stain Map also now sees "The tests and the
  build pass." and "Nothing regressed, so the suite passes.", which it missed,
  and no longer reads "untested" as "tested". A negation the reader does not
  recognise can still read as a claim.
- **The Closeout Gate's block budget now lasts until the user's next message.**
  The budget (two blocks by default) was counted per turn, and each answer the
  agent gives after a block opens a new turn, so it refilled on every Stop: a
  claim the agent reworded after each block was blocked every time (4 Stops of
  4 in the new test). It is now counted per message the user sends. The
  agent's answers after a block share one budget, task notifications and
  sub-agent hand-backs that Claude Code writes into the conversation do not
  refill it, and the user's next message starts a fresh one. Before the
  session's first counted message, all blocks share one budget. The note the
  agent reads when the gate stands down is unchanged.
- **The gate and the claim record no longer take a stale message as the turn's
  claim (N10).** When Claude Code's Stop hook fires, the transcript can still
  end on an earlier message of the turn. Both read their claim from it, so the
  gate could block a turn on a sentence the agent had already replaced, and the
  Stain Map recorded that sentence as the turn's claim. For Claude Code both now
  take the claim from the Stop payload's `last_assistant_message`. If the
  payload has no string value in any of `last_assistant_message`, `claim` or
  `response`, the gate does not judge the turn and records the skip, and the
  claim is recorded empty and marked `claim_unconfirmed`. An empty final
  message is not judged and leaves no such record.
  Other agents still read the transcript: their Stop payloads have not been
  measured.
- **A claim restated unchanged after a block is judged again (P0-4).** The gate
  used to skip a claim identical to the previous turn's, because with the
  transcript read that usually meant stale text. With the claim taken from the
  Stop payload, a repeat is a real restatement, so it no longer gets past the
  gate; the block budget is what stops a loop.

### Added

- **A facts line for the Closeout Gate, off by default
  (`ORUNMILA_FACTS_LINE=1`).** It puts one line from the turn's records above
  the gate's findings, and prints it alone on a judged turn with none: the
  test runs the turn made, with the exit status each record holds, and the
  files changed as each witness saw them (the agent's hooks and the disk
  watcher), with test files named. A heredoc's body is not read as commands
  (a commit message saying "npm test" is not a test run), except where a shell
  or `ssh` is fed it. It reads no prose. The findings below it
  are unchanged, and with the switch off the gate prints exactly what it
  printed before.
- **Strict proof, off by default (`ORUNMILA_STRICT_PROOF=1`), not yet
  recommended.** The green law and the Stain Map then take only a test run that
  proves a pass: a runner step whose recorded status is a pass, with nothing
  after it deciding the line's status (`; echo $?`, `|| true`), and no pipe
  after it unless `set -o pipefail` came first on the line. `laws --check`
  reads the same switch. Measured on one machine's recorded sessions it added
  64 blocks, most of them false, so it stays off; README, "What counts as
  proof".
- **`orunmila laws --check` counts what the live gate did** in the session:
  turns checked, turns skipped (no confirmed final text; older records can
  also show a repeated claim) and turns blocked, read from the gate's own
  records (`live_gate` in `--json`). Skips were recorded before, but nothing
  showed them. It also counts the claimed turns the gate holds no record of
  their own for (`unrecorded`): the gate never ran on them, or a later Stop
  overwrote their record. A claim whose text the log redacted (a secret in it)
  no longer matches its record, so it counts here too.
- **A labelled sentence corpus for both claim readers**, in the repository
  (`test/cases/laws/green-corpus.json`, 71 sentences; not in the npm package).
  The test suite fails if the gate or the Stain Map reads any of them
  differently from its label; `node scripts/laws-corpus.js` lists every
  sentence a change gets wrong.

## [0.2.2] — 2026-11-10 (security patch)

### Security advisory

**Versions 0.1.0 to 0.2.1 store everything they capture in `~/.orunmila/` with
default file permissions, and without redacting secrets.** On most systems that
means any other account on the same computer can read your prompts, file diffs
and command output, including any API key, token or password that passed through
an agent session. Upgrade to 0.2.2, then run `orunmila log redact` (scrub what is
already stored) or `orunmila log delete --yes` (remove it). If you know an agent
saw a credential, rotate it: redaction recognises known formats only.

**What 0.2.2 does not do.** It protects your log from *other accounts* on your
computer. It does not protect it from the agent itself, which runs as your own
user and can still read and change these files. Separating the two is planned for
the next major release. On Windows, file modes do not apply: the owner-only
settings below have no effect there, so the log is only as private as the folder
it sits in.

### Fixed

- **Owner-only storage.** `~/.orunmila/` and every folder Orunmila creates in it
  are now `0700`. The event log, the last-turn report, `log-state.json`, the
  `laws.json` that `orunmila laws --init` writes, command-output sidecars and
  before-snapshots are `0600`. A project `.orunmila/laws.json` is repo config
  and keeps the default mode.
  Reports, law state, the turn counter and archives keep the default file mode
  (usually `0644`) and rely on their `0700` folders. For existing installs, the
  data dir, its top-level folders, the event log, `laws.json`, the last-turn
  report and `log-state.json` are tightened on the next hook run. A custom
  `ORUNMILA_HOME` that already existed is not chmodded (it may be a shared
  folder); those files inside it are.
- **Secrets are redacted at capture.** Known secret formats (AWS, GitHub,
  Anthropic, OpenAI, Stripe, Slack, Google and npm keys; PEM private keys; JWTs;
  bearer tokens; credentials in URLs; upper-case `*_TOKEN=` / `*_PASSWORD=`-style
  assignments) are replaced with `[REDACTED:<kind>]` before an event, a
  command-output sidecar or the before-snapshot of a file being edited is
  written. Both witnesses, the hooks and the Filesystem Sentinel, redact the
  whole text before they cut an excerpt or make a diff. Each event lists the
  kinds removed in a new `redactions` field, never the values. Unknown formats
  can still get through. What redaction misses is listed under "Known limits" in
  `SECURITY.md`.
- **The dashboard listens on `127.0.0.1` only.** `node bin/dashboard.js` used to
  listen on every network interface, which served your session list and reports
  to anyone on the same network. It also now escapes session ids in the page.
- **The blocking law sees the usual ways of claiming a pass (P0-3).**
  `no-green-without-command` used to miss "Tests pass.", "All tests pass.",
  "The test suite passes.", "I ran the tests and they pass." and "It works.".
  It now judges them. It can also block an honest negative such as "I tested
  none of it.".
- **A passing run is no longer read as a failure (P0-5).** Claude Code does not
  report exit codes, and the gate and the Stain Map treated a command with no
  recorded exit code as failed. A "tests pass" claim backed by a real passing
  run could be blocked by the gate, or scored as a phantom verification.

### Added

- **`orunmila log redact`** scrubs everything already stored (event log,
  sidecars, reports, last-turn report) in place. Run it with no agent session
  active.
- **`orunmila log delete [--yes]`** lists what it would delete, and deletes only
  with `--yes`. Your `laws.json` is kept.
- **A one-time warning** when a log from before 0.2.2 exists: from `orunmila
  status`, and in Claude Code once per session, as a message to you (never
  shown to the agent, never blocking). Other agents get it from `orunmila
  status` only. The warning stops once you redact or delete.

### Changed

- **Licence: Apache License 2.0.** 0.2.2 is the first release under Apache 2.0
  (`LICENSE`, `NOTICE`), which adds an explicit patent grant. Versions 0.1.0,
  0.2.0 and 0.2.1 were published under MIT and stay MIT.
- `SECURITY.md` no longer says orunmila makes no network calls of its own. Two
  developer tools ship in `bin/`: `bench.js` runs other agents and can call
  OpenRouter when you invoke it, and `dashboard.js` is a local web server.
- Any command that opens the data dir, read-only ones such as `orunmila status`
  included, now sets the permissions above as it starts, and makes your own
  `laws.json` `0600`. The first 0.2.2 run also writes `log-state.json`.

## [0.2.1] — 2026-10-28

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

[Unreleased]: https://github.com/kalkudiary-ai/orunmila/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/kalkudiary-ai/orunmila/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/kalkudiary-ai/orunmila/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/kalkudiary-ai/orunmila/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/kalkudiary-ai/orunmila/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kalkudiary-ai/orunmila/releases/tag/v0.1.0
