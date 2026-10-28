# orunmila — *The Diviner*

> Did your AI coding agent actually do what it said? Orunmila — named after the Yoruba *orisha* of wisdom and divination — reads the session and tells you the truth.

[![CI](https://github.com/kalkudiary-ai/orunmila/actions/workflows/ci.yml/badge.svg)](https://github.com/kalkudiary-ai/orunmila/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/orunmila.svg)](https://www.npmjs.com/package/orunmila)
[![node](https://img.shields.io/node/v/orunmila.svg)](https://www.npmjs.com/package/orunmila)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Agents narrate confidently regardless of what happened underneath. *"I added
validation and tested it"* might mean exactly that, or a stub with a comment and
no test ever run. Tool-call logs tell you a file changed; they don't check
whether the agent's own account of the change was true.

**Orunmila reconciles the agent's story against the evidence.** Here is a real
session — one ordinary ask, one honest write, one invented file, one unbacked
"tests pass":

```
$ orunmila report

=== orunmila: session demo1 / turn t1 ===

Claims:
  ✅ verified
     "I added input validation to login.js"
  ❌ phantom - claimed, no evidence
     "wrote a test in login.test.js."
     evidence signals: high-specificity-mismatch (inference, not a verdict)
  🔥 phantom verification - claimed tested/works, no passing run
     "Tests pass."
     evidence signals: no-verification-attempted (inference, not a verdict)

Original ask, checked independently of what was claimed:
  ✅ addressed - "Add input validation to login.js"
  ℹ️  acknowledged as incomplete - "write a test for it."

Summary: 1 verified, 0 partial, 1 phantom, 1 phantom-verification,
         0 unverifiable, 0 silently dropped, 0 undisclosed, 0 untracked writes
```

100% free, MIT licensed, runs entirely on your machine. No telemetry, no
account, no API key required for the default mode.

<!-- IMAGE SLOTS — capture these two, then uncomment. They are the strongest
     assets this README can carry, and both are left as comments rather than
     broken links on purpose.
       1. docs/images/stain-map.png   — run `npx orunmila demo`, open
          orunmila-demo.html, screenshot the coloured file grid.
       2. docs/images/closeout-gate.gif — 20-30s screen capture: the agent says
          "tests pass" with no test run, the gate blocks it, the agent runs the
          tests and fixes it.
![The Stain Map](docs/images/stain-map.png)
![The Closeout Gate](docs/images/closeout-gate.gif)
-->

## The two lenses

Orunmila does two different jobs. They install separately, because which one you
want is genuinely not predictable — some teams want the record, some want the
refusal, and the ones who want both want to switch them on independently.

|  | **The Stain Map** | **The Closeout Gate** |
|---|---|---|
| what it does | records + reports | **refuses** |
| when | after each turn | before a turn is allowed to end |
| can it stop the agent? | never | yes — 2 of its 6 laws block |
| agents | all supported agents | `claude-code` only |
| install | `orunmila install` | `orunmila install --with-gate` |
| add to an existing install | — | `orunmila install --gate-only` |
| turn off for one session | — | `ORUNMILA_LAWS=off` |
| read it | `orunmila trail` | `orunmila laws` |

```bash
orunmila lenses        # the two side by side, and which you have installed right now
```

**The Stain Map** is the retrospective lens: it stains everything the agent
touched, reconciles each claim against the evidence, and hands you a colour-coded
map of where to look. It never refuses anything. Use it when you want to know
what your agents are actually doing.

**The Closeout Gate** is the preventive lens: it runs on the Stop hook and can
refuse to let a turn end on a claim the turn's own evidence doesn't support. Use
it when you want the agent to fix its own story before it hands work back.

One dependency between them, stated plainly: the gate judges the events the
Stain Map records, so the gate needs the Stain Map underneath it. The Stain Map
is useful entirely on its own. `--gate-only` will tell you if you've installed a
gate with nothing to judge rather than looking successful and sitting silent.

## Quickstart

Two install routes. **Both carry both lenses** — the route only changes how you
get the code, never what you get.

### From npm

```bash
npm install -g orunmila                  # or use npx and skip the global install
orunmila install --with-gate             # both lenses
orunmila trail                           # the report, after you've worked a session
```

With `npx` and nothing installed globally:

```bash
npx orunmila install --with-gate
npx orunmila trail
```

### From a git clone

Use this if you want to read the source, change the laws, or contribute. It is
the same tool; the commands just run through `node bin/orunmila.js` instead of
the `orunmila` binary.

```bash
git clone https://github.com/kalkudiary-ai/orunmila.git
cd orunmila
node bin/orunmila.js install --with-gate   # run from the project you want to watch
node bin/orunmila.js trail
```

`npm test`, `npm run lint` and `npm run accuracy` all work from a clone with zero
dependencies installed — the runtime has none, and the dev tooling is only
`eslint`, `prettier` and `c8`.

### Either route: picking your lenses

```bash
orunmila install                         # The Stain Map alone
orunmila install --with-gate             # both lenses
orunmila install --gate-only             # add the Closeout Gate to an existing install
orunmila lenses                          # which do I have right now?
```

Hooks are read at session start, so **start a new session** in your project after
installing. Work normally. You'll get a terminal stain report after each turn; if
your setup doesn't surface hook stdout, run `orunmila watch` in a second
terminal.

Pick a different agent with `--agent`:

```bash
orunmila install --agent cursor
orunmila install --agent antigravity
orunmila agents                          # everything supported, and where each config lives
```

Add the independent disk observer (the Filesystem Sentinel) — it catches writes
that never went through a tool call, and is worth **+5.3 points** of measured
detection accuracy:

```bash
orunmila watch                           # report tailing + the sentinel
orunmila watch-fs                        # the sentinel alone
```

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

## How accurate is it?

Every number here comes from `npm run accuracy`, which scores the engine against
a labelled corpus in `test/cases/`. Reproduce it yourself:

```bash
npm run accuracy          # the report
npm run accuracy:gate     # the same, failing under 95% sentinel-ON accuracy
```

| Measure | Result | Source |
|---|---|---|
| Detection accuracy, sentinel ON | **100%** (38/38 assertions) | `npm run accuracy` |
| Detection accuracy, hooks only | 94.7% (36/38) | `npm run accuracy` |
| **What the sentinel is worth** | **+5.3 percentage points** | the delta between those two |
| Trail completeness (the glove) | 100% (21/21 events in the trail) | `npm run accuracy` |
| False alarms on ordinary non-work text | 0 — 15/15 cases stayed clean | `test/cases/precision/` |
| Release gate | publish refused under 95% detection accuracy | `prepublishOnly` in `package.json` |

**Read that honestly: the labelled set is 17 turns and 38 assertions.** That is
small. "100% on our labelled set" is the claim; "100% accurate" is not, and the
difference matters.

It matters more than usual here, because of what happened on 2026-10-28. The
corpus was scoring a clean 100% while **three separate false-green paths were
live** — a compound claim graded as one unit so a true half verified a false
half, a double-extension filename matching the wrong file, and a one-word phrase
target standing in for a named file nothing had touched. A single real captured
session surfaced all three in minutes. Every fixture in the corpus had been
written by the same hand that wrote the engine, so it only ever asked the
questions that hand had thought of.

All three are fixed and locked as corpus cases
([`review/ISSUES.md`](review/ISSUES.md) P1-6, P1-7, P1-8). The lesson stayed:
curated fixtures confirm what you already thought of, captured sessions find what
you didn't. If you use this tool, `orunmila feedback` turns your own sessions
into cases — that is the most valuable contribution this project can receive.

### Measurements from real sessions, not fixtures

| Finding | Number | Source |
|---|---|---|
| Turns judged across real sessions | 194 sessions / 1,174 turns | comment in `src/laws/gate.js` |
| How often the evidentiary laws fire | 18% of claimed turns | same |
| The strictest blocking law's precision | 8 blocks in 1,174 turns, every one genuine | same |
| Agent harness changes a model's score | same model, 47%–76% reliability depending on harness | [`bench-results/README.md`](bench-results/README.md) |

The full write-up of these measurements, with the methodology and the one run
that was thrown away for being junk:
[**I measured how often AI coding agents claim work they didn't do**](docs/MEASURING_AGENT_CLAIMS.md).

That last one is the finding most people don't expect: **the measurement
framework moves the score more than the model does.** Aider's terse
SEARCH/REPLACE output suppresses free narration and inflates reliability by
10–20 points; Claude Code's scaffolding inflates pass rates with retries and
pushes confident "tested and verified" language. 29 benchmarked runs across
Claude Code, Aider, Gemini CLI and direct API are in `bench-results/`.

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

## The Stain Map: what it catches

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

### The glove: the complete trail

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

## The Closeout Gate

Everything else in Orunmila reads history. The gate speaks while the agent is
still working — on Claude Code's Stop hook, before a turn is allowed to end. It
is the only path in the tool that can refuse anything, and it lives deliberately
outside `src/capture/`, which stays observe-only and exits zero forever.

```bash
orunmila install --agent claude-code --with-gate   # capture + gate
orunmila install --gate-only                       # gate onto an existing install
orunmila laws                                      # what it would enforce, before you trust it
orunmila laws --check --session <id>                # replay the laws over a past session, read-only
```

Installing it **reads every law out loud** — which can stop your turn, which
only advise, and the file to edit to change any of it. A rule that can interrupt
your work should never be something you discover by being interrupted.

### The six laws

Shipped in `src/laws/packs/canon.json`. Two block; four advise.

| Law | What it catches | Severity |
|---|---|---|
| `no-green-without-command` | a verification claim with no passing command in the turn | **blocks** |
| `no-grep-as-basis` | a claim about a named file resting only on a pattern match | **blocks** |
| `no-claim-without-receipt` | an assertion with nothing opened or run behind it | advises |
| `no-absolute-without-enumeration` | "all" / "none" without an enumeration | advises |
| `no-uncertainty-as-fact` | uncertainty smoothed over instead of flagged | advises |
| `no-assumption-language` | building on an unnamed assumption | advises |

**Known gap, and it is a big one.** This law only sees sentences its assertion
extractor recognises, and that extractor currently requires a copula. *"The
build is green"* and *"Tests are passing"* fire it; **"Tests pass.", "All tests
pass.", "I ran the tests and they pass.", "I tested it and it works." and "It
works." do not** — they are dropped before the law is consulted, so it never
gets the chance to judge them. The verification vocabulary itself already covers
all of those; the filter upstream is what loses them. Tracked as
[P0-3](review/ISSUES.md), with the fix and the measurement it needs before the
severity can be trusted again.

### Why only two block

This was decided on measurement, not taste. Across 194 real sessions the
evidentiary laws fire on **18% of claimed turns**, and only
`no-green-without-command` proved precise enough to be worth stopping a turn
over: **8 firings in 1,174 turns, every one genuine.**

Read that honestly alongside P0-3 above: a law that cannot see the dominant
phrasing of its own target has high precision partly *because* it has narrow
recall. The accurate statement is **8 firings, all genuine, out of an unknown
number of real occurrences.** Recall has not been measured.

The rest are useful as a nudge and unusable as a wall. A false advisory costs the
agent a sentence of attention; a false block costs the whole session — and an
agent that learns the gate is usually wrong learns to route around it.
`no-claim-without-receipt` alone accounts for the large majority of findings, so
blocking on it would train everyone to switch the gate off, and a gate that is
off enforces nothing.

### The loop trap, and why a block budget exists

A blocking Stop hook can pin an agent: blocked, responds, blocked again. The host
does **not** tell a hook that it is re-firing because of its own previous block,
so the protection has to be the gate's own. Every block counts against a per-turn
budget (default 2); once spent, findings degrade to advice **and the exhaustion
is recorded**. A gate that gives up silently is worse than no gate, because it
looks like a pass.

### Failure posture

It runs on every turn of every session, so it must never hang, never throw, and
never lose you your work. **Any error at all exits 0 silently.** A broken law
engine is allowed to stop enforcing; it is never allowed to stop the agent.

### Making them yours

```bash
orunmila laws --init           # scaffold your own laws file
ORUNMILA_LAWS=off              # disable the gate for one session
```

Retune a law without restating it — `{ "id": "no-grep-as-basis", "severity": "warn" }`
— or switch one off with `{ "id": "no-grep-as-basis", "enabled": false }`. Your
own laws layer over the shipped canon rather than replacing it, so you can encode
your codebase's rules (deployment targets, forbidden vendors, naming
conventions) and have them checked at run time. `orunmila laws` always shows what
is in force and which layer each law came from.

**Honest limits.** The gate is `claude-code` only — other agents get the Stain
Map and the reports, not the refusal. And law findings are **heuristic: they read
the agent's prose, not the facts.** They sit beside the evidence, never inside
it, and never carry the same authority. A finding says "recheck this", not "you
lied". One known hole worth knowing about: a pipe launders an exit code, so
`npm test | tail` exits 0 with the suite on fire and satisfies
`no-green-without-command` with a receipt that proves nothing
([`review/ISSUES.md`](review/ISSUES.md) P1-5).

## Supported agents

| Agent | `--agent` id | Stain Map | Closeout Gate | Config written | Notes |
|---|---|---|---|---|---|
| Claude Code | `claude-code` (default) | ✅ | ✅ | `.claude/settings.json` | Richest hook surface; the original target |
| Antigravity | `antigravity` | ✅ | — | `.agents/hooks.json` | Google's agent-first IDE; nested `toolCall` payload mapped automatically |
| Cursor | `cursor` | ✅ | — | `.cursor/hooks.json` | `edit_file` / `run_terminal_cmd` mapped automatically |
| Aider | `aider` | ✅ | — | `.aider/hooks.json` | No native hooks — pair with `watch-fs` (disk sentinel) |
| Codex CLI | `codex` | ✅ | — | `.codex/hooks.json` | `apply_patch` / exec mapped automatically |
| Continue | `continue` | ✅ | — | `.continue/hooks.json` | VS Code / JetBrains |
| Generic | `generic` | ✅ | — | `.orunmila/agent-hooks.json` | Any agent that can run a command per event with JSON on stdin |

The **Closeout Gate is `claude-code` only** — it needs a hook that can refuse
a turn, and Claude Code's Stop hook is the only one that currently offers it.
Every other agent gets the Stain Map: full capture, full reconciliation, full
reports.

All agents write the **same** `~/.orunmila/events.jsonl`. The stain model, the
glove, and the HTML report never know or care which agent produced an event —
that's the whole point of "one global truth."

## What it cannot see

Before you rely on a green stain, know the edges. The throughline:
**Orunmila reports evidence, never intent.** A red stain means the receipt is
missing, not that the agent lied. A green stain means the receipt checks out, not
that the code is correct. It narrows where a human needs to look; it does not
replace the look.

### By design

| It **can** see | It **cannot** see |
|---|---|
| Every file read/write/command/network call the agent's hooks report | Anything done through a channel with no hook — unless the Filesystem Sentinel catches the disk write |
| Writes that land on disk the agent never announced (via `watch-fs`) | *Why* a file changed — it sees the diff, not the intent |
| Whether a claimed command actually ran, and its exit code | Whether that command tested the right thing — exit 0 ≠ correct |
| That a claim has zero matching tool call (phantom) | Subtle semantic claims ("proper error handling") against the code — that needs the unbuilt deep-verify |
| Parts of the original ask with no evidence and no follow-up | Claims too vague to pin to evidence — marked `unverifiable`, not judged |
| Read→write touches **within one turn** (lineage) | True data flow, or lineage **across** turns — v0 lineage is a turn-scoped heuristic, stamped `inferred` |
| Sub-agent touches when the agent exposes `agent_id` (Claude Code does) | Sub-agent attribution for agents that don't — Gemini CLI has no such event at all |

The Filesystem Sentinel has its own edges, and they are in
`review/SENTINEL_DESIGN.md` §9 rather than buried: a write made and reverted
inside the ~150ms debounce window can be missed; it sees *that* bytes changed,
never who or why, so it cannot distinguish the agent from your editor from a
build watcher; binary files are logged hash-only. Its ignore list is a
deliberate, visible blind spot — `orunmila status` prints it.

Claim and subtask extraction is **regex and keyword heuristics, not NLP**. It is
tuned to catch obvious phantom / dropped / undisclosed patterns, not to parse
every sentence. Sharpening it without adding paid API calls is the most valuable
kind of contribution.

### Known defects, with status

Every issue — open and closed — is tracked with its status, reproduction and
acceptance test in [`review/ISSUES.md`](review/ISSUES.md). The open ones that
change how you should read a report:

- **The sentinel's writes carry no session id** (P0-2). Correlation is purely by
  time window, so on a machine running two agent sessions over one tree, each
  **adopts the other's writes** — and session-pinning does not fix it, because
  sentinel events have no session id to filter on. Read a touch list as *"what
  changed on this machine while I worked"*, never as authorship. This is the one
  open defect that produces a confidently wrong answer rather than a missing
  one, and it is architectural, not a patch.
- **A pipe launders an exit code** (P1-5). `npm test | tail` exits 0 with the
  suite on fire. Redirect and capture the status instead
  (`npm test > out.txt 2>&1; echo $?`) or `set -o pipefail`. In `zsh`,
  `${PIPESTATUS[0]}` is empty — the array is lowercase `${pipestatus[@]}` — so
  the obvious portable-looking fix silently reads nothing.
- **`latestSessionId()` means "most recent event on this machine"** (P3-2), not
  "the session asking". Any wrapper that defaults to it will, on a multi-session
  machine, flip to whichever session most recently emitted an event.
- **The turn counter is not concurrency-safe** (P2-2). Parallel PostToolUse hooks
  can still land events in the wrong turn bucket.
- **Deep verify is specified and not built.** The optional LLM-judge pass for
  semantic claims is designed, off by default, and not wired up.

That list is in the README on purpose. A verification tool that hides its own
failure modes is asking you to take its word for something — which is the exact
habit it exists to break.

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

## Machine-readable output + feedback loop

The terminal and HTML reports are for humans. `orunmila json` emits the same
per-turn reconciliation as structured JSON for downstream tooling (IDE
diagnostics, dashboards, automated analysis). It's deterministic — same event
log + same options → byte-identical output — which means golden-file tests
and stable diffs are trivial.

```bash
node bin/orunmila.js json                                    # latest session/turn to stdout
node bin/orunmila.js json --turn t12 --out report.json       # one turn to a file
node bin/orunmila.js json --include claim_text               # opt the agent's claim text into the output
```

The schema is `1.0` and versioned. Per-claim entries carry **two confidence
axes** — `extraction_confidence` (is this text a claim of this type?) and
`verdict_confidence` (is the outcome right given the parse?) — kept separate
because fusing them makes calibration analysis impossible. A reserved
`label` slot is all-null by default so an optional labeling pass can land
later with no schema bump. Full contract: [docs/SCHEMA.md](docs/SCHEMA.md).

**Privacy is by construction, not by configuration.** Raw text fields
(`claim_text`, future `prompt_text`/`diff_hunks`/`command_output_snippets`)
are excluded by default; `--include <field>` opts them in. Sanitization
(home-prefix collapse + `.orunmila/redact`) is applied per string-valued
field DURING emit on every default and opt-in field — `--include` only gates
which raw text fields *enter* the pipeline. The `classification_features`
breadcrumbs the emitter ships by default carry categories, counts, and
pattern-IDs only — never raw substrings from the claim text.

### The homeward feedback loop

The reason for shipping JSON: **teach Orunmila to identify agent claims
better, using your own builds as the training corpus.** `orunmila feedback`
writes sanitized accuracy cases to a local drop folder; each entry is a
**strict superset of `test/cases/precision/*.json`** so contributing them
back is a copy, not a translation.

```bash
node bin/orunmila.js feedback                                # writes .orunmila-feedback/sessions/<date>-<id>.json
node bin/orunmila.js feedback --include claim_text           # populate cases[] with the real text (corpus-runnable)
node bin/orunmila.js feedback-import --dir .orunmila-feedback/   # cp cases[] into test/cases/precision/
```

The drop folder includes an `INDEX.md` that points back to the upstream repo
with exact contribution steps. Without `--include claim_text` the file is
still written, but `cases[]` entries carry no claim text and are not
corpus-runnable — re-run with the flag on builds whose content you're
comfortable sharing.

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

## Deep verify (specified, NOT built)

The default reconciler is pure heuristic text/diff matching - free, local,
no API calls. It catches the big stuff (phantom claims, missing test runs,
undisclosed files) but can't judge subtler semantic claims like "added
proper error handling" against three lines of code. An opt-in deep-verify
pass can route ambiguous claims to an LLM judge using your own API key - off
by default so the tool is genuinely free to run with zero setup, not gated
behind anything. (Not yet wired up in this v0 - see Roadmap.)

## Honesty about v0 (implementation notes)

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

## Prior art / what this isn't

This is not another activity logger - [Gryph](https://github.com/safedep/gryph)
already does local-first audit trails (file reads/writes/diffs/commands)
for Claude Code, Cursor, Antigravity and others, well, and is worth using
alongside this for raw session forensics. The Claude Code hooks ecosystem
more broadly (`claude-code-hooks-mastery`, `claude-hooks`, etc.) is the
proven plumbing this project builds on rather than reinvents. What's new
here is the reconciliation layer on top: checking the agent's *narrative*
against the *evidence*, not just recording the evidence.

## Further reading

| | |
|---|---|
| [**I measured how often AI coding agents claim work they didn't do**](docs/MEASURING_AGENT_CLAIMS.md) | The findings piece: 10 models, 3 harnesses, 29 runs — and the three false-green defects found in this tool itself. Every figure names its source. |
| [`review/ISSUES.md`](review/ISSUES.md) | Every known issue, open and closed, with a reproduction and an acceptance test. Dated and re-derived from code, not carried forward. |
| [`skills/`](skills/) | Four packaged agent skills: a free core audit, plus gate setup, a review workflow, and writing laws for your own codebase. |
| [`bench-results/README.md`](bench-results/README.md) | All 29 benchmark runs, the metric definitions, and the framework-effect analysis. |
| [`docs/SCHEMA.md`](docs/SCHEMA.md) | The `orunmila json` contract (`schema_version` 1.0). |
| [`docs/PRD.md`](docs/PRD.md) | Design history — why the tool is shaped this way. Not a status report. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | The most valuable contribution is sharpening claim extraction without adding paid API calls. |

## License

MIT. Free, forever, no catch.
