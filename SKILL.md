---
name: orunmila
description: Use this skill when the user wants to audit, verify, or visualize what an AI coding agent actually did versus what it claimed - or wants the agent STOPPED from finishing on an unbacked claim. Triggers include "audit this session", "did you actually do that", "show me what changed vs what you said", "stain map", "dye trace my agent's changes", "set up a trust/verification layer", "stop my agent lying", "make the agent check its own work", "catch phantom completions", "undisclosed scope creep", or "silently dropped requirements" in agent-driven coding work.
license: MIT
---

# Orunmila - claim-vs-reality verification for AI coding agents

## Overview

Orunmila hooks into an agent's tool-call lifecycle, captures every file write
(with a real before/after diff), every command run (with exit code), and every
other tool call - then reconciles the agent's own claim about what it did
against that ground truth. It does NOT just log activity (plenty of tools do
that well, e.g. Gryph). The distinguishing job is reconciliation: did the claim
match reality, and is there a receipt for it at all.

**It has two lenses, and they install separately. Work out which the user wants
before installing anything.**

| | The Stain Map | The Closeout Gate |
|---|---|---|
| what it does | records + reports | **refuses** |
| when | after each turn | before a turn is allowed to end |
| can it stop the agent? | never | yes - 2 of its 6 laws block |
| agents | all supported agents | `claude-code` only |
| install | `npx orunmila install` | `npx orunmila install --with-gate` |

If the user says *"show me what my agent did"*, *"audit"*, *"stain map"*,
*"dye trace"* - they want **the Stain Map**.
If the user says *"stop it lying"*, *"make it check its own work"*, *"don't let
it tell me it's done when it isn't"* - they want **the Closeout Gate**, which
needs the Stain Map underneath it.
If unsure, install both with `--with-gate` and say what each one does.

## Outcome categories (the Stain Map)

- `verified` - claimed, evidence backs it up
- `partial` - touched, but the diff is scaffolding-only (comments/stubs, no real logic)
- `phantom` - claimed, zero evidence anywhere in the turn
- `phantom_verification` - claimed "tested/works/verified" with no passing command behind it
- `unverifiable` - too hedged/vague to check at all ("added some basic validation")
- `undisclosed` - a file changed that no claim and no part of the original ask covers
- `silently_dropped` - part of the original request has zero evidence AND was never mentioned again
- `untracked_write` - the Filesystem Sentinel saw a real disk change no tool call accounts for

It also tags soft cause-hints (`vague-hedge`, `high-specificity-mismatch`,
`error-in-context`) to help a human judge whether a mismatch looks like a
shortcut or a confabulation - never asserting which, because intent is not
observable from the outside.

## Setup

1. Check Node is available: `node --version` (needs >=18).
2. Install the lens the user wants, into the current project:
   ```bash
   npx orunmila install                 # The Stain Map only
   npx orunmila install --with-gate     # both lenses
   npx orunmila install --gate-only     # add the gate to an existing install
   ```
   Add `--global` to install into `~/.claude/settings.json` instead, covering
   every project. Add `--agent <id>` for a non-Claude agent
   (`npx orunmila agents` lists them).
3. **Tell the user to start a new session.** Hooks are read at session start, so
   an already-running session will not pick this up. This step is skipped
   constantly and it is the usual reason someone reports "it isn't working".
4. Confirm what landed: `npx orunmila lenses`.

## Using the Stain Map

- After each turn a terminal stain report prints automatically. If the user's
  terminal does not surface hook stdout, run `npx orunmila watch` in a second
  terminal to live-tail reports **and** run the Filesystem Sentinel.
- The full report, and the one to reach for by default:
  ```bash
  npx orunmila trail
  ```
  Writes a self-contained `.html` file - the complete trail (the glove) plus
  lineage plus the claim-vs-reality stains, in one page. Six tabs: Timeline,
  Tree, Graph, 3D Graph, Dashboard, Report. The Report tab carries a
  copy-paste prompt that sends the agent back to fix every flagged item.
- `npx orunmila html` - the older mismatch-only report, if that is all they want.
- `npx orunmila json` / `npx orunmila trail --json` - machine-readable, for
  downstream tooling. `--facts-only` drops the inferred lineage layer.
- `npx orunmila status` - which lenses are live, event counts, log size, and the
  sentinel's ignore list.
- `npx orunmila demo` - renders a sample report from a scripted session. Use this
  to show someone what they'd get before installing anything.

## Using the Closeout Gate

```bash
npx orunmila laws                         # what it enforces, and which layer each law came from
npx orunmila laws --check --session <id>  # replay the laws over a past session, read-only
npx orunmila laws --init                  # scaffold the user's own laws file
ORUNMILA_LAWS=off                         # disable the gate for one session
```

**What a block means.** The gate runs on the Stop hook. If it blocks, the turn
is not over: the agent must fix what was flagged and respond again. Two laws
block - `no-green-without-command` ("it works" with no passing command) and
`no-grep-as-basis` (a claim about a named file resting only on a pattern
match). Four advise: `no-claim-without-receipt`,
`no-absolute-without-enumeration`, `no-uncertainty-as-fact`,
`no-assumption-language`.

**If you are the agent being blocked:** do the thing, don't rephrase. A block on
`no-green-without-command` wants a command actually run with its real output
shown; a block on `no-grep-as-basis` wants the file opened and read. Restating
the claim more confidently will block again.

**Important for anyone running the gate:** a pipe launders an exit code.
`npm test | tail` exits 0 with the suite on fire, which satisfies
`no-green-without-command` with a receipt that proves nothing. Redirect and
capture the status (`npm test > out.txt 2>&1; echo $?`) or use
`set -o pipefail`. In `zsh`, `${PIPESTATUS[0]}` is empty - the array is
lowercase `${pipestatus[@]}`.

**Blocks are budgeted.** Two per turn by default; once spent, findings degrade
to advice and the exhaustion is recorded, so the agent cannot be pinned in a
blocked-respond-blocked loop. Any internal error exits 0 silently: a broken law
engine stops enforcing, it never stops the agent.

## Honest limits - say these if asked

- The gate is **`claude-code` only**. Other agents get the Stain Map.
- Law findings are **heuristic: they read prose, not facts.** A finding says
  "recheck this", not "you lied".
- `exit 0` is not "correct" - it means a command ran and passed, not that it
  tested the right thing.
- Lineage (read -> write) is a **turn-scoped heuristic**, stamped `inferred`, not
  proven data flow.
- Detection accuracy is **100% on a labelled set of 17 turns / 38 assertions**
  (`npm run accuracy`). Say "100% on our labelled set", never "100% accurate" -
  the set is small.
- The Filesystem Sentinel's writes carry **no session id**, so on a machine with
  two concurrent sessions over one tree each adopts the other's writes. Read a
  touch list as "what changed on this machine while I worked", never as
  authorship.
- Deep verify (an optional LLM-judge pass for semantic claims) is **specified
  and not built**.

Full status for every known issue, open and closed: `review/ISSUES.md`.

## If something looks wrong

Hook payload shapes and transcript formats are not guaranteed stable contracts
and may shift between agent versions. If reports come back empty or claims are
not extracting:

```bash
npx orunmila debug-transcript /path/to/transcript.jsonl
```

This dumps the raw vs. normalized shape of the last few transcript lines so the
parser can be adjusted.

## Extending to another agent

Every capture script writes the same flat event shape (see
`src/store/eventlog.js`) regardless of which agent produced it. Adding an agent
is a registry entry in `src/capture/agents.js` (id, config path, its event names
per lifecycle phase), not a code fork - everything downstream (reconciliation,
rendering, the laws) is agent-agnostic.
