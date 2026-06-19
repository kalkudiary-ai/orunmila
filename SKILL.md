---
name: orunmila
description: Use this skill when the user wants to audit, verify, or visualize what an AI coding agent actually did versus what it claimed to do during a vibe-coding session - for example "audit this session", "did you actually do that", "show me what changed vs what you said", "set up a trust/verification layer for this agent", "stain map", "dye trace my agent's changes", or any request to catch phantom completions, undisclosed scope creep, or silently-dropped requirements in agent-driven coding work.
license: MIT
---

# Orunmila - claim-vs-reality verification for AI coding agents

## Overview

Orunmila hooks into an agent's tool-call lifecycle, captures every file write
(with a real before/after diff), every command run (with exit code), and
every other tool call - then, at the end of each turn, reconciles the
agent's own claim about what it did against that ground truth. It does NOT
just log activity (plenty of tools already do that well, e.g. Gryph). The
distinguishing job is reconciliation: did the claim match reality, and is
there a receipt for it at all.

Outcome categories it produces, per claim:
- `verified` - claimed, evidence backs it up
- `partial` - touched, but the diff is scaffolding-only (comments/stubs, no real logic)
- `phantom` - claimed, zero evidence anywhere in the turn (no tool call ever sent for it)
- `phantom_verification` - claimed "tested/works/verified" with no passing command behind it
- `unverifiable` - too hedged/vague to check at all ("added some basic validation")
- `undisclosed` - a file was changed that no claim and no part of the original ask covers
- `silently_dropped` - part of the original request has zero evidence AND was never mentioned again

It also tags (never asserts as certain - intent is never directly observable)
soft cause-hints like `vague-hedge`, `high-specificity-mismatch`, and
`error-in-context`, to help a human reader judge whether a mismatch looks
like a shortcut or a confabulation, without the tool claiming to know which.

## When to use this skill

- The user wants to know if an agent (this one or another) actually did what it said
- The user wants ongoing trust/verification tooling installed in a project
- The user asks to "stain", "dye trace", "audit", or "verify" an agent session
- The user is debugging a session where something seems to have gone wrong silently

## Setup

1. Check Node is available: `node --version` (needs >=18).
2. Install the capture hooks into the current project:
   ```bash
   node bin/orunmila.js install
   ```
   This merges hook entries into `.claude/settings.json` (use `--global` to
   install into `~/.claude/settings.json` instead, covering every project).
3. Tell the user to start a **new** Claude Code session (hooks are read at
   session start, so an already-running session won't pick this up).

## Using it

- After each turn, a terminal stain report is printed automatically (the
  Stop hook does this). If the user's terminal doesn't surface hook stdout,
  run `node bin/orunmila.js watch` in a second terminal to live-tail reports.
- For a full visual report of the whole session so far:
  ```bash
  node bin/orunmila.js html
  ```
  This writes a self-contained `.html` file - open it in a browser. It shows
  a colored grid of every file touched (the actual "dye stain" - color =
  worst outcome that touched the file, size = how much it was touched) plus
  a turn-by-turn breakdown.
- `node bin/orunmila.js status` shows how many events/sessions are captured.
- `node bin/orunmila.js report` prints the latest turn(s) as text.

## If something looks wrong

Claude Code's hook payload shapes and transcript format aren't a guaranteed
stable contract and may shift between versions. If reports come back empty
or claims aren't extracting:
```bash
node bin/orunmila.js debug-transcript /path/to/transcript.jsonl
```
This dumps the raw vs. normalized shape of the last few transcript lines so
the parser in `src/capture/claude-code/transcript.js` can be adjusted.

## Design notes for extending to another agent

Every capture script writes the same flat event shape (see
`src/store/eventlog.js`) regardless of which agent produced it. To support a
new agent, write a new adapter under `src/capture/<agent>/` that maps that
agent's own hook/plugin payloads into the same event types
(`file_write`, `command_run`, `tool_call`, `user_prompt`, `turn_claim`,
`turn_end`). Everything downstream (reconciliation, terminal render, HTML
render) is agent-agnostic and needs no changes.
