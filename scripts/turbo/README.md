# TURBO

An unattended Leopard run for the Orunmila build (O, 2026-11-22; decisions LD108-LD112 in
`review/leopard-decisions.md` on `output-1`). It keeps working for the hours you give it. It does
everything that does not need you, queues what does, and works around it.

## Start a run

From a terminal, in the worktree (not inside a Claude session, so the run outlives it):

```sh
cd ~/tools/orunmila-dev
node scripts/turbo/turbo.js init
nohup node scripts/turbo/turbo.js run --hours 6 > .turbo/driver.out 2>&1 &
```

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
children (`node -e` and scripts included) run under macOS Seatbelt with no network at all and writes
only to the worktree, TURBO_HOME and scratch, the temp dir, and the git common dir a commit needs,
inside which `refs/heads/main`, `packed-refs`, the live copy's `HEAD`, `config` and `hooks`, and this
worktree's `HEAD` are denied (checked live: probe sessions `4d03030b` and `351e371a`, EPERM on each,
a commit going through, a branch switch by rename refused). There is no retry outside it
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
`-c core.hooksPath=`); the sandbox is what holds. Inside the worktree a session can still write any
file outside `scripts/turbo/` and `.claude/`, and move any branch but `main` (all reversible by git).

## Files

`turbo.js` (the driver), `session.js` (one session's argv, env, settings, prompt, result),
`prompt.md` (what each session is told), `plan.js` (the plan and the queue, with a CLI), `guard.js`,
`githooks/`. Tests: `test/turbo.js`.
