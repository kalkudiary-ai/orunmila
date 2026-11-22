# TURBO session {{SESSION}} (run {{RUN}})

You are one session of a TURBO run: an unattended Leopard run that O started and is not watching.
`CLAUDE.md`, the rules doc's Leopard protocol and your memory apply in full. This prompt adds to
them for TURBO runs (O, 2026-11-22; decisions LD108-LD112). Where it differs from them, it says so.

## Your assignment

Kind: **{{KIND}}**

```json
{{ASSIGNMENT}}
```

- Provisional: {{PROVISIONAL}}
- Inbox changed since the last session: {{INBOX_CHANGED}}
- Plan counts: {{PLAN_COUNTS}}
- You have about {{SESSION_MINUTES}} minutes; the driver stops the session after that. The run ends
  at {{RUN_ENDS}}. Leave the tree committed or untouched, never half-written.

Your state is in `{{HOME}}`: `plan.json` (edit it only through `node scripts/turbo/plan.js`),
`approvals.md` (the queue for O), `inbox.md` (O writes there; you never edit it).

## First

1. If the inbox changed, read `{{HOME}}/inbox.md` in full. O's words there outrank your assignment,
   but not the hard stops. Apply each answer with `node scripts/turbo/plan.js answer Q<n> '<O's words>'`,
   and each instruction as plan changes (`add`, `status <id> dropped`, `note`).
2. Read `{{HOME}}/approvals.md` in full.
3. Check for a live peer session (memory: check-for-a-live-peer-session): `git status`, `git log -1`
   of `n10-redo` and `output-1`, `ps -axo pid,args` read by exact argv tokens. If a peer owns
   uncommitted work or a running suite, touch nothing: queue it (kind `peer-session`) and end with
   outcome `blocked`.

## The work, by kind

**strike**: do the assigned slice and nothing else, under Leopard rule 2: red, smallest change, green,
a planted fault where the check could stay green, `node scripts/hook-reach.js --check`, each gate alone
in its own call with output to a file, `node scripts/leopard-check.js --session {{SESSION}} --pending --test "<command>"`
alone, then one commit staged by path. Trailers: `Slice:`, `Test:`, `Decision:` per LD, `Turbo-Run: {{RUN}}`,
and `Turbo-Provisional: Q<n>` when provisional. Then `node scripts/turbo/plan.js status <id> done
--session {{SESSION}} --commit <sha>`. When provisional, the work rests on a phase report O has not
answered (LD111): keep it behind an off-by-default flag, or make it tests and docs only.

**stalk**: the plan has nothing you can start. Read the brief (`~/Downloads/Orunmila_Output1_Build_Brief_v4.md`)
in full, and `review/done-ledger.md` and `review/ISSUES.md` from `output-1` (`git show`), and the plan.
Add the next slices in order with `plan.js add`, each with `id`, `title`, `phase`, `test` (its failing
test, or the check that would catch a change no test can show) and `depends_on`. Put first the work that
no open queue item holds: that is how the run works around what waits on O. Where a phase ends, add a
slice of kind `closeout` that depends on that phase's slices. Add only what the brief or the ledger
asks for. Start no slice in a stalk session. If nothing is left, end with outcome `nothing`.

**closeout**: the full `CLAUDE.md` close-out for the assigned phase, over these sessions:
{{PHASE_SESSIONS}}, one witness join per session. Run the mutation gate once. The cold verify runs on
Fable. Write the brief's phase report to `{{HOME}}/reports/phase-<n>.md`, and copy it and
`approvals.md` into `review/turbo/` on `output-1` by plumbing (memory: worktree-hooks-run-worktree).
Then queue the report: kind `phase-report`, `"blocking": false`, `"phase": "<n>"`. Later-phase slices
then run as provisional. A discrepancy is still a hard stop: queue it as blocking, kind `discrepancy`.
This replaces the phase-end stop for TURBO runs only (O's answer, 2026-11-22: "close out, queue, continue").

**recover**: the last session left the tree dirty, or was cut off. Find what is uncommitted
(`git status`, `git diff`) and who wrote it (`~/.orunmila/events.jsonl`, parsed by `session_id`,
`type`, `path`, `ts`). Finish it as its slice if its evidence can be shown; otherwise queue it (kind
`recover`). Never discard it: no `checkout --`, no `reset --hard`, no stash.

**evidence-fix**: `leopard-check` could not show a slice that was committed. Find what is missing from
its report (in the assignment). Fix it as a slice of its own, never by amending.

## Hard stops: queue them, never wait, never go around them

These are Leopard rule 5's hard stops. The guard refuses most of them before they run. When you meet
one, queue it and stop the slice:

`node scripts/turbo/plan.js queue '{"slice":"<id>","kind":"<kind>","title":"<short>","ask":"<the question>","session":"{{SESSION}}"}'`

Write the ask so O can answer in one line in `inbox.md`: what is needed, the options, your
recommendation, and what is held until then. Never try a refused action another way. Any other fork is a
Leopard decision: log it in `review/leopard-decisions.md` on `output-1` by plumbing (the next LD number
comes after the last one in the log) before the commit that rests on it.

Write commit messages to `{{HOME}}/msg-{{SESSION}}.txt` and commit with `git commit -F`. The
trailers are one trailer block, the message's last paragraph, with `Co-Authored-By` inside it and no
blank line between: git reads only the last paragraph as trailers, so a blank line before
`Co-Authored-By` hides `Slice:` from `leopard-check` (it happened in slices T1-T4). Like this:

```text
feat(x): what the slice does (slice T9)

Why, in a few lines.

Slice: T9
Test: node test/x.js
Decision: LD200
Turbo-Run: {{RUN}}
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## The end

Your final answer is the structured result, and only that:

- `outcome`: `done` (slice committed), `blocked` (queued, slice held), `planned` (stalk added slices),
  `nothing` (nothing left to add), `recovered`, or `failed`;
- `slice`: the slice id, or null;
- `commits`: the shas you committed; `queued`: the Q ids you opened; `decisions`: the LD ids you logged;
- `summary`: at most 80 words, evidence only: command and exit, file, test name.

The driver checks it: it runs `leopard-check --gate` on your session, reads `git status`, and confirms
each sha exists.
