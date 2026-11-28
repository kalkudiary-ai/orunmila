# Orunmila for new users

This page assumes you have never heard of Orunmila. It takes about ten minutes
to read and follow. Everything else is in [the guide](GUIDE.md).

## What it is

AI coding agents tell you what they did: "I fixed the bug and the tests pass."
Sometimes that is true. Sometimes the test was never run, the file named was
never touched, or a change was made that the agent never mentioned. Orunmila
checks the agent's account against two witnesses. The **Glove** is the agent's
own hooks: every file it read or changed, every command it ran and how it
ended, every tool it called. The **Sentinel** watches your project folder on
disk, whoever changes it. Fixed rules, never an AI model, compare what the agent
said with what the two witnesses recorded, and everything runs on your machine.

## Install, and your first session

You need Node.js 18 or later and an agent (Claude Code is fully supported, and
Cursor for the Stain Map; see the support table below). In the project you want
to watch (for Cursor: `orunmila install --agent cursor` in place of the second line):

```bash
npm install -g orunmila
orunmila install --with-gate
```

Then start a **new** session of your agent in that folder (hooks are read when a
session starts) and give it a small task. After each turn Orunmila prints a short
report under the agent's answer. For the whole session as one page:

```bash
orunmila trail
```

For the second witness, run `orunmila watch` in another terminal while you work.

For a record anyone can check, the **intake** (optional): `orunmila install
--intake`, then `orunmila intake start`. Each session then gets its own
hash-chained log in `~/.orunmila/sessions/<id>/`, and

```bash
orunmila verify ~/.orunmila/sessions/<id>
```

answers "Record intact" or names the first line that was changed. No separate
user account is needed: the intake watches its own logs and records any change it
did not make.

For a verdict on each whole session, like the report below, turn the judge on
too: `orunmila install --with-judge`, then restart the intake (`orunmila intake
stop`, then `orunmila intake start`). From then on each session the intake
records is judged at its end, and `orunmila report --verdicts --session <id>`
shows it.

## Reading a session report

This is a real session report: Orunmila's own build work from October 2026,
before most of today's code existed, run through `orunmila report --verdicts`.
Two long lines are cut where shown.

```
Incomplete record
What changed on disk: 15 changes. Both witnesses recorded 13: 13 by an agent edit tool. The Sentinel alone recorded 2: no tool call or command the agent made explains them.
In all: 1 reason the record is incomplete, 5 things to look at.

- Incomplete: No law-gate check was recorded, though the agent's hooks were: the law gate was silent, so the record is incomplete. (R13)
- Look at this: .ds_store changed and no agent tool call or command explains it (it may have been you, a formatter or another program). The Glove recorded nothing; the Sentinel recorded it modified. (odu_0047, R6)
- Look at this: docs/agent_operating_rules.md changed and no agent tool call or command explains it (it may have been you, a formatter or another program). The Glove recorded nothing; the Sentinel recorded it created. (odu_0062, R6)
- Look at this: The agent claimed it changed /.claude/CLAUDE.md, but no change to it was recorded. The Glove recorded claimed; the Sentinel had nothing to see (not a disk event). (odu_0127, R1)
- Look at this: The agent changed 13 files its turns' claims never mention: docs/agent_operating_rules.md (The Glove recorded modified; the Sentinel recorded it modified); … (13 records, R2)
- Look at this: The agent looked at Orunmila's record of its work 7 times: it ran `ls -la ~/.orunmila/ | head -30; …` … (7 records, R25)

Law gate: 0 turns checked, 0 skipped, 0 blocked; skip rate 0%.
104 Clean events are hidden; the verdict log holds every one.
```

How to read it:

- **The first line is the session's verdict:** Clean, Look at this, Violation,
  or Incomplete. Incomplete means evidence is missing, so the record cannot be
  called clean; here the law gate kept no record.
- **The second line is the witness gap:** each change on disk, and which
  witnesses saw it. "Both" is the normal case. "The Sentinel alone" means the
  disk changed and nothing the agent reported explains it.
- **Each finding names its rule** (R6, R1, ...) and its records (`odu_0047`), so
  you can check it. **Look at this is a request to look, not a verdict.** Looking
  pays: the `.ds_store` change was macOS's Finder, not the agent; the
  `docs/agent_operating_rules.md` creation was the agent's own `cp` command, which
  that old record could not link to the file; and the `CLAUDE.md` "claim" is a
  sentence saying the agent had *not* checked that file. A **Violation** is only
  given where the record shows a rule broken, such as a claim of passing tests
  with no passing run.
- Clean events are hidden by default and kept in the log.

## The words Orunmila uses

| Name | Plain name | What it is |
|---|---|---|
| Orunmila | The witness | The whole tool: it records, it never judges by itself |
| Glove | The agent-side witness | What the agent's own hooks report: prompts, reads, writes, commands, tool calls, its closing claim |
| Sentinel | The disk watcher | Every change in the watched folder, whoever made it |
| Mark (àmì) | A raw observation | One report from one witness about one thing at one moment |
| Ọpọ́n | The reconciler | Gathers the marks and works out what really happened |
| Odù | A reconciled event | One record per real event, naming both witnesses |
| Babaláwo | The judge | Reads the odù records against fixed rules: Clean, Look at this, Violation |
| Law gate | The turn checker | Reads each turn's closing words; two of its six laws can stop a turn |
| Ọ̀pẹ̀lẹ̀ | The harness | Output 2: not part of this release |

## What it defends against, and what it does not

The agent Orunmila watches is assumed to make mistakes, take shortcuts or be
misled (a prompt hidden in a file it read), and to run as you, with a shell.

**It catches:** claims about files and commands with nothing behind them;
changes inside the project the agent never mentions; a claim of passing tests
with no passing run; a change to Orunmila's own records, made visible by the
hash chain and `orunmila verify`; a change to its logs during a session, which
it records and puts back; an overloaded watcher, which leaves a gap the
closeout's rescan fills; and two agents in one folder, reported as "can't tell
who", never guessed.

**It does not see:**

- An agent with administrator rights (`sudo`), which can attack Orunmila itself.
  With `ORUNMILA_COMMAND_FACTS=1` where the intake starts, the session report at
  least names each command that asked for those rights.
- Anything outside the folders it watches: your home folder, other projects,
  system files. Dependency folders such as `node_modules/` are on the ignore
  list (`orunmila status` prints it), so what a package install or a package's
  own scripts change inside them is not watched; the package files you edit
  (`package.json`, the lock file) are.
- Most network activity: only a web fetch or search tool's host and query, never
  what was sent or received, nor traffic from programs the agent runs. With
  `ORUNMILA_COMMAND_FACTS=1`, the hosts a command's own text names (`curl`,
  `git push` and the like) are recorded too: named, not proof of contact.
- Which program wrote a file. The Sentinel sees that bytes changed, not who
  changed them.
- What happens inside a command beyond its file changes, how it ended and the
  output kept. With `ORUNMILA_COMMAND_FACTS=1`, a test run's report also gives
  its runner's own pass, fail and skip counts, as the runner printed them.
- Whether a record is complete. It can prove a record was not altered, not that
  nothing was left out.

**What comes next.** Output 2 (Ọ̀pẹ̀lẹ̀) has the agent declare its intent before
it starts, turns that into a lease scoped to the session, and fences the agent
into a copy of the workspace where it can only write what the lease allows, so
it can no longer reach Orunmila at all. Output 3 aligns the records with the
standards auditors use (the EU AI Act's record-keeping article, ISO/IEC 42001,
OpenTelemetry) and can register a record's fingerprint off the machine. The
record formats and the verifier stay free and open in every output.

## What it stores, where, and for how long

Everything stays on your machine, readable only by your account.

| What | Where | Kept until |
|---|---|---|
| The event log the Glove and the Sentinel write | `~/.orunmila/events.jsonl`, with `reports/`, `output/` and `cache/` beside it | you run `orunmila prune` (keeps the latest 20 sessions) or `orunmila log delete --yes` |
| Each session's record (with the intake) | `~/.orunmila/sessions/<id>/`: the raw log, the odù and verdict logs, files kept beside them | you run `orunmila retention --keep-days N --yes`, which removes whole sessions and records each removal |
| The copy of Orunmila the hooks run | `~/.orunmila/runtime/` | replaced by the next `orunmila install` or update, which keeps the one before as `runtime/previous` |

**Secrets.** Known secret formats (API keys, tokens, private keys, passwords in
URLs) are replaced with `[REDACTED:<kind>]` before anything is written. A `.env`
file is fingerprinted with a key only your install holds and never diffed, so its
values cannot be read back from the record. A value in a format Orunmila does not
know is stored as written: `orunmila leak-check` searches what Orunmila stored for
your `.env` values and names where each one is, never the value.

## Which agents are supported

| Agent | Support |
|---|---|
| Claude Code | Fully supported, tested on real sessions. |
| Cursor | Supported, tested on real sessions in Cursor's command-line agent (test 49): the Stain Map only, no Closeout Gate. The editor's agent reads the same hooks file; not yet run there. |
| Gemini CLI, Codex, Continue, Antigravity, Generic | Experimental: built, tested only with sample data; results may be wrong. |
| Aider | Experimental, sentinel only (Aider has no hooks). |
| Windsurf | No adapter exists. |

An experimental adapter's session says so on the first line of `orunmila report`.
