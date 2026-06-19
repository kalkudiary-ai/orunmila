# orunmila

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

## Why this exists

Agents narrate confidently regardless of what actually happened underneath.
"I added validation and tested it" might mean exactly that, or it might mean
a stub with a comment and no test ever ran. Tool-call logs (Claude Code
hooks, Gryph, etc.) tell you *that* a file changed - they don't check
whether the agent's own description of the change was accurate, whether a
claimed test run actually happened and passed, or whether something got
changed that was never mentioned at all.

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

## Quickstart (Claude Code)

```bash
git clone <this repo>
cd orunmila
node bin/orunmila.js install        # merges hooks into .claude/settings.json
```

Start a **new** Claude Code session in your project (hooks load at session
start). Work normally. After each turn you'll get a terminal stain report.
If your terminal setup doesn't surface hook output, run this in a second
terminal:

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

## Deep verify (optional, off by default)

The default reconciler is pure heuristic text/diff matching - free, local,
no API calls. It catches the big stuff (phantom claims, missing test runs,
undisclosed files) but can't judge subtler semantic claims like "added
proper error handling" against three lines of code. An opt-in deep-verify
pass can route ambiguous claims to an LLM judge using your own API key - off
by default so the tool is genuinely free to run with zero setup, not gated
behind anything. (Not yet wired up in this v0 - see Roadmap.)

## Extending to other agents

Claude Code gets the deepest integration first only because it currently
exposes the richest hook surface (`PreToolUse`/`PostToolUse`/`Stop`/
transcript access) - not because of any preference for it. Every capture
adapter writes the same flat event schema (`src/store/eventlog.js`), so
adding Cursor, Aider, Gemini CLI, Windsurf, etc. is a matter of writing a
new adapter under `src/capture/<agent>/` that maps that agent's own hooks
into the same event types. Reconciliation and rendering are 100%
agent-agnostic and need zero changes. PRs adding adapters are exactly what
this project wants.

## Prior art / what this isn't

This is not another activity logger - [Gryph](https://github.com/safedep/gryph)
already does local-first audit trails (file reads/writes/diffs/commands)
for Claude Code, Cursor, Gemini CLI and others, well, and is worth using
alongside this for raw session forensics. The Claude Code hooks ecosystem
more broadly (`claude-code-hooks-mastery`, `claude-hooks`, etc.) is the
proven plumbing this project builds on rather than reinvents. What's new
here is the reconciliation layer on top: checking the agent's *narrative*
against the *evidence*, not just recording the evidence.

## Honesty about v0

- The transcript parser (`src/capture/claude-code/transcript.js`) is
  defensive but unverified against a live install at time of writing -
  Claude Code's transcript JSONL shape isn't a stable public contract. If
  claim extraction comes back empty, run `orunmila debug-transcript` and
  adjust the extractors.
- Claim/subtask extraction is regex/keyword heuristics, not NLP. It's tuned
  to catch obvious phantom/dropped/undisclosed patterns, not to perfectly
  parse every sentence. Sharpening this without adding paid API calls is
  the most valuable kind of contribution.
- Sub-agent/delegated tool calls (Claude Code's Task tool spawning a
  sub-agent) may not surface their internal tool calls through the same
  hook stream as the top-level agent. Untested - flag and fix if you hit it.

## License

MIT. Free, forever, no catch.
