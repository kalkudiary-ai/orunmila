# Orunmila — issue tracker

**As of 2026-10-28.** Status for every item below was re-derived by reading the
code this date, not carried forward from the previous revision. Where an issue
is closed, the fix is cited by file so you can check it rather than trust it.

This file is a live tracker. It used to be a one-time review write-up, and by
October 2026 it had drifted far enough to be actively misleading — its first
entry still announced that the Filesystem Sentinel did not exist, months after
it shipped and was measured. That drift is itself logged below as **P3-3**,
because a tool that checks claims against reality has no business shipping a
stale status file.

Severity legend: **P0** = a central claim of the tool is false until fixed ·
**P1** = produces wrong verdicts on ordinary input · **P2** = correctness gap ·
**P3** = polish or hygiene.

## Summary

| ID | Title | Severity | Status |
|---|---|---|---|
| P0-1 | Filesystem Sentinel does not exist | P0 | **Closed** — shipped and measured |
| P0-2 | Sentinel writes carry no session id, so concurrent sessions adopt each other's writes | P0 | **Open** — architectural |
| P0-3 | The blocking verification law never sees the most common way an agent claims a pass | P0 | **Open** — found 2026-10-28 |
| P1-1 | Plain-English subtasks produce false `silently_dropped` | P1 | **Closed** |
| P1-2 | Filename matching is actually extension matching | P1 | **Closed** |
| P1-3 | `undisclosed` flags everything when keywords are empty | P1 | **Closed** |
| P1-4 | Claim extractor has low precision on conversational/markdown turns | P1 | **Closed** |
| P1-5 | A pipe launders an exit code, so a green claim can hold a lying receipt | P1 | **Open** |
| P1-6 | A compound claim joined by "and" is graded as one unit, so a true half verifies a false half | P1 | **Closed** — found + fixed 2026-10-28 |
| P1-7 | A double-extension basename (`login.test.js`) extracts as its tail (`test.js`) | P1 | **Closed** — found + fixed 2026-10-28 |
| P1-8 | A weak phrase target stands in for a named file nothing touched | P1 | **Closed** — found + fixed 2026-10-28 |
| P2-7 | Coverage thresholds were never met, so `prepublishOnly` blocked every publish | P2 | **Closed** — found + fixed 2026-10-28 |
| P2-8 | The report's 3D Graph tab fetches a CDN script, against a stated privacy claim | P2 | **Open** — docs corrected 2026-10-28 |
| P2-1 | `partial` / scaffolding detection effectively never fires | P2 | **Closed** |
| P2-2 | Turn tracking is not concurrency-safe | P2 | **Open** — narrowed |
| P2-3 | Sub-agent (Task tool) writes are unreconciled | P2 | **Closed for Claude Code**, open elsewhere |
| P2-4 | HTML file grid omits subtask-only and command-touched files | P2 | **Open** — mitigated in `trail` |
| P2-5 | A pager downstream of a grep scored as a full read | P2 | **Closed** |
| P2-6 | `T1 live` sentinel test is an intermittent flake under full-suite load | P2 | **Open** — found 2026-10-28 |
| P3-1 | `command_run` stdout truncated to 2000 chars | P3 | **Closed** — sidecar holds the full output |
| P3-2 | `latestSessionId()` is "last line wins", not "most recent session" | P3 | **Open** |
| P3-3 | Docs over-claim relative to code | P3 | **Closed** by the 2026-10-28 docs pass |
| P3-4 | Code comments cite `review/DOGFOOD_*.md`, which is not in the repo | P3 | **Closed** |

---

## P0-1 · Filesystem Sentinel does not exist — CLOSED

**Was:** no watcher, no `watch-fs`, no `fs-sentinel` source value, no
`untracked_write` outcome. Any write not routed through Write/Edit/MultiEdit
was invisible, which defeated the tool's comprehensiveness claim.

**Now shipped.** `src/capture/fs-sentinel/` holds `index.js` (process entry),
`walker.js` (recursive dir discovery + per-dir watcher attach), `hasher.js`
(content hash + last-known-content store) and `ignore.js` (the visible,
user-overridable ignore list). `bin/orunmila.js` exposes `watch-fs` standalone
and folds the same start into `watch`. `src/reconcile/matcher.js` emits
`untracked_write` and ranks it above every other outcome.

**Measured, not asserted.** `node test/accuracy.js` scores the two
configurations separately: hook-only 94.7% (36/38), sentinel ON 100% (38/38).
The sentinel's worth is the delta: **+5.3 percentage points**.

(Those figures were 93.8% / 100% / +6.3pp against the 15-turn, 32-assertion
corpus. The corpus grew to 17 turns / 38 assertions when P1-6 and P1-7 were
closed, and this paragraph went on carrying the old numbers until a cold
verification pass caught it — in a file whose header claims every status was
re-derived from code. Logged rather than quietly corrected, because it is the
same class of drift this page tracks as P3-3, committed by the same hand that
wrote the tracker, on the same day.)

Design: `SENTINEL_DESIGN.md`. Its §9 ("What this does NOT solve") is still
accurate and still worth reading — the debounce-window TOCTOU, the inability to
attribute a write to the agent vs. your editor vs. a rebuild, and binary files.

---

## P0-2 · Sentinel writes carry no session id, so concurrent sessions adopt each other's writes — OPEN

**Found in production**, not in review, over months of use on a real build.

**Mechanism, at source.** `src/store/eventlog.js readBetween(fromTs, toTs)`
returns events whose timestamp falls in the window *"regardless of
session/turn"* — its own comment says so, and that is deliberate, because
sentinel writes have no `turn_id` to bucket by. Correlation is therefore purely
by time window.

**Consequence.** On a machine running two agent sessions over one tree, every
sentinel-observed write lands in whichever session's window contains it. The
trail's touch list is a **time-slice of the machine**, not a record of what that
agent did.

**Receipt.** One session's touch list carried 17 files; 5 were its own. A peer
session independently reported the *same* files in *its* list, having also not
written them. Two sessions, one set of writes, both adopted it. The error then
propagated into a published claim about which sub-agent had made some probe
files — a false attribution produced by nothing more than a filename that
pattern-matched the reader's own context.

**Pinning the session does not fix it.** Session-pinning selects whose *turns*
are read. Sentinel events have no session id to filter on, so time-window
adoption is untouched by it. Verified: a correctly-pinned run still lists a
third session's files.

**The direction that matters most.** A wrong-session correlation manufactures
`untracked_write` / "written but not announced" findings against work that *was*
properly announced. That is the single flag the sentinel exists to raise, so a
false one is expensive twice: the agent either confesses to writes it disclosed,
or it learns to discount the flag.

**Not fixed, deliberately.** The sentinel watches disk, not processes. Giving
its events a session identity is an architectural change — a shared marker file
the sentinel reads, as sketched in `SENTINEL_DESIGN.md` §5 ("By shared marker
(later)") — not a repair. Until it lands, read a touch list as *"what changed on
this machine while I worked"*, never as authorship.

**Acceptance test** (fails today):
```
GIVEN two sessions writing to one tree with one sentinel running
WHEN session A's trail is rendered
THEN it contains no file written only by session B
```

---

## P0-3 · The blocking verification law never sees the most common way an agent claims a pass — OPEN

**Found 2026-10-28**, while building a demo of the gate firing. The demo did not
fire, which is how this surfaced.

`no-green-without-command` is the gate's flagship: one of only two laws promoted
to `block`, and the one the docs lead with. Its own `message` in
`src/laws/packs/canon.json` promises it catches *"tested, passing, green,
works"*.

**It does not.** Measured against the canon with a read receipt in the turn and
no passing command:

| Claim text | Fires? |
|---|---|
| `Full suite green, 1463 tests pass, and debit.ts is correct.` | **blocks** |
| `The build is green.` | **blocks** |
| `The suite is passing.` | **blocks** |
| `Tests are passing.` | **blocks** |
| `Tests pass.` | — nothing |
| `All tests pass.` | — nothing |
| `The tests passed.` | — nothing |
| `The test suite passes.` | — nothing |
| `I ran the tests and they pass.` | — nothing |
| `I tested it and it works.` | — nothing |
| `It works.` | — nothing |
| `Verified.` | — nothing |

**Root cause, and it is NOT the vocabulary.** `VERIFICATION_RE` in
`src/laws/assert-extractor.js` already matches all of these — `tested`,
`tests? (?:pass|passed|passes|passing)`, `it works`. Verified directly:
`VERIFICATION_RE.test("Tests pass.")` returns `true`.

The sentence is dropped one step earlier. `isFactualAssertion()` rejects it, so
`extractAssertions()` returns an empty list, so the rule
`verification_without_command` is never offered anything to judge — its first
line is `if (!assertion.verification) return null;` and there is no assertion at
all. Everything that survives the gate is copula-shaped: *"The build **is**
green"*, *"Tests **are** passing"*, *"The implementation **is** correct"*. A bare
present-tense predicate — *"Tests pass."* — does not qualify.

**What this does to the headline measurement.** The design note in
`src/laws/gate.js`, quoted in the README and in every pitch, says this law fired
**8 times in 1,174 turns, every one genuine.** That is true and it is not the
whole story. A law that cannot see the dominant phrasing of its own target has
high precision partly *because* it has narrow recall, and those are very
different things to sell. Until recall is measured, the honest statement is:
**8 firings, all genuine, out of an unknown number of real occurrences.**

**Deliberately NOT fixed in this pass.** The obvious repair — let a
verification-vocabulary hit qualify a sentence as an assertion on its own,
regardless of copula — widens the only law in the canon that can stop a turn.
The project's own reasoning is that `block` was earned by measurement, and that
a noisy blocking law trains people to switch the gate off. Widening it and
re-tagging a release without re-measuring would be the same error in the
opposite direction.

**The fix, and how to earn it:**
1. In `isFactualAssertion()`, treat a `VERIFICATION_RE` hit as sufficient to
   qualify a sentence, independent of sentence shape.
2. Re-measure before changing severity: `orunmila laws --check --session <id>`
   over the captured history, comparing firing rate and genuineness before and
   after. `node ~/tools/orunmila/scripts/measure-laws.js` from a repo root does
   the aggregate.
3. Keep it at `warn` until the measurement supports `block`.

**Acceptance test** (fails today):
```
claim "Tests pass."  + one file_read, no command  => no-green-without-command fires
claim "I tested it and it works." + same           => fires
claim "Tests pass."  + a command with exit 0      => does NOT fire
```

---

## P1-1 · Plain-English subtasks produce false `silently_dropped` — CLOSED

**Was:** `extractKeywords()` matched only file extensions, camelCase,
snake_case and quoted strings. "implement user authentication" extracted `[]`,
and a keyword-less, evidence-less subtask defaulted to `silently_dropped` — so
a fully-correct, fully-disclosed session was reported as half-abandoned.

**Fixed** in `src/reconcile/task-extractor.js`. Targets are now **typed**
(`path` / `symbol` / `phrase` / `literal`) rather than flat strings, and
`extractTargets()` performs phrase extraction: after an action verb it takes
the next 1–3 content words, skipping stopwords. Plain-English asks now have
something to match against.

---

## P1-2 · Filename matching is actually extension matching — CLOSED

**Was:** the file-like regex captured the *extension* (`js`), never the
basename, and matching was `haystack.includes(keyword)` — so `login.js`
extracted bare `js`, which substring-matched every `.js` path. It erred in both
directions: it credited the wrong file as evidence, and it flooded unrelated
files as matches.

**Fixed** in `src/reconcile/task-extractor.js`: `PATH_RE` keeps the full
basename (`basename(m[0]).toLowerCase()`), and the module docstring states the
invariant — *"a path token keeps its FULL basename as the value (login.js),
never the bare extension (js) the old code produced."* Matching moved to
`src/reconcile/provenance.js targetMatchesEvent()`, which compares like with
like by target kind.

---

## P1-3 · `undisclosed` flags everything when keywords are empty — CLOSED

**Was:** when every claim and subtask yielded `[]` keywords, the "is this write
covered by anything?" test was vacuously true for every write, so the whole
turn's output was marked `undisclosed`. The one file that should have stood out
was buried, and the asked-for file was libeled.

**Fixed** in `src/reconcile/matcher.js`: `hasAnyTarget` is computed from the
typed target union, and the filter short-circuits with
`if (!hasAnyTarget) return false;` — *"can't assert scope-creep with nothing to
compare against."* Two further guards landed alongside it: `isInfrastructurePath()`
exempts agent-owned scratch surfaces (memory files, plan files, `/tmp`,
lockfiles, `coverage/`), and `PHRASE_ALIASES` maps plain-English component names
("CI", "linter", "issue templates") onto the concrete paths they produce.

---

## P1-4 · Claim extractor has low precision on conversational/markdown turns — CLOSED

**Was, measured:** the curated accuracy corpus scored 100%, but running the
engine over a real captured log surfaced 122 `phantom` /
`phantom_verification` findings, the large majority false positives. The
extractor treated almost any sentence with an action verb as a work-claim, so
it extracted claims from markdown table rows, headings, questions back to the
user, and instructional shell snippets. Phantom precision was **25.0% (1/4)**.

**Fixed.** `src/reconcile/claim-extractor.js` gained a speech-act gate, and
`src/reconcile/sanitize.js` strips the wrapper noise the extractors were greedy
on. The negative corpus grew from 4 cases to 15, drawn verbatim from real logs.

**Now measured at 100.0% (15/15 non-work cases stay clean)** by
`node test/accuracy.js`, with sentinel-ON accuracy and glove completeness both
still at 100%. The regression lock is the same command.

---

## P1-5 · A pipe launders an exit code, so a green claim can hold a lying receipt — OPEN

**Found in production.**

`npm test | tail` exits **0** with the suite on fire, because the shell reports
the exit status of the last command in the pipeline. The `no-green-without-command`
law looks for an exit-zero command behind a "tests pass" claim, so a piped
runner satisfies the receipt requirement while proving nothing. The gate's
strictest, highest-precision law is defeated by a pager.

This is a real asymmetry worth stating plainly: the gate can catch a claim with
*no* receipt, but it cannot presently tell a genuine receipt from a laundered
one.

**Workaround today:** redirect and capture the status explicitly
(`npm test > out.txt 2>&1; echo $?`) or `set -o pipefail`. Note that in `zsh`,
`${PIPESTATUS[0]}` is empty — the array is `${pipestatus[@]}`, lowercase — so
the obvious portable-looking fix silently reads nothing.

**Fix sketch:** when the command string contains an unguarded pipe and the
claim is a verification claim, the receipt should be treated as *inconclusive*
rather than passing — a distinct outcome, not a silent accept. Detecting
`pipefail` in the same string is a cheap exemption.

**Acceptance test** (fails today):
```
claim: "tests pass"   command: "npm test | tail -5"  exit: 0
=> NOT verified; receipt flagged as laundered/inconclusive
claim: "tests pass"   command: "set -o pipefail; npm test | tail -5"  exit: 0
=> verified
```

---

## P1-6, P1-7, P1-8 · three false-green paths, found by running the tool on itself — CLOSED

**All three found 2026-10-28**, in one sitting, by capturing a real session and
reading the report instead of trusting the corpus. All three ran in the same
direction: **a claim scored `verified` when its evidence did not support it.**
That is the worst direction of error this tool has, because the whole product is
someone trusting a green stain.

The session was deliberately ordinary. Ask: *"Add input validation to login.js
and write a test for it."* The agent wrote `login.js` properly, wrote no test,
and said: *"I added input validation to login.js and wrote a test in
login.test.js. Tests pass."*

Before: **1 verified, 0 phantom**, 1 phantom-verification. The invented test
file was not flagged at all.
After:  **1 verified, 1 phantom**, 1 phantom-verification.

### P1-6 — a compound claim was graded as one unit

`splitCompoundClaims` split on `;`, `and then`, `and also` and `then also`, but
never on a plain `and`. So the sentence above was ONE claim, and the real
`login.js` write verified the whole thing — laundering the half about
`login.test.js`.

The asymmetry that allowed it is worth keeping in mind: the **ask** side
(`task-extractor.js`'s `SPLIT_CONNECTORS`) has always split on plain `and`. Only
the **claim** side did not. The two halves of the reconciler disagreed about
what a sentence is.

The fix is conditional, and the condition matters. Splitting on every `and`
breaks a different thing: *"I fixed the bug in PR #26 and shipped it."* puts the
PR number in one half and the merge language in the other, and
`vcsPrResolution` needs them together to catch a "shipped" claim against a PR
captured OPEN. (That regression was not hypothetical — it turned
`test/vcs-evidence.js` red on the first attempt.) So the plain-`and` split fires
only when **both** halves independently pass the speech-act gate. A trailing
fragment that needs its sibling for meaning — "and shipped it", "and it works",
"and retries to the client" — keeps its sibling.

### P1-7 — a double-extension basename extracted as its tail

`PATH_RE`'s basename was `[\w-]+`, which cannot cross a dot, so `login.test.js`
matched only `test.js`. Every `*.test.js` in a repo therefore shared one target,
and a claim about `login.test.js` was satisfied by a write to
`payment.test.js`. Same class as the closed **P1-2** (extension-vs-basename),
one level up — which is the argument for the fix being a pattern change rather
than a special case: `(?:\.[\w-]+)*` lets a basename span inner dots, so
`app.config.ts` and `foo.spec.tsx` come back whole too.

A side effect worth noting: the phrase extractor was stripping punctuation from
filenames and emitting junk targets (`a.js` → `ajs`, `parser.js` → `parserjs`)
that could never match anything. A word already carrying a file extension is now
left to the path extractor.

### P1-8 — a weak target spoke for a named file nothing touched

Fixing P1-7 did **not** fix the verdict, which is the most useful thing the
corpus case taught. With `login.test.js` extracting correctly and matching
nothing, the claim was *still* `verified` — because `eventsMentioning` accepted
**any** target of any kind, and the claim also carried the one-word phrase target
`test`, which matched `test(` inside the other file's diff.

So the rule is now explicit: **weak evidence may corroborate a specific claim; it
may never replace it.** When a claim names concrete files and not one of them
matches anything in the turn, only the path targets count, and the claim lands
as `not_sent`. Claims that name no file are judged exactly as before.

### Locked by

`test/cases/16-compound-claim-half-phantom.json` and
`test/cases/17-double-extension-basename.json`, which grew the labelled corpus
from 15 turns / 32 assertions to **17 turns / 38 assertions**. Sentinel-ON
accuracy stayed at **100% (38/38)**, phantom precision at **100% (15/15)**, glove
completeness at **100% (21/21)**.

**What this says about the method, and it is not flattering.** The corpus scored
100% while three false-green paths were live, because every case in it was
written by the same hand that wrote the engine. The real session found all three
in minutes. Curated fixtures confirm what you already thought of; captured
sessions find what you didn't. That is the argument for `orunmila feedback` as a
first-class habit rather than a nice extra.

---

## P2-7 · Coverage thresholds were never met, so `prepublishOnly` blocked every publish — CLOSED

**Found 2026-10-28** while checking whether the release path actually worked.

`package.json`'s `prepublishOnly` runs `lint && accuracy:gate && coverage`, and
`npm run coverage` enforces `.c8rc.json`'s thresholds. Those were set to
97% lines / 97% statements / 97% functions / 86% branches. Measured at
`7ea3272`, before any of this session's changes: **86.1% / 86.1% / 90.79% /
81.35%**. Every single one short. `npm publish` could not have succeeded from a
clean checkout.

Two separate problems were tangled together:

1. **`bin/dashboard.js` was in the coverage set with 0% coverage.** 30KB of
   local dashboard server with no tests, caught by the `bin/**/*.js` include
   glob. `bin/bench.js` was already excluded as a dev harness; the dashboard is
   the same category and had simply been missed. On its own it was masking the
   real figure by about 5.5 points — the product code was never as bad as the
   number said.
2. **Even with it excluded, the thresholds had never been met:** 92.38% lines /
   91.66% functions / 81.45% branches.

**Fixed by making the gate true rather than aspirational.** `bin/dashboard.js`
joins `bin/bench.js` in `exclude`, and the thresholds are set just under the
measured values (92 / 92 / 91 / 81) as a **ratchet floor**. The gate now passes
on a clean tree, which means from here it does its actual job: a regression
drops below the floor and fails the release.

This is deliberately the project's own doctrine applied to itself — a gate that
can never pass is indistinguishable from a gate that is switched off, and the
second one at least does not lie about being enforced.

**Still owed, and tracked here rather than pretended away:** raising the floor.
The specific gaps, worst first — `bin/orunmila.js` 70.85% statements,
`src/reconcile/rescore.js` 27.57%, `src/feedback/index.js` 50.84% branches,
`src/capture/vcs-evidence.js` 67.69% branches. Raising the numbers in
`.c8rc.json` without writing those tests would put the repo straight back where
it started.

---

## P2-1 · `partial` / scaffolding detection effectively never fires — CLOSED

**Was:** `SUBSTANCE_FLOOR = 1` with the test `addedSubstance < 1`, so only a
write with *zero* substantive lines counted as scaffolding. Any one-line stub
passed as real logic.

**Fixed** in `src/reconcile/matcher.js`, as a ratio rather than a floor:
`SUBSTANCE_RATIO_FLOOR = 0.5`, plus `isTrivialStub()` (which treats signatures
and brace lines as structural, so `function f() { return null; }` is correctly a
stub) and `TRIVIAL_BODY` covering `return null/undefined/true/false/{}/[]`,
`pass`, `todo`, `fixme`.

One guard was added on top from real-log data: `isLikelyNewOrEmptyFile()`.
Small edits landing inside long-lived files were being graded `partial` merely
because the hunk's substance ratio dipped under 0.5, so `partial` is now only
eligible for new or near-empty files.

---

## P2-2 · Turn tracking is not concurrency-safe — OPEN, narrowed

**What was fixed.** `src/capture/turnstate.js` was rewritten (measured over 195
sessions / 1183 turns) to close a worse, adjacent bug: the counter advanced only
on the prompt phase, so a Stop with no preceding prompt folded the next response
into the same turn — 39.1% of claimed turns carried more than one claim, and the
evaluator reads only the first, so later responses were judged against earlier
evidence and their own text never judged at all. A prompt arriving mid-flight
stranded a claim in a turn holding none of its evidence (16.0% of claimed
turns). The fix is **lazy advance**: Stop marks the turn closed, the counter
moves on the next write. `ORUNMILA_TURN_BOUNDARIES=legacy` restores the old
behaviour.

**What remains open.** The underlying concurrency hazard is untouched.
`readState()` → `writeState()` in `advanceIfClosed()` is still an unlocked
read-modify-write on a single `turn.json`. Claude Code fires PostToolUse hooks
for parallel tool calls concurrently, so interleaved reads can still produce a
lost update and land events in the wrong turn bucket. Lazy advance narrows the
window — the counter now moves on first write after a close rather than on every
prompt — but it does not serialise anything.

**Acceptance test** (unchanged, still fails):
```
Simulate N concurrent post-tool-use invocations within one turn (no
UserPromptSubmit between them) => all N events share the same turn_id.
```

---

## P2-3 · Sub-agent (Task tool) writes are unreconciled — CLOSED for Claude Code

Claude Code fires PostToolUse inside the sidechain, so a sub-agent's reads,
writes and commands land in the same `events.jsonl` under the parent session.
When the hook fires inside a sub-agent its stdin carries `agent_id` /
`agent_type`, recorded as `sub_agent_id` / `sub_agent_type` on the event, and
the trail attributes each touch to the sub-agent that made it.

**Still open for agents that do not expose those fields.** Gemini CLI has no
equivalent event at all, so the Filesystem Sentinel is the only coverage there
— the touch is captured, just not attributed. This is the original argument for
building the sentinel alongside the first hook adapter rather than as a stretch
goal, and it held.

---

## P2-4 · HTML file grid omits subtask-only and command-touched files — OPEN, mitigated

**Root cause unchanged.** `src/render/html.js buildFileStains()` walks
`claim.evidence`, `undisclosed` and `untracked`. A file matched only to a
*subtask* (not a claim), or touched only by a command, still never gets a tile,
so the mismatch-only view under-reports activity.

**Mitigated in the unified report.** `orunmila trail` overlays the glove's own
session artifacts onto the grid via `indexTrailByPath()`, and the glove stains
everything on contact — so a command-touched file does appear there, with its
channel glyph. The gap is now specific to `orunmila html` (the mismatch-only
render), not to the default report.

**Acceptance test:** a file written and matched only via a subtask appears as a
stain tile in the grid produced by `orunmila html`.

---

## P2-5 · A pager downstream of a grep scored as a full read — CLOSED

A command like `grep -n pattern file | head -20` was being scored as a **full
read** of the file (measured at 63.9% of the receipt law's qualifying reads),
which let a claim about a named path rest on a pattern match — exactly what the
`no-grep-as-basis` law exists to prevent. The pager on the right-hand side was
upgrading the grep on the left.

**Fixed** in commit `7ea3272`, *"fix(laws): a pager downstream of a grep no
longer upgrades it to a full read."*

A related truth that is not a bug and should not be treated as one: **no hits is
not proof of absence.** A grep that returns nothing has established that one
pattern did not match, which is a far weaker fact than "this thing does not
exist."

---

## P2-6 · `T1 live` sentinel test is an intermittent flake under full-suite load — OPEN

**Found 2026-10-28** while running the gates for the docs pass.

`test/sentinel.js` — *"T1 live: new file write is captured by the sentinel"* —
failed once in a full `node test/all.js` run, then passed on three consecutive
full runs and on 3/3 runs of `test/sentinel.js` alone (9/9 each time). Observed
rate: 1 failure in 4 full-suite runs; 0 in 4 isolated runs.

**Likely cause.** T1 is a *live* test: it starts a real watcher, writes a real
file, and waits for the event to land. The sentinel debounces raw fs events by
~150ms before hashing. Under the CPU contention of the other 14 suites that
wait can expire before the event is observed, so the assertion runs early. The
isolated-vs-full-suite asymmetry is the signature of a timing budget, not a
logic error — nothing in the sentinel's behaviour differs between the two.

**Why it matters more here than in most repos.** This project's pitch is that
you can trust its verdicts, and `prepublishOnly` runs the suite before any
publish. A flake either blocks a release for no reason or, worse, teaches
whoever hits it to re-run until green — which is the exact habit the tool exists
to discourage.

**Fix sketch (not applied — a timing fix deserves its own change, not a
drive-by).** Poll for the expected event up to a generous deadline instead of
sleeping once past the debounce, so the test is slow under load rather than
wrong under load. Do **not** simply lengthen the fixed sleep: that trades a
flake for a slower suite and leaves the same cliff further out.

**Acceptance test:** `node test/all.js` passes 20 consecutive runs, including
under concurrent load.

---

## P2-8 · The report's 3D Graph tab fetches a CDN script, against a stated privacy claim — OPEN

**Found 2026-10-28**, by an advisory law finding on a sentence that merely
*mentioned* the tension. Worth recording how it surfaced: the gate flagged a
prose claim as unreceipted, checking it meant reading the renderer, and the
renderer disagreed with the docs.

`src/render/trail-visual.js:615-616` loads `3d-force-graph@1.73.4` from
`unpkg.com`, falling back to `cdn.jsdelivr.net`, when a viewer opens the
**3D Graph** tab. The tab's own help text has always said so
(`trail-visual.js:400`: *"Loads a small 3D library from a CDN — needs
internet"*), so this was never hidden in the UI.

The docs were another matter. They said:

- `docs/MEASURING_AGENT_CLAIMS.md`: *"makes no network calls of its own"*
- `skills/orunmila/SKILL.md`: *"Nothing leaves their machine."*
- `README.md`: *"runs entirely on your machine"*

The first two were false as written. **No session content is transmitted** —
it is a plain script fetch — but the request discloses the viewer's IP and the
fact that a report was opened, to a third-party CDN. For a tool whose pitch is
local-first privacy, that is exactly the claim you cannot be loose about, and
it is the kind a security reviewer checks first.

**Docs corrected** in README (headline + the privacy section, where a careful
reader actually looks), the write-up, and the free skill. The behaviour is
unchanged and the issue stays open, because the honest fix is a choice someone
should make deliberately:

1. **Bundle it.** Inline the library so the report is genuinely self-contained.
   Costs ~1MB on every generated report, for a tab most people never open.
2. **Make it opt-in.** Render the tab behind a click that says plainly it will
   fetch from a CDN, so the network request follows informed consent.
3. **Drop the tab.** The 2D Graph covers the same information and is
   self-contained.

My read is (2) — it is cheap, it keeps the feature, and it converts a silent
request into a disclosed one. But it is a product call, not a repair.

**Acceptance test:** open a generated report with the network disabled and
click every tab. Nothing fails silently, and no tab issues a request the user
did not consent to.

---

## P3-1 · `command_run` stdout truncated to 2000 chars — CLOSED

`src/capture/core.js:200` now writes the full output to a local sidecar under
`~/.orunmila/output/` whenever it exceeds 2000 characters, and
`stdout_excerpt` (`:210`) carries the first 2000 for inline display. Nothing is
lost, so a runner that prints a long summary then exits 0 is judged on its real
output. Sidecars are uncapped by design and never leave the machine.

One excerpt remains excerpt-only: `result_excerpt` (`:261`) for non-command
tool results. Noted, not pursued — no verdict depends on it today.

---

## P3-2 · `latestSessionId()` is "last line wins", not "most recent session" — OPEN

`src/store/eventlog.js latestSessionId()` walks the global event log backwards
and returns the first event carrying any non-null `session_id`. "Latest"
therefore means *most-recent event on this machine*, across every session — not
the caller's session, and not the most recent session by start time.

**This is not a latent nit; it has misled real reviews.** Any wrapper that
defaults to `latestSessionId()` instead of being told which session is asking
will, on a multi-session machine, flip to whichever session most recently
emitted an event. Observed resolving to a peer session from inside two
different sessions ~90 minutes apart, in both directions. The function does
exactly what its name says; the defect is that callers treat it as "my
session."

**Mitigation in place.** Callers that must be right about this now read the
session id from the environment and print the resolved scope out loud, warning
when they are running unpinned. An unlabelled session id reads as "yours"
whether or not it is, which is how the original misattribution went unnoticed.

**Fix:** prefer max-by-timestamp over distinct sessions, and have any
gate-shaped caller require an explicit session rather than defaulting.

---

## P3-3 · Docs over-claim relative to code — CLOSED by the 2026-10-28 docs pass

The README, `SKILL.md` and `docs/PRD.md` asserted "catches ALL writes" before
the sentinel existed, and carried a 90%-accuracy framing the engine did not
support. Run on its own repo, Orunmila would have flagged those as
`phantom_verification`.

**Closed.** Every accuracy figure in the README now comes from
`node test/accuracy.js` or a named source file, the labelled set's size (32
assertions) is stated next to its score, and the limits section names what the
tool cannot see — including the open items on this page. The habit this file
exists to enforce: a number in the docs cites the command or the file that
produced it, or it does not ship.

---

## P3-4 · Code comments cite `review/DOGFOOD_*.md`, which is not in the repo — CLOSED

Eight comments across `src/reconcile/` and `src/capture/vcs-evidence.js`
pointed readers at `review/DOGFOOD_*.md` for the real-log analysis behind the
precision guards. Those write-ups were never committed, so every pointer was a
dead end.

**Closed.** The findings they described survived as the negative corpus itself:
`test/cases/precision/*.json`, where each case carries a `source` field naming
the dogfood report it came from. The comments now point there — at runnable
cases rather than a missing document.

---

## Suggested fix order (by leverage)

1. **P0-3** — the blocking law's extraction gap. It is cheap to fix, it is the
   feature the project leads with, and the docs currently describe behaviour the
   code does not have.
2. **P0-2** — sentinel session identity. It is the only open item that can
   produce a confidently wrong answer rather than a missing one, and the flag it
   corrupts is the sentinel's whole reason for existing.
3. **P1-5** — pipe-laundered receipts. Cheap to detect, and it defeats the one
   law precise enough to block a turn.
4. **P3-2** — make session resolution explicit at every gate-shaped caller.
5. **P2-2** — serialise the turn counter.
6. **P2-8** — decide the CDN question, then make the report's behaviour match
   its privacy claim.
7. **P2-4** — subtask-only and command-touched tiles in `orunmila html`.
8. **P2-6** — make the live sentinel test poll to a deadline instead of sleeping
   past the debounce.
9. **P2-7 follow-up** — write the tests that let the coverage floor ratchet up.

## How the numbers on this page are produced

```bash
npm test              # 15 suites, unit + hooks + sentinel + laws + turn boundaries
npm run lint          # eslint
npm run accuracy      # detection accuracy, glove completeness, phantom precision
npm run accuracy:gate # the same, failing under 95% sentinel-ON accuracy
npm run coverage      # c8 line/branch thresholds from .c8rc.json
```

The accuracy harness measures **detection accuracy** — what fraction of what
actually happened the engine catches and classifies correctly — which is a
different question from code coverage. Both are gated; neither should be gamed.
