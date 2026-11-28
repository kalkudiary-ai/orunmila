# orunmila — *The Diviner*

> Did your AI coding agent actually do what it said? Orunmila — named after the Yoruba *orisha* of wisdom and divination — checks what the agent said against what two witnesses recorded.

[![CI](https://github.com/kalkudiary-ai/orunmila/actions/workflows/ci.yml/badge.svg)](https://github.com/kalkudiary-ai/orunmila/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/orunmila.svg)](https://www.npmjs.com/package/orunmila)
[![node](https://img.shields.io/node/v/orunmila.svg)](https://www.npmjs.com/package/orunmila)
[![license: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Agents narrate confidently regardless of what happened underneath. *"I added
validation and tested it"* might mean exactly that, or a stub with a comment and
no test ever run.

**Orunmila checks the agent's account against two witnesses, side by side.**
The **Glove** is the agent's own hooks: every file it read or changed, every
command it ran with its exit code, every tool and web call. The **Sentinel**
watches your project folder on disk, whoever changes it, so a change the agent
never reported still shows. No AI model judges anything: every verdict is fixed
code over the recorded facts, and it all runs on your machine.

[**See a live report →**](https://kalkudiary-ai.github.io/orunmila/) — a real
rendered session, no install required.

Here is that session at the terminal — one ordinary ask, one honest write, one
invented file, one unbacked "tests pass":

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

Free, Apache 2.0 licensed, no account, no API key, no telemetry. **No internet
call does Orunmila's work.** The one call it makes asks the npm registry for a
newer Orunmila, at most once a day after `orunmila install`, sending only the package's
name (`orunmila install --without-updates` turns it off). Reports load nothing
from the network, so opening or sharing one reveals nothing to a third party.

![Orunmila's report: what the agent claimed, against what it actually did](docs/images/stain-map.png)

*One ordinary session. The agent wrote the validation, invented a test file, and said the tests passed. Ranked by severity, worst first.*

## Start here

| You want to | Go to |
|---|---|
| Start from nothing: what it is, ten minutes to a first report, what it stores, what it cannot see | [docs/START.md](docs/START.md) |
| See a report before installing anything | [the live report](https://kalkudiary-ai.github.io/orunmila/), or `npx orunmila demo` |
| Use it on your own agent | [Quickstart](#quickstart), below |
| Know what it can and cannot tell you | [What it catches](#what-it-catches) and [What it cannot see](#what-it-cannot-see) |
| Look up a command, a law, a switch or a number | [The guide](docs/GUIDE.md) |
| Change the code | [CONTRIBUTING.md](CONTRIBUTING.md): a map of the system and your first hour |

## Quickstart

In the project you want to watch:

```bash
npm install -g orunmila          # or run each command below as: npx orunmila …
orunmila install --with-gate     # record each session, and check claims before a turn ends
```

Then **start a new session** of your agent there (hooks are read when a session
starts) and work as usual. After each turn you get a short report. For the
second witness, run the Sentinel in another terminal while you work:

```bash
orunmila watch                   # each turn's report as it lands, and the Sentinel watching the folder
```

For the whole picture of a session:

```bash
orunmila trail                   # one offline page: timeline, files, flowchart, 3D map, findings, and a prompt to paste back
```

Claude Code is the default agent. `orunmila install --agent cursor` (and the
others `orunmila agents` lists) gives another agent the Stain Map. How far each
is supported:

| Agent | Support |
|---|---|
| Claude Code | Fully supported, tested on real sessions. |
| Cursor | Supported, tested on real sessions in Cursor's command-line agent (test 49): the Stain Map only, no Closeout Gate. The editor's agent reads the same hooks file; not yet run there. |
| Gemini CLI, Codex, Continue, Antigravity, Generic | Experimental: built, tested only with sample data; results may be wrong. |
| Aider | Experimental, sentinel only (Aider has no hooks). |
| Windsurf | No adapter exists. |

pnpm, a
project-only install, a git clone, and what an install leaves in
`~/.orunmila/`: [Quickstart: every route](docs/GUIDE.md#quickstart-every-route).

## The three lenses

|  | **The Stain Map** | **The Closeout Gate** | **The Babaláwo** |
|---|---|---|---|
| what it does | records + reports | **refuses** | judges each session's record |
| when | after each turn | before a turn is allowed to end | at each session's closeout |
| can it stop the agent? | never | yes — 2 of its 6 laws block | never |
| agents | all supported agents | `claude-code` only | `claude-code`, through the intake (a preview) |
| install | `orunmila install` | `orunmila install --with-gate` | `orunmila install --intake`, then `orunmila install --with-judge` |
| read it | `orunmila trail` | `orunmila laws` | `orunmila report --verdicts` |

The Closeout Gate judges what the Stain Map records, so it needs the Stain Map
underneath it. `orunmila lenses` shows which you have.
[The three lenses](docs/GUIDE.md#the-three-lenses) in the guide has the rest.

## What it catches

| Outcome | Meaning |
|---|---|
| `verified` | claimed, and the diff/command backs it up |
| `partial` | touched, but the diff is scaffolding only (comment/stub, no real logic) |
| `phantom` | claimed, zero matching tool call anywhere in the turn - **never sent** |
| `phantom_verification` | claimed "tested/works/verified" with no passing command behind it |
| `unverifiable` | too hedged to check at all ("added some basic validation") |
| `undisclosed` | a file changed that no claim and no part of the original ask covers |
| `silently_dropped` | part of the original ask has no evidence **and** was never mentioned again. Often wrong: measured on one user's sessions it fired on about 1 turn in 3, mostly on pasted text, quotes or command output taken for a request. Treat it as a prompt to look |
| `untracked_write` | the Sentinel saw a change land on disk that no tool call in the turn reported |

Every finding is evidence, never a verdict on intent: a red stain means the
receipt is missing, not that the agent lied. The Report tab of `orunmila trail`
turns the findings into a message you paste back to the agent, asking for the
evidence or a fix on each.

## What it cannot see

**Orunmila reports evidence, never intent.** A green stain means the receipt
checks out, not that the code is correct. It narrows where you need to look; it
does not replace the look. The edges to know first:

- The Closeout Gate is Claude Code only. Other agents get the Stain Map.
- Claims are read by fixed rules over the agent's words, not by a model, so an
  agent can word a claim the rules miss.
- The Glove is the agent's own tools reporting on themselves. The Sentinel sees
  that bytes changed, never who changed them, and nothing outside the folders it
  watches.
- With two agent sessions in one folder, the standalone Sentinel cannot tell
  their changes apart; the intake's record can.
- A command's exit 0 means it ran and passed, not that it tested the right thing.

Every limit, and the known defects with their status:
[What it cannot see](docs/GUIDE.md#what-it-cannot-see) in the guide,
[`review/ISSUES.md`](review/ISSUES.md) (as of 2026-10-28), and the
[changelog](CHANGELOG.md) for findings since.

## How accurate is it?

| Measure | Result | Source |
|---|---|---|
| Detection accuracy, sentinel ON | **100%** (38/38 assertions) | `npm run accuracy` |
| Detection accuracy, hooks only | 94.7% (36/38) | `npm run accuracy` |
| **What the sentinel is worth** | **+5.3 percentage points** | the delta between those two |
| Trail completeness (the glove) | 100% (21/21 events in the trail) | `npm run accuracy` |
| False alarms on ordinary non-work text | 0 — 15/15 cases stayed clean | `test/cases/precision/` |
| Release gate | publish refused under 95% detection accuracy | `prepublishOnly` in `package.json` |

**Read that honestly: the labelled set is 17 turns and 38 assertions.** That is
small. "100% on our labelled set" is the claim; "100% accurate" is not. The
measurements from real sessions, the three false-green defects they found in
Orunmila itself, and how each figure was made:
[How accurate is it?](docs/GUIDE.md#how-accurate-is-it) in the guide, and
[**I measured how often AI coding agents claim work they didn't do**](docs/MEASURING_AGENT_CLAIMS.md).

## What's new

**1.0.0 records each session in a log anyone can check.** The record formats
are published as an open v1 specification ([`spec/`](spec/README.md)), and
`orunmila verify <session-folder>` checks a record end to end with no setup and
no network. The intake,
a preview (`orunmila install --intake`, then `orunmila intake start`), writes
each Claude Code session to its own hash-chained log outside the project, runs
the disk watcher for that session's folder, and puts back any change to the
log it did not make; `orunmila verify` checks a log. Session verdicts, off by
default (`orunmila install --with-judge`, which also keeps the record the judge
reads), judge each session the intake records with fixed rules, no model
(`orunmila report --verdicts`). The hooks now run a copy of Orunmila
kept in `~/.orunmila/`, so clearing an `npx` cache no longer silences them;
after you upgrade, `orunmila install` moves the hooks an earlier version wrote
onto that copy, adding none. `orunmila install` also turns on a once-a-day
update check, the package's one network call (`--without-updates` turns it
off). `orunmila watch` no longer stops 1.5 seconds after it starts. The trail
page's Graph tab is a flowchart on a canvas you scroll both ways and zoom, with
nothing held back. Details in the [changelog](CHANGELOG.md#unreleased).

**0.2.3 fixes the Closeout Gate judging stale text.** When Claude Code's Stop
hook fired, the gate could block a turn on a sentence the agent had already
replaced. It now takes the claim from the Stop payload.
`orunmila laws --check` shows what the live gate did: turns checked,
skipped and blocked. Details in the
[0.2.3 changelog](CHANGELOG.md#023--2026-11-20).

**0.2.2 is a security patch: upgrade, then run `orunmila log redact`.** Earlier
versions stored your log readable by other accounts on your computer and did not
redact secrets. Details, and what the patch does not cover, in the
[0.2.2 advisory](CHANGELOG.md#022--2026-11-10-security-patch).

**0.2.2 is also the first release under the Apache License 2.0.** Versions 0.1.0,
0.2.0 and 0.2.1 were published under MIT and stay MIT.

## The guide

Everything else is in [docs/GUIDE.md](docs/GUIDE.md), one section per subject:
every install route; the trail page and its tabs; the Closeout Gate's six laws,
its block budget, the facts line, the claims block and what counts as proof;
session verdicts and the intake's switches; the supported agents; every limit
and known defect; JSON output and the feedback loop; cross-agent comparison;
the architecture; sharing a report safely; and prior art.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) has a map of the system, how to run it from
a clone, and the gates a change must pass. The most valuable contributions are
sharper claim reading without paid API calls, a new agent's adapter, and
`orunmila feedback` cases from your own sessions.

## License

Apache License 2.0 (`LICENSE`), copyright KALKU DIGITAL SOLUTIONS LIMITED (`NOTICE`). Free,
forever, no catch. Versions up to 0.2.1 were released under MIT and stay MIT.

The licence covers everything in this repository: the code, the agent skills,
the task corpus, the benchmark results and the test fixtures. It grants **no
rights to the Orunmila name or any Orunmila logo** (its section 6). How you may
use the name, and why a changed version needs a new one, is in
[`TRADEMARKS.md`](TRADEMARKS.md). Third-party licences:
[`THIRD_PARTY_LICENSES`](THIRD_PARTY_LICENSES).
