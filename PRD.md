# PRD: Stainmap — Claim-vs-Reality Verification for AI Coding Agents

Status: draft, ready to build from
Author: collaborative spec (user + Claude), v0 logic prototyped and unit-tested in a throwaway sandbox — this document is the actual spec, the sandbox code is not the deliverable
License target: MIT, fully free, no paid tier

---

## 1. Summary

Stainmap is a local, free, open-source tool that verifies what an AI coding
agent *claims* it did against what it *actually* did, across every
mechanism the agent could have used to make a change — not just the ones
that go through its tool-call API. It presents the result as a colored
"stain map" of the codebase: which files were touched, how, and whether the
agent's account of that work holds up.

It is explicitly **not** another activity logger (Gryph already does that
well for Claude Code, Cursor, Gemini CLI, etc.). The new part is
reconciliation — checking narrative against evidence — and comprehensiveness
— making sure no write mechanism is invisible to that reconciliation.

## 2. Problem

Two distinct failure modes, and most existing tooling only addresses one:

1. **The agent's account doesn't match reality.** It claims something was
   done, tested, or fixed, and that claim is false, half-true, or
   unfalsifiably vague. (Solved by: reconciliation engine, §6.2–6.3.)
2. **The capture itself has blind spots.** Tool-call hooks only see writes
   that go through the agent's own tool API. A file changed via a shell
   redirect, a generated build artifact, a sub-agent's internal action, or
   any other indirect mechanism may never reach the hook stream at all —
   which means it never even reaches problem #1's reconciliation, because
   reconciliation can't check evidence it never received. (Solved by: the
   filesystem sentinel, §6.4 — this is the most important addition from the
   last round of design review.)

A tool that only solves #1 can be defeated trivially by anything that
writes to disk without calling `Write`/`Edit`. Both must be solved together
for the trust claim to mean anything.

## 3. Goals

- Catch **every** file mutation in the working tree during an agent
  session, regardless of which mechanism produced it.
- Reconcile the agent's stated claims (and the *original ask*, independently)
  against that ground truth, per turn.
- Present the result as a visual "stain" — colored by outcome, sized by
  volume — plus a terminal quick-check and a full HTML session report.
- **Specify all five target agents (Claude Code, Cursor, Gemini CLI,
  Windsurf, Aider) in this document now**, each with its own capture
  mechanism documented to the depth its actual extensibility surface
  allows — not "architected so others can be added later." Build
  *sequencing* is allowed to be phased (§12); spec *completeness* is not.
  Each agent's mechanism is different enough (see §7.6) that "write one
  adapter, others follow the same shape" was an incorrect assumption — the
  per-agent section exists specifically because the shapes don't match.
- Stay genuinely free: zero required dependencies, zero required API key,
  zero telemetry, runs entirely on the user's machine.
- Be honest about inference limits: never assert *why* a mismatch happened
  (intent isn't observable) — only ever show evidence and let a human judge.

## 4. Non-goals (v1)

- Not a security/sandboxing tool (it observes, it doesn't block).
- Not a cloud service or dashboard — local-first, full stop.
- Not a replacement for an actual test suite — it tells you whether a test
  was *run*, not whether the test suite is any good.
- Deep semantic verification via an LLM judge is an explicitly optional,
  off-by-default, BYO-key feature — not required for v1 to be useful.
- Cryptographically-signed "tool receipts" (mentioned in some industry
  writing on this exact problem) are out of scope for v1 — this is a local
  trust tool for one developer, not a tamper-proof audit system for a team.

## 5. Users & use cases

- A solo/vibe-coding developer who wants to know, after each turn, whether
  the agent actually did what it said.
- Someone debugging a session where something broke and wants to know what
  *actually* touched the codebase, including things never mentioned.
- Someone building trust in an agent workflow before scaling it up or
  handing it more autonomy.

## 6. Core concepts

### 6.1 Event model (ground truth)

Every capture mechanism (hook adapter or filesystem sentinel) writes the
same flat event shape to one local append-only log:

```
ts, session_id, turn_id, source ("hook" | "fs-sentinel"), agent, type, ...fields
```

Types: `user_prompt`, `file_read`, `file_write` (with diff), `command_run`
(with exit code), `tool_call`/`tool_result` (generic — covers MCP tools),
`turn_claim`, `turn_end`, `session_end`.

The `source` field is what makes §6.4 possible: a `file_write` can come from
a hook (the agent told us, via its tool API) or from the sentinel (we
independently observed it on disk). The interesting case is when a path has
a sentinel-sourced write with **no** corresponding hook-sourced write in the
same time window — see `untracked_write` below.

### 6.2 Outcome taxonomy (the stain colors)

| Outcome | Meaning |
|---|---|
| `verified` | claimed, evidence backs it up |
| `partial` | touched, but diff is scaffolding-only (comments/stub, no real logic) |
| `phantom` | claimed, zero evidence anywhere in the turn — never sent |
| `phantom_verification` | claimed "tested/works/verified" with no passing check behind it |
| `unverifiable` | too hedged to map to anything concrete ("added some basic validation") |
| `undisclosed` | a hook-tracked write exists that no claim and no part of the original ask covers |
| `silently_dropped` | part of the original ask has no evidence **and** was never mentioned again |
| `untracked_write` | **new** — a sentinel-observed write with no corresponding hook event at all. Worse than `undisclosed`: the write never reached the part of the pipeline that asks the agent to account for itself. |

### 6.3 Provenance axis + soft cause-hints

Distinct from outcome — this answers "was there a receipt for this, and
what shape was it":

- `receipt_matches` — tool call(s) exist, succeeded, evidence found
- `not_sent` — zero tool calls reference this target at all
- `disregarded_failure` — tool call(s) exist but failed/no passing check, claim implies success anyway
- `unverifiable` — claim has no concrete target to check

Cause-hints are soft, evidence-only, **never a verdict on intent**:
`vague-hedge`, `high-specificity-mismatch`, `error-in-context`,
`no-verification-attempted`. The render layer must label these as
inference, not fact, every time they're shown — see §9 for why this
distinction had to be made more precise than the first pass got it.

### 6.4 Filesystem Sentinel (the comprehensiveness requirement)

An independent, agent-agnostic recursive directory watcher. This is what
makes the "catches ALL writes, not just the easy ones" requirement actually
true, instead of just claimed.

Requirements:
- Watches the project root recursively. Implementation should **not**
  depend on Node's experimental recursive `fs.watch` flag working
  consistently across platforms — walk the tree, watch each directory
  individually, add a watcher when a new subdirectory appears.
- On any change event: hash the file's current content, compare to the
  last known hash for that path, and only treat it as a real change if the
  hash differs (avoids logging touch-without-modify noise).
- Compute a real diff against the last known content (same diff format as
  the hook-based capture) and append a `file_write` event with
  `source: "fs-sentinel"`.
- Debounce: coalesce rapid-fire events for the same path within a short
  window (editors and build tools often fire multiple raw fs events per
  logical write).
- Default-ignore list: `.git/`, `node_modules/`, common build/dist output
  dirs, and the tool's own local data directory (to avoid watching itself).
  **This list must be visible and user-overridable, never silently
  hardcoded out of sight** — the entire point of this feature is no hidden
  blind spots, so the one deliberate exclusion list has to be the most
  transparent part of the config, not the least.
- Reconciliation cross-check: any path with a sentinel-sourced `file_write`
  and zero hook-sourced events touching that path in the same turn window
  → `untracked_write`, surfaced at the top of both the terminal and HTML
  report, not buried with ordinary undisclosed changes.

This effectively makes the agent's own hook-reported activity the *claimed*
mechanism layer, and the filesystem sentinel the *actual* mechanism layer —
the same claim-vs-reality reconciliation the rest of the tool does, just
applied one level lower, to the capture system itself.

## 7. Functional requirements

### 7.1 Capture — hook adapters (per agent)
- Claude Code adapter (first, deepest): `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`/`PostToolUseFailure`, `Stop`. Snapshots before-content on
  `PreToolUse` for Write/Edit/MultiEdit, diffs on `PostToolUse`. Logs Bash
  commands with exit code. Logs everything else (MCP tools, etc.) as a
  generic `tool_call`/`tool_result` pair so nothing new Claude Code ships
  gets silently dropped.
- Adapter interface must be agent-agnostic at the event-schema level so
  Cursor/Aider/Gemini CLI/Windsurf adapters can be added later without
  touching reconciliation or rendering.

### 7.2 Capture — filesystem sentinel
See §6.4. Runs as its own long-lived process (`stainmap watch-fs` or
folded into `stainmap watch`), independent of which agent (if any) is
running.

### 7.3 Reconciliation engine
- Parse the original prompt into subtasks (heuristic: bullet/numbered
  lists first, conjunction-splitting fallback).
- Parse the agent's turn response into discrete claims, tagging hedge
  language and verification language.
- **Verification claims ("tested," "works," "passes") must be checked
  against any test/build/lint-like command anywhere in the turn, not just
  ones whose keywords overlap the claim.** (See §9 — this was wrong in the
  first prototype pass and is now a hard requirement, not a nice-to-have.)
- Weight diff "doneness" by substance (real logic lines) vs scaffolding
  (comments/blank/stub) so a stub with a nice comment doesn't score the
  same as a real implementation.
- Cross-check sentinel-sourced writes against hook-sourced events per §6.4.
- Output a structured per-turn report (claims, subtasks, undisclosed,
  untracked, summary counts) — persisted, not regenerated by asking the
  agent to summarize itself (its own memory of earlier turns degrades over
  a long session and should never be the source of truth for the rollup).

### 7.4 Presentation
- Terminal: colored, per-turn, fires automatically at end of turn.
- HTML: full-session report — a colored file grid (color = worst outcome
  touching that file, size = volume touched) plus a turn-by-turn
  breakdown. Self-contained single file, no build step, no CDN dependency.
- Firing cadence must be user-configurable: live/raw tail of unverified
  activity, per-turn verified stain (the meaningful default — a claim only
  exists once the agent has actually responded), or end-of-session rollup.

### 7.5 CLI surface
`install` (merge hooks into `.claude/settings.json`, local or `--global`),
`status`, `report`, `html`, `watch`, `watch-fs`, `debug-transcript`
(diagnostic for the most version-fragile integration point — see §10).

### 7.6 Per-agent capture specifications

These five mechanisms are **not** variations on one shape. Each is
documented at the depth its actual public surface currently supports, with
confidence level stated explicitly so "unconfirmed" never gets built as if
it were "confirmed."

#### Claude Code — confidence: medium (hook names/events confirmed publicly; exact payload field names are inferred from community examples, not an official stable schema)
- Config: `.claude/settings.json` (project) or `~/.claude/settings.json` (global).
- Events: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
  `Stop`, `SessionStart`/`SessionEnd`, `SubagentStop` (exists, but whether it
  exposes the sub-agent's *internal* tool calls or only its final summary is
  unconfirmed — flag and test directly against a live install, M0).
- Transport: JSON on stdin, optional JSON on stdout for blocking hooks.
- Claim source: `transcript_path` field, JSONL transcript — shape not a
  stable public contract (§10).

#### Cursor — confidence: high (official docs + multiple independent worked examples agree on event names and payload shape)
- Config: `.cursor/hooks.json` (project) or global Cursor settings.
- Events (this is the full agent-hook surface, not a subset):
  `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`,
  `postToolUseFailure`, **`subagentStart`/`subagentStop`**,
  `beforeShellExecution`/`afterShellExecution`,
  `beforeMCPExecution`/`afterMCPExecution`, `beforeReadFile`,
  `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, `stop`,
  `afterAgentResponse`, `afterAgentThought`.
- Transport: JSON on stdin, JSON on stdout, exit code signals success/fail/block.
- Example confirmed payload (`beforeShellExecution`):
  `{conversation_id, generation_id, command, cwd, hook_event_name, workspace_roots}`.
- **This is the one agent where the sub-agent visibility risk flagged for
  Claude Code is explicitly resolved** — `subagentStart`/`subagentStop` are
  real, documented events. Build the Cursor adapter early enough to confirm
  whether it actually reports the sub-agent's internal tool calls or just
  lifecycle boundaries.
- Claim source: `afterAgentResponse` payload — check whether it carries the
  full response text directly, which would remove the need for any
  transcript-file parsing at all (a real advantage over Claude Code's
  transcript-file dependency, if confirmed).

#### Gemini CLI — confidence: medium-high for the hook mechanism, but a real distribution risk attached
- Config: `~/.gemini/settings.json` (user), project-level settings, or
  bundled in an extension's `hooks/hooks.json`.
- Events: `BeforeTool`/`AfterTool` (matcher = tool name, e.g. `read_file`,
  `run_shell_command` — exact write/edit tool name needs confirming against
  a live install), `SessionStart`/`SessionEnd`, `BeforeAgent`
  (≈ UserPromptSubmit), `AfterAgent` (≈ Stop), `PreCompress` (≈ PreCompact),
  `Notification`. **No `SubagentStop` equivalent exists** — the opposite
  situation from Cursor. If sub-agent delegation is used in Gemini CLI, the
  filesystem sentinel (§6.4) is the *only* thing that will see what a
  sub-agent actually touched.
- Transport: stdin JSON in, stdout JSON out, stderr for logs. Documented as
  strict: "your script must not print any plain text to stdout other than
  the final JSON" — unlike Claude Code, where a hook printing plain text is
  tolerated. **Adapter must emit valid JSON only, never raw terminal
  output** — this is a real implementation difference, not a style choice.
- **Distribution risk, not just a technical detail**: Google is retiring
  free-tier hosted Gemini CLI access (announced at I/O, effective June 18,
  2026) in favor of a new closed-source "Antigravity CLI" binary. The
  open-source `gemini` CLI keeps working with a paid API key or Vertex AI
  credentials, and this hook spec is unaffected for that path — but a
  meaningful share of "Gemini CLI users" this adapter might target may
  already be migrating to a tool this spec has zero visibility into. Treat
  the Gemini CLI adapter as targeting the paid/open-source path explicitly,
  not the free hosted tier, and revisit if Antigravity CLI ships its own
  hook system later.

#### Windsurf — confidence: low (mechanism confirmed to exist, payload schema not found in public documentation at time of writing)
- Has "Cascade Hooks" with at least `post_write_code`,
  `post_cascade_response`, and a `POST_CASCADE_RESPONSE_WITH_TRANSCRIPT`
  variant that sounds purpose-built for claim extraction — but full event
  list and JSON payload shape were not locatable in public docs during
  spec research, and some hook configuration appears to be gated to
  team/enterprise tiers rather than available to a free/individual install.
- **Do not build this adapter from this spec alone.** Treat M-Windsurf as
  "confirm the actual payload shape hands-on first," not "implement against
  assumed fields" — the cost of guessing wrong here is silent data loss
  (a hook that's wired to the wrong field name fails quietly, not loudly).

#### Aider — confidence: high, but it is structurally not a hook adapter at all
- Aider has no hook/plugin event system. It is git-first: every AI edit is
  committed as its own atomic git commit with an AI-generated message.
- Correct capture mechanism is the **git-fallback path already specified
  in §8** (watch the git log, diff each new commit against its parent) —
  not a custom hook adapter. This agent is the validation case for why the
  git-fallback path needs to exist as a first-class capture mechanism, not
  a degraded afterthought for unsupported agents.
- Claim source: Aider's chat log file (commonly `.aider.chat.history.md`),
  a markdown transcript of the conversation — parse this the way
  `transcript.js` parses Claude Code's JSONL, with the same defensive
  posture (format is not a stable contract either).

## 8. Architecture

```
            ┌──────────────────┐        ┌────────────────────────┐
 hooks ───▶ │  agent adapter    │──────▶│                          │
 (per-agent)│  (Claude Code,    │       │   event log (JSONL)      │
            │   Cursor, ...)    │──────▶│   flat, append-only      │
            └──────────────────┘        │   source: hook|fs-sentinel│
                                          └─────────────┬───────────┘
            ┌──────────────────┐                       │
 fs events─▶│ filesystem        │──────────────────────┘
            │ sentinel          │
            └──────────────────┘
                                                         ▼
                                          ┌────────────────────────┐
                                          │ reconciliation engine   │
                                          │ (agent-agnostic)        │
                                          └─────────────┬───────────┘
                                                         ▼
                                  ┌──────────────┬───────────────┐
                                  │ terminal view │  HTML report  │
                                  └──────────────┴───────────────┘
```

Storage: flat JSONL, zero native dependencies, human-greppable, doubles as
its own forensic trail. SQLite is an acceptable future swap if volume ever
demands it — not needed at v1 scale.

## 9. Validated design decisions (lessons from prototyping — keep these as acceptance tests)

These were real bugs caught while exercising the logic, not theoretical —
keep them as regression tests when this gets rebuilt:

1. **Anaphora**: `"I added validation to login.js. I tested it and it
   works."` — the second sentence has no keyword of its own ("it" isn't
   one). Naively, this fell into `unverifiable` instead of being checked at
   all. Fix: a verification claim with no keywords inherits the nearest
   preceding claim's keywords before classification.
2. **Verification claims need turn-wide command search, not keyword
   overlap.** `"I ran the tests and they pass"` next to an actual `npm
   test` command that exited 1 — keyword-matching missed this entirely
   because "npm test" doesn't mention the filename the change touched.
   Fix: verification-language claims search for *any* test/build/lint-like
   command in the whole turn, independent of keyword overlap.
3. **"No check ran" and "a check ran and failed" are different findings**
   and must carry different cause-hints (`no-verification-attempted` vs
   `error-in-context`) — collapsing them implies an error occurred when
   sometimes the agent simply never checked at all, which is its own,
   different problem.
4. **Disclosed-but-unrelated scope creep is not `undisclosed`.** A file
   mentioned in the claim text, even briefly ("also cleaned up a typo in
   config.js"), should not land in the `undisclosed` bucket just because it
   wasn't part of the original ask — disclosure is the bar, not relevance.
   (Whether disclosed-but-minimized language vs. actual diff magnitude
   should downgrade this further is flagged as an open question in §10,
   not yet solved.)

## 10. Open risks / known unknowns

- **Transcript format fragility.** Claude Code's transcript JSONL shape and
  Aider's `.aider.chat.history.md` are both not stable public contracts.
  The claim-extraction step depends on parsing them correctly. Build both
  parsers defensively (try several known shapes, never throw) and ship a
  `debug-transcript` diagnostic command from day one, not as an afterthought.
- **Sub-agent visibility is agent-specific, not one open question.** Per §7.6:
  resolved for Cursor (`subagentStart`/`subagentStop` are real, documented
  events — confirm they expose internal tool calls, not just boundaries);
  confirmed *absent* for Gemini CLI (no equivalent event exists at all,
  meaning the filesystem sentinel is the only coverage there); still
  genuinely unconfirmed for Claude Code (`SubagentStop` exists but its
  payload depth is untested). This is the strongest argument for building
  the filesystem sentinel in the same milestone as the first hook adapter
  (§12, M0/M1), not as a stretch goal — it's the only mechanism guaranteed
  to work the same way regardless of which agent's sub-agent hooks turn
  out to be shallow.
- **Gemini CLI distribution risk.** Free hosted-tier access is being
  retired in favor of a closed-source replacement (Antigravity CLI) per
  Google's June 2026 announcement. The open-source `gemini` binary with a
  paid key is unaffected and is what this spec targets — but this should
  be revisited if Antigravity CLI ships its own extensibility surface,
  since that may end up being the more relevant target than Gemini CLI
  itself within a short window.
- **Windsurf adapter has the weakest evidentiary basis of the five.**
  Cascade Hooks exist, but a public payload schema wasn't locatable during
  spec research and some configuration may be enterprise-tier-gated. Do
  not implement against assumed field names — confirm hands-on first, or
  this becomes the one adapter most likely to silently miss data.
- **Magnitude-mismatch detection (disclosed scope creep that's described
  more casually than its actual size) is identified as valuable but not
  designed in detail.** Needs a concrete metric (e.g. diff line count vs.
  a casualness score of the describing sentence) before implementation.
- **Claim/subtask extraction is heuristic, not NLP**, and will misparse
  some sentence structures (e.g. bare comma-separated lists without an
  explicit "and" between every item under-segment into one chunk). Track
  these as they're found; sharpening this without adding a paid API call
  is the highest-value kind of follow-up work.
- **Deep-verify (optional LLM judge pass)** is specified as an off-by-default
  toggle in §4 but has no detailed interface spec yet — define the prompt
  contract and the BYO-key flow before building it.

## 11. Success criteria

- A session where the agent silently drops part of a multi-part request
  produces a visible `silently_dropped` entry, with no false negatives in
  the test cases from §9.
- A session where a file is modified via `Bash` (not `Write`/`Edit`)
  produces an `untracked_write` (if the sentinel is running) rather than
  being invisible to the tool entirely.
- A claim of "tested and passing" next to a failing test run is always
  caught as `phantom_verification`, regardless of whether the claim text
  repeats the filename under test.
- The HTML report opens and renders correctly with zero build step and no
  network access required.
- `npm install` (or equivalent) requires zero packages for core
  functionality.

## 12. Phased build plan

Sequencing here reflects implementation cost and evidentiary confidence
(§7.6), not priority of importance — all five agents are in scope per §3.
A later milestone number means "build this once the cheaper/better-evidenced
ones are working," not "optional."

- **M0** — Event schema + Claude Code hook adapter (capture only, no
  reconciliation yet). Verify hook payload shapes against a real install
  immediately — this is the part most likely to differ from assumptions.
- **M1** — Filesystem sentinel, built in parallel with M0, not after it —
  given the sub-agent visibility risk in §10, this should not be a v2
  feature.
- **M2** — Reconciliation engine (claim/subtask extraction, provenance
  classification, the §9 test cases as actual regression tests).
- **M3** — Terminal + HTML rendering.
- **M4** — CLI polish (`install`, `watch`, `debug-transcript`), packaging,
  README, SKILL.md for Claude Skill installation.
- **M5** — Cursor adapter. Highest confidence of the remaining four
  (§7.6) and the one that resolves the sub-agent visibility question
  fastest, since its hook surface is the most fully documented.
- **M6** — Aider support via the git-fallback path (§7.6, §8) — not a
  hook adapter, a git-log watcher plus chat-history-log parsing. Cheap
  relative to M5 because there's no hook payload to reverse-engineer.
- **M7** — Gemini CLI adapter, scoped explicitly to the paid-key/open-source
  path (§7.6's distribution-risk note) — confirm `BeforeTool`/`AfterTool`
  payload field names against a live install before writing the parser,
  same discipline as M0.
- **M8** — Windsurf adapter, deliberately last: lowest confidence of the
  five, requires hands-on payload confirmation before any code is written
  against it (§7.6, §10).
- **M9** — Deep-verify opt-in (§4), once the heuristic engine from M2 has
  enough real mileage to know which claim types actually need an LLM judge
  rather than guessing upfront.

## 13. Prior art & differentiation

[Gryph](https://github.com/safedep/gryph) is the closest existing project —
local-first audit trail (file reads/writes/diffs/commands) for Claude Code,
Cursor, Gemini CLI, and others. It solves capture and activity logging well
already. Stainmap is not a replacement for it; it's the reconciliation and
comprehensiveness layer neither Gryph nor the broader Claude Code hooks
ecosystem currently does: checking the agent's account of its own work
against independently-observed ground truth, including writes that never
went through the agent's tool API at all.

## 14. Licensing & distribution

MIT. No paid tier of this project, ever. The only optional cost path
(deep-verify, §4) is the user's own LLM API usage with their own key —
identical to any open-source tool that lets you plug in your own API key
for an optional feature.
