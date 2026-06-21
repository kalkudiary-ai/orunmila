# Changelog

All notable changes to orunmila are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While orunmila is pre-1.0, breaking changes may land in any `0.x` release.

## [Unreleased]

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
