---
name: agent-review-workflow
description: Use when someone has to review work an AI coding agent produced and wants to know where to look first - "review this agent session", "what should I check in this PR the agent wrote", "where did the agent go wrong", "turn this session into a review checklist", "I don't trust this diff", "code review an agent's work", "what did the agent not tell me". Turns a finished orunmila session into a ranked reviewer checklist plus a fix-it prompt.
license: MIT
---

# Turn a finished agent session into a review checklist

Reviewing agent work is different from reviewing a colleague's. A colleague's PR
is usually what they say it is. An agent's might be missing a third of the ask,
carrying two files nobody mentioned, and asserting a test run that never
happened — all while reading as confident and complete.

This skill takes a captured orunmila session and produces a **ranked** checklist:
what to look at first, what can be skimmed, and what to send straight back.

Requires a captured session — the `orunmila` skill (free) sets that up.

## Steps

1. Confirm a session exists:
   ```bash
   npx orunmila status
   ```
   If nothing is captured, stop and install the Stain Map first (`orunmila` skill).
2. Pull the machine-readable report:
   ```bash
   npx orunmila json --out review.json
   npx orunmila trail --out trail.html
   ```
3. Build the checklist in the triage order below. **Rank it — do not just list
   findings.** An unranked list of 30 items gets skimmed; a ranked list of 30
   gets the top 5 actually checked, which is the point.
4. Hand them the HTML report alongside it. Its Report tab already carries a
   copy-paste prompt that sends the agent back to fix every flagged item.

## Triage order

Work down. The ordering is by how expensive the failure is to miss, not by how
loud the finding looks.

1. **`untracked_write`** — a real change on disk that no tool call accounts for.
   Highest signal in the whole report: something changed and the agent's own tool
   API never disclosed it. Read every one of these diffs.
2. **`phantom_verification`** — "tested and passing" with no passing command
   behind it. This is the finding that most often means the work was never
   checked at all, and it is the one humans are most likely to take on trust.
   Run the tests yourself.
3. **`silently_dropped`** — part of the original ask with no evidence that was
   never mentioned again. Agents rarely lie about dropping a requirement; they
   just stop bringing it up. Compare against the original request, not against
   the agent's summary.
4. **`phantom`** — claimed, with zero matching tool call. Often a file the agent
   believes it created. Check it exists.
5. **`undisclosed`** — a file changed that neither the claim nor the ask covers.
   Sometimes legitimate incidental cleanup, sometimes scope creep nobody agreed
   to. Judge, don't assume.
6. **`partial`** — the file was touched but the diff is scaffolding: a stub, a
   signature, a `return null`. Reads as done in a summary.
7. **`unverifiable`** — too vague to check ("improved error handling"). Not a
   defect; a prompt to ask the agent what it actually means.
8. **`verified`** — skim. The receipt checks out. Note that this means the claim
   matched the evidence, **not** that the code is correct.

## Reading the lineage

The trail marks each file as `touched_by` the files read earlier in the same
turn. Useful for "what informed this change", with one honest caveat to pass on:
**it is a turn-scoped heuristic, not proven data flow.** If the agent read A and
wrote B in the same turn for unrelated reasons, B still shows `touched_by A`.
The report stamps those edges `inferred`. Treat them as a lead, not a fact.

## What to tell the reviewer

- **A green stain is not a passing review.** It means the agent's story matched
  the evidence. The code can still be wrong, the approach can still be wrong, and
  the tests can still be testing the wrong thing. `exit 0` is not "correct".
- **A red stain is not an accusation.** It means a receipt is missing. Sometimes
  that is a confabulation; sometimes the work happened through a channel with no
  hook. The report deliberately never asserts which, because intent is not
  observable from the outside.
- **Check the touch list's scope before trusting attribution.** If two agent
  sessions were running over the same tree, the disk observer's writes carry no
  session id and each session adopts the other's. Read it as "what changed on
  this machine during this window", not as authorship. (P0-2 in
  `review/ISSUES.md`.)
- **The summary line is the fastest read.** `1 verified, 1 phantom,
  1 phantom-verification, 0 silently dropped, 0 undisclosed` tells a reviewer in
  one glance whether this session needs an hour or five minutes.

## Sharing the report

The HTML is the artifact most likely to get pasted into a PR or sent to a
teammate. It is sanitised on render by default — the home directory collapses to
`~` so the OS username doesn't ride along — and any path listed in
`.orunmila/redact` is masked in the grid, the trail, the lineage edges and inside
command strings. The report prints exactly what it is hiding, so it is never a
silent gap.

```bash
printf 'secret/\n.env\n' > .orunmila/redact
npx orunmila trail
```

## See also

- `orunmila` (free) — capture a session in the first place.
- `closeout-gate-setup` — catch these at write time instead of review time.
