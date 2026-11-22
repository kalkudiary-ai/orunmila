# TURBO

> **ON HOLD (LD118, 2026-11-22). Do not start a run.** The fifth cold verify got a session's code
> run outside the sandbox: a session plants `.git/commondir` in the clone, and git that runs
> *unsandboxed* there (the driver's `git status`, the referee's `git diff-tree`, and Claude Code's own
> start-up `git status` for the next session) then runs the planted hooks, fsmonitor and filters as
> O. A symlink swapped between the guard's check and the Write tool's write also got 3 of 12 writes
> outside the clone. `turbo.js run` refuses to start (`HOLD` in `turbo.js`). O's choice (2026-11-22):
> make an escape show up and stop the run, not try to make it impossible. Slices T18-T21 (LD126-LD131)
> built that ("Escape checks" below): both routes are now caught after the session and halt the run
> before any git. Only O lifts the hold, after reading the planted-escape results. A separate macOS
> user (administrator rights) would still be the only fix that also prevents. Everything below
> describes the harness as built.

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
| `driver/<id>/` | The driver's own records, which sessions cannot write: `log.jsonl` (every step), `summary.md` (at the end), each session's prompt and output. |
| `scratch/<id>/` | The sessions' scratch folder for the run. |

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
changes. At the end it writes `summary.md`. It runs no gates of its own: that would run the clone's
code outside the sandbox (LD117); the referee checks the gate runs the sessions made, each run alone
with no redirect (dontAsk refuses every redirect).

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
The file tools (Edit, Write) are not sandboxed; the guard checks them by real path and allows them
only in the clone, TURBO_HOME and scratch.

The driver runs outside the sandbox, so it trusts nothing a session can write (LD117, after a cold
verify made it write into the worktree twice): the referee runs `leopard-check` code loaded before
the first session, never the clone's file; its records sit in `.turbo/driver/`, which sessions
cannot write; it refuses a symlink there or at `plan.json`, and writes temp files exclusively; its
`git status` turns fsmonitor and submodules off; it runs only in a clone made by `turbo.js clone`
(`turbo.source` set). `inbox.md`, `STOP` and `PAUSE` are yours: sessions cannot write them.

The layers below are second checks:

1. `--permission-mode dontAsk` with a closed allowlist (`session.js`): anything else is refused.
2. The guard (`guard.js`, a PreToolUse hook that fails closed) refuses: push, merge or pull, a
   branch switch or `checkout`, publish, `npm install`, history rewrites, stash, clean, recursive `rm`
   outside scratch, `kill`, `sudo`, network tools, grep in any form, secret files, anything inside the
   live copy `~/tools/orunmila`, the hook settings and git config, and TURBO's own code. It parses
   each shell command, including `$(...)`, backticks, heredocs fed to a shell, `bash -c`, `eval` and
   wrappers such as `env`, `nohup`, `timeout` and `xargs`.
3. `NPM_CONFIG_DRY_RUN=true`: `npm publish` only reports.

(A git-hook layer set through the environment was removed by LD117: in the clone it guarded nothing
the sandbox does not, and it broke every test that commits to `main` in a temp repo.)

No MCP servers are loaded. A refused action becomes a queue item.

**Known limits:** the guard can be got round (variables, aliases, `send-pack`); the sandbox is what
holds. For the test suite to run in a session, the sandbox opens FSEvents (read-only file events) and
local binding: a session can listen on, and reach, ports on 127.0.0.1, so a service listening only
there is reachable from a session (T14). Inside the clone a session can write anything but
the paths above, including its branches and its object store: damage there stays in the clone, and
reaches the worktree only through your fetch. A refused checkout can rewrite the clone's files before
it fails on `HEAD`; the driver reads `HEAD`'s reflog after each session, and any entry that is not a
commit makes the next session a recovery; a session can write that reflog (a commit must append to
it), so the check is advisory. Orunmila is Glove and Sentinel: the driver writes the clone's
`.orunmila/ignore` (`.turbo/` and every build folder back in view, T18), then starts its own Sentinel
on the clone (`orunmila watch-fs --root <clone>`, or `TURBO_SENTINEL_BIN`), even when another one
watches it, and starts no session until that Sentinel's first walk is done. It stops it at the end,
and `summary.md` says so.

## Escape checks: an escape shows up and stops the run

The sandbox and the guard try to make an escape impossible; these checks make one that got past
them show up (O, 2026-11-22; LD126-LD131 in `review/leopard-decisions.md` on `output-1`). They run
after every session, before the driver runs any git of its own and before the next session starts.
Any finding **halts** the run (LD127): no more git, no next session, a blocking `discrepancy` item in
`approvals.md`, the findings at the top of `summary.md`, and `.turbo/driver/HALT.json`. A later `run`
refuses while HALT.json exists. Read it, run no git in that clone, and make a new clone.

- **The clone's `.git`** (T20, LD129), checked first, by reading files, never by git (a planted
  `.git` runs its code at the next unsandboxed git, Claude Code's start-up `git status` for the next
  session among them; cold verify 5's route, reproduced in `test/turbo.js`): `.git` is a directory,
  not a gitfile or link; its top-level entries come from a fixed list (no `commondir`, no `gitdir`);
  no link in it outside `objects/`; no object alternates; the config holds only the keys a TURBO clone
  is made with (no include, hooksPath, fsmonitor or filter); `hooks/` holds only `*.sample`; and config,
  hooks and info are unchanged since the run started. The same check runs before the driver's first
  git at start, so a run never starts over a planted `.git`. The driver's own git also runs with the
  git dir, common dir and work tree pinned to the clone, no system config, and hooks and fsmonitor off.
- **Both records** (T21, LD131): every write the Glove recorded for the session (not failed, with a
  changed line) needs a Sentinel row on the clone for the same path within -1 s/+3 s. A write the
  Glove recorded but the clone's disk did not show may have landed elsewhere: the symlink race on
  the Write tool lands anywhere you can write, so this is the check that sees it wherever it went.
  A Glove write outside the clone and TURBO_HOME is a finding too. It is on whenever the clone has
  its Sentinel.
- **Links** (T20, LD130): any link in the clone whose target is outside it is a finding, except
  `node_modules`, `CLAUDE.md` and `docs/AGENT_OPERATING_RULES.md` at the targets the source has.
- **Outside the clone** (T19, LD128): every Sentinel row under the live copy and the source worktree
  in the session's window, and a tripwire of named files that run code as you, read by sha256: the
  shell start-up files, `~/.gitconfig`, `~/.config/git`, `~/.ssh/config` and `authorized_keys`,
  `~/Library/LaunchAgents`, `~/.claude/` settings, CLAUDE.md, hooks, agents, commands and skills,
  every `~/.claude/projects/*/memory`, the `mcpServers` of `~/.claude.json`, and the live copy's
  `.git` config, hooks, info, commondir and worktree links. A change that another session's record
  explains passes (a peer's write on the same path, or a command of its own within 3 s or within its
  span); any other halts. A Sentinel already watching the live copy or the worktree is used; with
  `ORUNMILA_HOME` set the driver starts its own, since a foreign one logs elsewhere.

`summary.md` opens with the run's four declarations, the close-out's absolute claims, each
**confirmed**, **refuted** (its check found something) or **unproven** (its check could not run), with
the counts behind it: no file outside the clone was written; every write is in both records; the
clone's `.git` held; no link points outside the clone.

Limits: these catch an escape after the fact, within one session, and stop the run; they do not
prevent it. Git run outside the sandbox *during* a session is not covered by the `.git` check:
Orunmila's hooks and the guard run none (their code read for it), but whether Claude Code itself runs
git mid-session is not checked. A session that broke out on purpose could also tamper with Orunmila's log, which only a
separate macOS user would stop. A file off the tripwire list is caught only by the both-records
check. `~/.claude/plugins` is not on it, because Claude Code rewrites its caches and marketplace clone
itself. Your own edits in the worktree or to these files during a run halt it.

## Files

`turbo.js` (the driver), `session.js` (one session's argv, env, settings, prompt, result),
`prompt.md` (what each session is told), `plan.js` (the plan and the queue, with a CLI), `guard.js`,
`watch.js` (the escape checks). Tests: `test/turbo.js`.
