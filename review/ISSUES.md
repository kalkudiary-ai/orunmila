# Orunmila — Prioritized Issue List & Acceptance Tests

Every issue below was confirmed by running the actual code, not inferred from
the spec. Each carries a reproduction, the root cause with a `file:line`
pointer, and an acceptance test that should PASS once fixed (and FAILS today).

Severity legend: **P0** = the tool's central claim is false until fixed ·
**P1** = produces wrong verdicts on ordinary input · **P2** = correctness gap ·
**P3** = polish.

---

## P0-1 · Filesystem Sentinel does not exist

**Claim affected:** PRD §6.4 ("the most important addition"), §3 goal 1
("catch *every* file mutation... regardless of mechanism"), README "catches
ALL writes."

**Reality:** No watcher, no `watch-fs` command, no `fs-sentinel` source value,
no `untracked_write` outcome anywhere in the tree. `grep -r "sentinel\|untracked_write\|watch-fs" src bin` returns nothing.

**Consequence:** Any write not routed through Write/Edit/MultiEdit is invisible.
A `Bash` heredoc, `sed -i`, a build step, an MCP server, or a sub-agent can
mutate the tree with zero stain. PRD §2 itself says this defeats the tool
"trivially."

**Acceptance test** (PRD Success Criterion §11, bullet 2):
```
GIVEN the sentinel is running
WHEN a file is modified via Bash (echo > file), not Write/Edit
THEN an event with source:"fs-sentinel" and type:"file_write" is logged
AND reconciliation emits outcome:"untracked_write" for that path
AND it is surfaced at the TOP of the terminal + HTML report.
```

Design: see `SENTINEL_DESIGN.md`.

---

## P1-1 · Plain-English subtasks produce false `silently_dropped`

**Reproduction:**
```
prompt: "Implement user authentication, and add rate limiting."
claim:  "I implemented user authentication in auth.js and added rate limiting in limiter.js."
events: write src/auth.js (real logic), write src/limiter.js (real logic)
=> RESULT: both subtasks reported silently_dropped. summary.silently_dropped = 2
```
A fully-correct, fully-disclosed session is reported as half-abandoned.

**Root cause:** `task-extractor.js:53 extractKeywords()` only matches file
extensions, camelCase, snake_case, and quoted strings. Plain words extract
`[]`. `matcher.js:73-75` then defaults a keyword-less, evidence-less subtask
to `silently_dropped`.

**Acceptance test:**
```
extractKeywords("implement user authentication") => non-empty, semantically useful
reconcile(above scenario).summary.silently_dropped === 0
```

---

## P1-2 · Filename matching is actually extension matching (both error directions)

**Reproduction A (false negative — misses a real lie):**
```
prompt: "fix the bug in payment.js"  claim: "I fixed the bug in payment.js."
events: write src/unrelated.js
=> claim outcome: verified, subtask: addressed   (WRONG — wrong file edited)
```
**Reproduction B (false positive):** keyword `js` (the bare extension extracted
from "login.js") substring-matches *every* `.js` path.

**Root cause:** the file-like regex `task-extractor.js:57` captures group
`m[1]` = the extension only (`js`), never the basename. Then
`provenance.js:49` matches via `haystack.includes(keyword)` — substring, not
token/basename equality.

**Acceptance test:**
```
extractKeywords("login.js") includes "login.js" (or "login"), NOT bare "js"
matchEvent(keyword "payment.js", write to "unrelated.js") === no match
matchEvent(keyword "login.js", write to "login.js") === match
```

---

## P1-3 · `undisclosed` flags everything when keywords are empty

**Reproduction:**
```
prompt: "make the dashboard load faster"
claim:  "I optimized the dashboard query."
events: write dashboard.tsx (asked-for), write secret-thing-nobody-asked-for.ts
=> undisclosed: [dashboard.tsx, secret-thing-nobody-asked-for.ts]  (BOTH)
```
The one file that should stand out is buried; the asked-for file is libeled.

**Root cause:** `matcher.js:79-88`. When every claim/subtask yields `[]`
keywords, `allKeywords` is empty, so `!allKeywords.some(...)` is always `true`
→ every write is "undisclosed."

**Acceptance test:**
```
reconcile(above).undisclosed.map(u=>u.path) === ["src/secret-thing-nobody-asked-for.ts"]
```
(Depends on P1-1/P1-2 giving usable keywords first.)

---

## P2-1 · `partial` / scaffolding detection effectively never fires

**Reproduction:**
```
diff: "+function doThing(){ return null; }"
substanceStats => addedSubstance:1   outcome: verified  (expected: partial)
```

**Root cause:** `matcher.js:28 SUBSTANCE_FLOOR = 1` with the test
`addedSubstance < 1`, i.e. only a write with **zero** substantive lines is
"partial." Any 1-line stub passes as real logic. Forensic gap #4 (PRD §9.4)
is effectively unimplemented.

**Acceptance test:**
```
a 1-line stub returning null/undefined/pass, given a claim of "implemented",
=> outcome: partial    (use a ratio: addedSubstance/added < THRESHOLD, e.g. 0.5,
                        with an absolute floor for tiny diffs)
```

---

## P2-2 · Turn tracking is not concurrency-safe

**Root cause:** `turnstate.js` does read-modify-write on a single `turn.json`
with no lock. Claude Code fires PostToolUse hooks for parallel tool calls
concurrently; interleaved reads can read a stale/late turn number, so events
land in the wrong turn bucket. `bumpTurn` itself (`currentTurn`+1, write) is a
classic lost-update race if two prompts ever overlap.

**Acceptance test:**
```
Simulate N concurrent post-tool-use invocations within one turn (no
UserPromptSubmit between them) => all N events share the same turn_id.
```

---

## P2-3 · Sub-agent (Task tool) writes are unreconciled

The top-level hook stream may not include a sub-agent's internal Write/Edit
calls (README "Honesty about v0", PRD §10). Without the sentinel (P0-1) these
writes are both uncaptured AND unreconciled. The sentinel is the only
mechanism that closes this for Claude Code today.

**Acceptance test:** with sentinel running, a sub-agent file write surfaces as
at least an `untracked_write` (not silence).

---

## P2-4 · HTML file grid omits subtask-only and command-touched files

**Root cause:** `html.js:57-66 buildFileStains()` only walks `claim.evidence`
and `undisclosed`. A file matched to a *subtask* (not a claim), or touched
only by a command, never appears on the "map of where the agent went." The
visual under-reports activity.

**Acceptance test:** a file written and matched only via a subtask appears as a
stain tile in the grid.

---

## P3-1 · `command_run` stdout truncated to 2000 chars

`post-tool-use.js:129`. A runner that prints a long summary then exits 0 (or
vice versa) may be misjudged if the exit code is ever absent and parsing falls
back to stdout. Low risk; note only.

## P3-2 · `latestSessionId()` is "last line wins," not "most recent session"

`eventlog.js:90-94` returns the session_id of the final log line. After
interleaved sessions or a stale tail it can point at the wrong session.
Prefer max-by-timestamp of distinct sessions.

## P3-3 · Docs over-claim relative to code

README/SKILL/PRD assert "catches ALL writes," "M1 not a v2 feature," and a
90% accuracy framing the engine does not currently support. Orunmila run on
its own repo would flag these as `phantom`/`phantom_verification`. Align docs
with shipped reality, or build to the docs.

## P1-4 · Claim-extractor has low precision on conversational/markdown turns

**Measured, not inferred.** The detection-accuracy corpus (`test/cases/*.json`,
scored by `test/accuracy.js`) reaches **100% accuracy** (sentinel ON, 32/32) and
**100% glove trail completeness**. But running the engine over a *real* captured
log (`~/.orunmila/events.jsonl`, 27 turns, 510 events) surfaces a precision gap
the curated corpus did not stress: **122 `phantom`/`phantom_verification`
findings, the large majority FALSE POSITIVES.**

**Root cause:** `claim-extractor.js` (`extractClaims`) treats almost any sentence
containing an action verb, a verification word, or a typed target as a checkable
*work*-claim. On ordinary replies it therefore extracts claims from:
- markdown table rows (`| verified | ... |`) and headings (`## The core idea`)
- questions back to the user ("Want me to dig into the implementation?")
- instructional shell snippets shown to the human (`node bin/orunmila.js glove`)
- git/status narration over work already disclosed elsewhere

None of these are assertions of completed work, but each parses to a claim with
no matching event → `phantom`. There is no "is this even a work-claim?" filter
in the extractor today (confirmed: `claim-extractor.js` has only hedge/verb/
verification tagging, no markdown/question/code-fence guard).

**Measured number (real-log-derived negative corpus, `test/cases/precision/`):**
```
Phantom precision  25.0%  (1/4 non-work cases stay clean)
```
The one passing case is git narration that *does* have a backing commit event —
so narration-over-evidence is fine; pure prose/markdown/questions/instructions
are the false-positive source.

**Acceptance test** (FAILS today, should PASS once fixed):
```
node test/accuracy.js  =>  Phantom precision == 100% (4/4 non-work cases clean)
WITHOUT regressing: sentinel-ON accuracy stays 100% and glove stays 100%.
```

**Fix sketch (not yet applied — measured baseline established first, per review):**
a pre-filter in `extractClaims` that drops a sentence before claim-tagging when
it is a markdown table row / heading / bullet of pasted docs, a fenced or
inline-only code/command line, or a question (`?`-terminated with no action
verb outside code spans). Keep it conservative: only drop text that is clearly
not a self-assertion of work, so real claims are never silently swallowed.

---

## Suggested fix order (by leverage)

1. **P1-1 + P1-2 + P1-3 together** — one extractor/matcher rewrite fixes all
   three; this is the accuracy cliff. (`EXTRACTOR_DESIGN.md`)
2. **P0-1** — sentinel; makes the central comprehensiveness claim true.
   (`SENTINEL_DESIGN.md`)
3. **P2-1** — substance ratio.
4. **P2-2** — turn-id concurrency.
5. **P2-4 / P3-x** — visual + polish.

## Regression & accuracy corpus  (DONE — now measured)

The reproductions above are locked two ways:

1. **Regression** — `test/run.js` (folded into `npm test` via `test/all.js`)
   runs the dependency-free PASS/FAIL table, including the anaphora and
   turn-wide-command cases.
2. **Detection accuracy** — `test/cases/*.json` (15 labelled turns,
   `{prompt, claim, events, expect}`) scored by `test/accuracy.js`, which reports
   THREE measured numbers instead of an asserted one:
   - **accuracy** sentinel OFF vs ON (the sentinel's value is the delta, +6.3 pts)
   - **glove trail completeness** (everything-touched-is-documented, 100%)
   - **precision** against a real-log-derived negative corpus
     (`test/cases/precision/*.json`) — see **P1-4**; currently 25%, the open gap.

   Run: `node test/accuracy.js` (report) or `node test/accuracy.js --gate 95`
   (CI gate on sentinel-ON accuracy). Scripts: `npm run accuracy`,
   `npm run accuracy:gate`.
