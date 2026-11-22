# TURBO

An unattended Leopard run for the Orunmila build (O, 2026-11-22; decisions LD108-LD116 in
`review/leopard-decisions.md` on `output-1`). It keeps working for the hours you give it. It does
everything that does not need you, queues what does, and works around it.

## Start a run

TURBO runs in its own clone, never in the worktree: the worktree shares the live copy's `.git`, and no
sandbox rule kept that safe (LD116). From a terminal (not inside a Claude session, so the run
outlives it):

```sh
cd ~/tools/orunmila-dev
node scripts/turbo/turbo.js clone            # once: ~/tools/orunmila-turbo, on this branch, no remote
cd ~/tools/orunmila-turbo
node scripts/turbo/turbo.js init
nohup node scripts/turbo/turbo.js run --hours 6 > .turbo/driver.out 2>&1 &
```

The work comes back only when you fetch it: the run's `summary.md` ends with the two commands
(`git fetch` from the clone into `refs/turbo/*` of the worktree, then `git log` to read it), which move
no branch. Merging it into `n10-redo` is then your own step. To start the next run from new work,
delete the clone and make it again.

Options: `--hours N` (default 6), `--session-minutes N` (the most one session may take, default 75),
`--model opus`, `--effort high`, `--budget-usd N` (per session), `--poll-minutes N` (how often a
waiting driver looks at your inbox, default 5), `--no-final-gates`. On macOS the run keeps the
machine awake (`caffeinate -i`) until it ends.

The run starts only on a clean tree (no uncommitted tracked changes) and with no other driver
running.

## While it runs: jump in at any time

Everything is in `.turbo/` (gitignored):

| File | What it is |
|---|---|
| `approvals.md` | What needs you. Each item has an id (`Q3`), what is held, the options and a recommendation. |
| `inbox.md` | Where you write. Answer as `Q3: yes`, or give any instruction. The next session reads it. |
| `PAUSE` | Create it to hold the run after the current session (so you can work in the tree yourself). Delete it to go on. |
| `STOP` | Create it to end the run after the current session. |
| `plan.json` | The test list: slices, dependencies, status. |
| `runs/<id>/` | `log.jsonl` (every step), `summary.md` (at the end), each session's prompt and output. |

`node scripts/turbo/turbo.js status` prints the plan counts, the open items and whether a driver
is running.

## What one turn of the loop does

1. **Choose**: recover a dirty or cut-off tree first; else the plan's next slice that no open item
   holds (a slice that depends on held work waits with it); else, if the plan is spent, a **stalk**
   session that adds the next slices from the brief and the ledger; else **wait** for your inbox.
2. **Run** one fresh headless session (`claude -p`) for that one slice, with its id pinned, so
   Orunmila's records, `leopard-check` and the witness join can each be pinned to it.
3. **Check** it: each commit it names exists; `leopard-check --gate` shows its red, green and gates,
   or an evidence-fix slice goes to the head of the plan; `git status` matches the run's start, or the
   next session is a recovery.

Two failed sessions in a row, or three with no progress, also mean wait. A waiting run does not exit:
it resumes when your inbox changes. It ends at its hours, at `STOP`, or if the worktree's branch
changes. At the end the driver runs the four gates itself and writes `summary.md`.

At a phase end the close-out slice runs the full `CLAUDE.md` close-out and queues the phase report
(non-blocking). Later-phase slices then go on as **provisional**: behind an off-by-default flag, or
tests and docs only, each commit carrying `Turbo-Provisional: Q<n>`, so your answer to the report
keeps or repeals them as a set (LD111).

## What it will not do

The base layer is the OS sandbox (LD113, after a cold verify got 14 of 20 bypasses past the guard
and switched the git hooks off with `-c core.hooksPath=/dev/null`). Every Bash command and all its
children (`node -e` and scripts included) run under macOS Seatbelt with no network at all. Writes
go only to the clone (with its own `.git`), TURBO_HOME and scratch inside it, and the temp dir; the
clone's git `hooks` and `config`, `scripts/turbo/`, `.claude/` and every session scratchpad under
`/private/tmp/claude-<uid>/` are denied. Nothing of the live copy or the worktree is writable, and the
driver refuses to run in a linked worktree. (LD113-LD115 tried to keep the shared `.git` safe by deny
lists; three cold verifies each found a new gap, the last one `commondir`, branches kept in
`packed-refs`, and deletable pack files, so the method changed.) There is no retry outside it
(`allowUnsandboxedCommands: false`), and a session will not start without it (`failIfUnavailable`).
The file tools (Edit, Write) are not sandboxed; the guard checks them by real path.

The layers below are second checks:

1. `--permission-mode dontAsk` with a closed allowlist (`session.js`): anything else is refused.
2. The guard (`guard.js`, a PreToolUse hook that fails closed) refuses: push, merge or pull, a
   branch switch or `checkout`, publish, `npm install`, history rewrites, stash, clean, recursive `rm`
   outside scratch, `kill`, `sudo`, network tools, grep in any form, secret files, anything inside the
   live copy `~/tools/orunmila`, the hook settings and git config, and TURBO's own code. It parses
   each shell command, including `$(...)`, backticks, heredocs fed to a shell, `bash -c`, `eval` and
   wrappers such as `env`, `nohup`, `timeout` and `xargs`.
3. git hooks set through the environment (`githooks/`): every push and any update to `main` is
   refused, however git is run.
4. `NPM_CONFIG_DRY_RUN=true`: `npm publish` only reports.

No MCP servers are loaded. A refused action becomes a queue item.

**Known limits:** the guard and the git hooks can be got round (variables, aliases, `send-pack`,
`-c core.hooksPath=`); the sandbox is what holds. Inside the clone a session can write anything but
the paths above, including its branches and its object store: damage there stays in the clone, and
reaches the worktree only through your fetch. A refused checkout can rewrite the clone's files before
it fails on `HEAD`; the driver reads `HEAD`'s reflog after each session, and any entry that is not a
commit makes the next session a recovery. Orunmila is Glove and Sentinel: the driver starts a
Sentinel on the clone for the run (`orunmila watch-fs --root <clone>`, or `TURBO_SENTINEL_BIN`) unless
one already watches it, stops the one it started at the end, and `summary.md` says which.

## Files

`turbo.js` (the driver), `session.js` (one session's argv, env, settings, prompt, result),
`prompt.md` (what each session is told), `plan.js` (the plan and the queue, with a CLI), `guard.js`,
`githooks/`. Tests: `test/turbo.js`.
