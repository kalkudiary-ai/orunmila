# orunmila — *The Diviner*

> Did your AI coding agent actually do what it said? Orunmila — named after the Yoruba *orisha* of wisdom and divination — reads the session and tells you the truth. **The Diviner** stains the proof.

[![CI](https://github.com/kalkudiary-ai/orunmila/actions/workflows/ci.yml/badge.svg)](https://github.com/kalkudiary-ai/orunmila/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/orunmila.svg)](https://www.npmjs.com/package/orunmila)
[![node](https://img.shields.io/node/v/orunmila.svg)](https://www.npmjs.com/package/orunmila)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Dye-stains an AI coding agent's session. Not "what did it touch" (several
tools already log that well) - **did what it claimed match what it actually
did**, and is there a receipt for it at all.

Most agent activity logging answers "what happened." Orunmila answers "was
the agent telling the truth about it," and shows the answer as a literal
colored map of the codebase: green where claims check out, red where they
don't, purple where the agent quietly did something nobody asked about or
quietly skipped something nobody noticed was missing.

100% free, MIT licensed, runs entirely on your machine. No telemetry, no
account, no API key required for the default mode (see "Deep verify" below
for the one optional exception, which is opt-in and uses *your* key, not a
paid tier of this project).

Works with any AI coding agent — Claude Code, Antigravity, Cursor, Aider,
Codex CLI, Continue, or anything that can run a command per hook event. One adapter
maps an agent's hooks into a shared event schema; everything downstream is
agent-agnostic. See "Supported agents" below.

## What's new

Recent additions to The Diviner:

- **Interactive HTML report.** `orunmila trail` now renders a six-tab session
  view: **Timeline** (turn-by-turn pips), **Tree** (project files with
  stain bars), **Graph** (2D radial — zoom, pan, search, filter by channel
  or outcome), **3D Graph** (force-directed WebGL view with hover/click
  detail), **Dashboard** (donut + KPI cards), and **Report** (copy-paste
  prompt to send the agent back to fix every flagged item).
- **Glossary tab.** Plain-English definitions for every outcome (`verified`,
  `partial`, `phantom`, `phantom_verification`, `silently_dropped`,
  `undisclosed`, `untracked_write`, `unverifiable`), every channel, and
  every metric (Reliability, Phantom Rate, ConfIdx, Touches). Severity-coded
  so a first-time reader can self-onboard without leaving the report.
- **Report tab reordered** — stats lead, copy-paste prompt next, findings
  last. The prompt is the action; you shouldn't have to scroll past 20
  findings to reach it.
- **3D Graph rewritten.** Single-script CDN load (no chained loader), bundles
  its own three.js (no context conflicts), disposes previous instances on
  re-render (no WebGL context leaks), and ships lenient `rendererConfig`
  (`powerPreference: 'low-power'`, `failIfMajorPerformanceCaveat: false`)
  so restrictive Chrome states still get a context.
- **Model personality summaries.** `bench-results/README.md` now includes
  one-line character reads for every benchmarked model — *honest workhorse*,
  *talks confidently, sometimes too confidently*, *underpromises and
  overdelivers*, *the cautionary tail* — each grounded in the specific
  metric that distinguishes that model.
- **Dashboard default port → 3773.** `node bin/dashboard.js` now serves on
  `http://localhost:3773` by default (was 3000). Override with
  `PORT=… node bin/dashboard.js` if you need something else.

## Why this exists

Agents narrate confidently regardless of what actually happened underneath.
"I added validation and tested it" might mean exactly that, or it might mean
a stub with a comment and no test ever ran. Tool-call logs (agent hooks,
Gryph, etc.) tell you *that* a file changed - they don't check whether the
agent's own description of the change was accurate, whether a claimed test
run actually happened and passed, or whether something got changed that was
never mentioned at all.

That gap is what orunmila fills. It's the layer on top of activity logging,
not a replacement for it.

## The stain model

Every claim the agent makes gets sorted into one of these, backed by actual
evidence from the session, not vibes:

| Outcome | Meaning |
|---|---|
| `verified` | claimed, and the diff/command backs it up |
| `partial` | touched, but the diff is scaffolding only (comment/stub, no real logic) |
| `phantom` | claimed, zero matching tool call anywhere in the turn - **never sent** |
| `phantom_verification` | claimed "tested/works/verified" with no passing command behind it |
| `unverifiable` | too hedged to check at all ("added some basic validation") |
| `undisclosed` | a file changed that no claim and no part of the original ask covers |
| `silently_dropped` | part of the original ask has no evidence **and** was never mentioned again |

Each mismatch also gets soft, non-authoritative cause-hints
(`vague-hedge`, `high-specificity-mismatch`, `error-in-context`) - signals a
human can use to judge whether something looks like a shortcut or a
confabulation. The tool deliberately never asserts which, because intent
genuinely isn't observable from the outside. It only ever shows evidence.

Reconciliation runs against **two** sources, not one:
- the agent's own claim (catches lies/confabulation)
- the *original user prompt*, independently (catches things the agent just
  never mentioned again - the more common and harder-to-spot failure mode)

## The glove: complete trail (orunmila's other lens)

The stain model above is *skeptical* - it surfaces only the mismatches. **The
glove** is orunmila's second lens on the same event log (a feature of the one
tool, exactly like the Filesystem Sentinel - not a separate product): instead of
staining only what looks wrong, it stains **everything the agent touches** and
trails it, so you can answer "what, exactly and completely, did it do" - not just
"did it lie." In code this lens is the `trail` module and the `orunmila trail`
command; "the glove" is just its name in the docs and the report.

Picture a dye-stained glove: every file read, every write, every command, every
network call gets marked on contact. And the dye spreads - within a turn, a file
written (or a command run, or a URL fetched) is marked as **touched_by** the
files that were read earlier in that same turn. Reads become provenance sources
(tagged with a content hash); commands keep their full output in a local
sidecar; external contact (WebFetch/WebSearch/navigate) is recorded as a
first-class `network_call` with its host.

| Channel | Meaning |
|---|---|
| `read` | a file was observed (no change) - a provenance source |
| `write` | the agent announced a change to a file |
| `disk` | the Filesystem Sentinel independently saw a change land on disk |
| `command` | a shell command ran (full output saved locally) |
| `network` | external contact - the host it reached is recorded |

**Honesty about lineage:** the read->write edge is a **turn-scoped heuristic**,
not proven data-flow. If the agent read A and wrote B in the same turn for
unrelated reasons, B will still show `touched_by A`. That one false-edge mode is
labelled "inferred" in the report, never hidden - the same transparency contract
as the sentinel's time-window correlation. v0 is deliberately coarse, free, and
local: no content-level taint, no NLP, no API calls.

The glove and the skeptical stain are **two lenses on one events.jsonl**,
rendered by one tool into one page: `orunmila trail` shows the complete trail +
lineage (the glove) *and* the claim-vs-reality stains together - one global
truth.

```bash
node bin/orunmila.js trail        # unified report: trail (the glove) + lineage + stains
node bin/orunmila.js glove        # alias of `trail` - "the glove" is its user-facing name
```

`orunmila html` still produces the original mismatch-only report if that's all
you want.

## See it first (zero setup)

Want to see what the report looks like before wiring it into your agent? One
command renders a sample unified report from a scripted session — no install, no
agent, nothing touched in your real log:

```bash
node bin/orunmila.js demo        # writes orunmila-demo.html, open it in a browser
```

The demo session is built to show one of *everything*: a verified edit, a
phantom claim, a phantom "tested and passing", a silently-dropped ask, an
undisclosed file, an untracked disk write the sentinel caught — plus the full
trail (read→write lineage, a network fetch, a sub-agent touch). It's the **real
renderer** fed scripted events, so the page is exactly what you'll get live.

## Quickstart

```bash
git clone <this repo>
cd orunmila
node bin/orunmila.js install                  # defaults to Claude Code
# or pick your agent:
node bin/orunmila.js install --agent antigravity
node bin/orunmila.js install --agent cursor
node bin/orunmila.js install --agent aider
node bin/orunmila.js install --agent codex
node bin/orunmila.js install --agent continue
node bin/orunmila.js agents                    # list everything supported
```

`install` writes the capture hooks into that agent's own config file (see the
table below). Start a **new** session in your project (hooks load at session
start). Work normally. After each turn you'll get a terminal stain report.
If your setup doesn't surface hook output, run this in a second terminal:

```bash
node bin/orunmila.js watch
```

For the full visual report - the actual dye-stain map:

```bash
node bin/orunmila.js html
```

Opens as a self-contained `.html` file: a colored grid of every file
touched this session (color = worst outcome that touched it, size = how
much), plus a turn-by-turn breakdown underneath.

## Cross-agent comparison

Use multiple agents on the same codebase? `stats` aggregates every
captured session and compares reliability, phantom rates, and tool usage
side by side:

```bash
orunmila stats
```

For controlled benchmarks, the task corpus provides identical prompts to
run across agents and model tiers:

```bash
node bin/bench.js --agent claude-code --model haiku
node bin/bench.js --agent claude-code --model sonnet
node bin/bench.js --agent claude-code --model opus
node bin/bench.js --agent gemini-cli --model gemini-2.5-flash
```

The runner installs orunmila hooks in each task, captures the full
session, and reports per-task phantoms, phantom verifications, silently
dropped asks, wild writes, and reliability scores — not just pass/fail.
Divinations auto-save to `bench-results/` as JSON. See `bench-results/README.md`
for the metric definitions and `corpus/README.md` for the task format.

## Deep verify (optional, off by default)

The default reconciler is pure heuristic text/diff matching - free, local,
no API calls. It catches the big stuff (phantom claims, missing test runs,
undisclosed files) but can't judge subtler semantic claims like "added
proper error handling" against three lines of code. An opt-in deep-verify
pass can route ambiguous claims to an LLM judge using your own API key - off
by default so the tool is genuinely free to run with zero setup, not gated
behind anything. (Not yet wired up in this v0 - see Roadmap.)

## Supported agents

| Agent | `--agent` id | Config written | Notes |
|---|---|---|---|
| Claude Code | `claude-code` (default) | `.claude/settings.json` | Richest hook surface; the original target |
| Antigravity | `antigravity` | `.agents/hooks.json` | Google's agent-first IDE; nested `toolCall` payload mapped automatically |
| Cursor | `cursor` | `.cursor/hooks.json` | `edit_file` / `run_terminal_cmd` mapped automatically |
| Aider | `aider` | `.aider/hooks.json` | No native hooks — pair with `watch-fs` (disk sentinel) |
| Codex CLI | `codex` | `.codex/hooks.json` | `apply_patch` / exec mapped automatically |
| Continue | `continue` | `.continue/hooks.json` | VS Code / JetBrains |
| Generic | `generic` | `.orunmila/agent-hooks.json` | Any agent that can run a command per event with JSON on stdin |

All agents write the **same** `~/.orunmila/events.jsonl`. The stain model, the
glove, and the HTML report never know or care which agent produced an event —
that's the whole point of "one global truth."

## Architecture: how agent-agnostic works

There are exactly three agent-specific things at the capture seam, and all of
them live in one file, `src/capture/agents.js`:

1. **where the agent's hook config lives** (`.claude/`, `.cursor/`, …),
2. **what the agent calls its hook events** (Claude's `PostToolUse` vs Cursor's
   `afterFileEdit` vs Codex's `after_tool`),
3. **how the agent names payload fields and tools** (`tool_name` vs `tool`,
   `Edit` vs `edit_file` vs `apply_patch`).

Everything else — diffing, hashing, command sidecars, turn counting, lineage,
reconciliation, rendering — is shared in `src/capture/core.js` and the modules
downstream of it. A non-Claude agent's four hook events all point at one tiny
script, `src/capture/connector.js <agent> <phase>`, which loads the adapter and
runs the shared core. **Adding an agent is a registry entry, not a code fork.**

To add an agent: add an entry to the `REGISTRY` in `src/capture/agents.js` (id,
config path, its event names per lifecycle phase, and any tool names the
defaults don't already cover), then `install --agent <id>`. The default tool and
field accessors already understand most common naming conventions, so most
agents need only the `id`, `config`, and `events`. PRs adding agents are exactly
what this project wants.

## Prior art / what this isn't

This is not another activity logger - [Gryph](https://github.com/safedep/gryph)
already does local-first audit trails (file reads/writes/diffs/commands)
for Claude Code, Cursor, Antigravity and others, well, and is worth using
alongside this for raw session forensics. The Claude Code hooks ecosystem
more broadly (`claude-code-hooks-mastery`, `claude-hooks`, etc.) is the
proven plumbing this project builds on rather than reinvents. What's new
here is the reconciliation layer on top: checking the agent's *narrative*
against the *evidence*, not just recording the evidence.

## What it can and can't see

Before you rely on a green stain, know the edges. orunmila is honest by design,
which means being explicit about where it stops.

| It **can** see | It **cannot** see |
|---|---|
| Every file read/write/command/network call the agent's hooks report | Anything the agent did through a channel with no hook (e.g. a tool the adapter doesn't map) — unless the Filesystem Sentinel catches the disk write |
| Writes that land on disk, even ones the agent never announced (via `watch-fs`) | *Why* a file changed — it sees the diff, not the agent's intent |
| Whether a claimed test/command actually ran and its exit code | Whether a command that ran actually *tested the right thing* — exit 0 ≠ correct |
| That a claim has zero matching tool call (phantom) in its turn | Subtle semantic claims ("proper error handling") vs the code — that needs the opt-in deep-verify |
| Parts of the original prompt with no evidence and no follow-up (silently_dropped) | Claims phrased too vaguely to pin to evidence — these are marked `unverifiable`, not judged |
| Read→write touches **within one turn** (lineage) | True data-flow, or any lineage **across** turns/sessions — v0 lineage is turn-scoped heuristic only |
| Sub-agent touches when the agent exposes `agent_id` on the hook (Claude Code does) | Sub-agent attribution for agents that don't expose it — the touch is still captured, just not attributed |

The throughline: **orunmila reports evidence, never intent.** A red stain means
the receipt is missing, not that the agent lied; a green stain means the receipt
checks out, not that the code is correct. It narrows where a human needs to look
— it doesn't replace the look.

## Honesty about v0

- The transcript parser (`src/capture/transcript.js`) is the shared,
  defensive default for any agent that writes a JSONL session transcript. The
  per-line shape isn't a stable public contract for any agent, so the reader
  tries several known shapes and falls back rather than throwing. If claim
  extraction comes back empty on your agent, run `orunmila debug-transcript`
  and adjust the extractors (or ship the agent its own transcript module on
  its adapter).
- Claim/subtask extraction is regex/keyword heuristics, not NLP. It's tuned
  to catch obvious phantom/dropped/undisclosed patterns, not to perfectly
  parse every sentence. Sharpening this without adding paid API calls is
  the most valuable kind of contribution.
- Sub-agent/delegated tool calls (Claude Code's Task tool spawning a
  sub-agent) **are** captured: Claude Code fires the PostToolUse hook inside the
  sidechain, so a sub-agent's reads/writes/commands land in the same
  `events.jsonl` under the parent session. When the hook fires inside a
  sub-agent its stdin carries `agent_id`/`agent_type`, which orunmila records as
  `sub_agent_id`/`sub_agent_type` on the event — so the glove attributes each
  touch to the sub-agent that made it ("via Explore" in the trail, "via
  sub-agent" in the file grid). Other agents that delegate may not expose the
  same fields; the Filesystem Sentinel (`watch-fs`) still catches the resulting
  disk writes regardless of which agent made them.
- The event log is a flat append-only `events.jsonl` — zero native deps,
  grep/jq-able, a forensic trail in its own right. The capture hot path (the per-
  turn reconcile the agent waits on) stays cheap even on long sessions because it
  only reads the current turn's window. The offline `trail`/`html` renderers read
  the whole log, but do so **once** per render (not once per turn), so an
  800-turn / 1.5 MB session renders in tens of milliseconds. The log never
  rotates automatically — that would silently discard your trail — but `orunmila
  status` shows its size and `orunmila prune [--keep N]` caps it to the N
  most-recent whole sessions on demand. Full command output is kept in local
  sidecars (`~/.orunmila/output/`), uncapped by design so the trail is complete;
  nothing leaves the machine.

## Sharing a report (privacy)

The HTML report is the one artifact you're likely to *share* - paste in an
issue, send a teammate, screenshot. The event log itself stays complete and
local; only the **rendered copy** is sanitised, by two independent passes:

- **Home-prefix collapse (on by default).** An absolute path under your home
  directory (`/Users/jane/proj/x.js`) leaks your OS username. The report
  collapses that prefix to `~` so the structure stays readable but your identity
  doesn't ride along. Opt out with `--no-redact-home` if you're keeping the
  report purely local.
- **Redaction list (opt-in).** Drop a `.orunmila/redact` file in your project
  root - same format as `.orunmila/ignore` (one path fragment per line, `#`
  comments). Any artifact path matching the list is replaced with `[redacted]`
  in the grid, trail, lineage edges and tooltips, and the same fragment is
  masked inside any command string too. `orunmila html`/`trail` print exactly
  what's being hidden so it's never a silent gap.

```bash
printf 'secret/\n.env\n' > .orunmila/redact   # hide anything under secret/ and any .env
node bin/orunmila.js trail                      # report now redacts those, collapses ~
node bin/orunmila.js trail --no-redact-home     # keep full home paths (local-only use)
```

## License

MIT. Free, forever, no catch.
