# The claims block

*Format version 1 (MR1, 2026-11-25). Brief v4 line 443: claims are captured deterministically, "from a structured
claims block the agent is asked to produce at closeout, or from fixed patterns". This is that block. Read by
`src/reconcile/claims-block.js`; plain code, no model.*

An agent may end a turn's final message with one fenced block whose info string is `orunmila-claims`:

````markdown
```orunmila-claims
changed: src/auth.js, test/auth.test.js
proved: npm test
proved: npm run lint
not done: the Windows run (no Windows machine here)
```
````

| Line | Says | Checked against |
|---|---|---|
| `changed: <path>, <path>` | the files the agent changed this turn; one or more lines | the record's changes in the turn (a later slice) |
| `proved: <command>` | one command that shows the work passes; one per line | a run in the turn that passed and whose exit status is that command's: the command is one of the `&&` steps of the run's last segment (`cd web && npm test` and `cd web; npm test` prove `npm test`; `npm test; echo done` does not, its status is echo's), with no unguarded pipe and no `\|\|` there |
| `not done: <text>` | something asked for and not done | nothing: it is the agent's own disclosure, shown with its report |

Rules:

- **The last block in the message counts.** A block with no closing fence is not a block.
- **Any other line is an error**, named with its line number; the block's other lines are still read.
- **The block adds; it replaces nothing.** Prose claims ("all tests pass") are still read by the fixed patterns, so
  an agent cannot hide a prose claim by writing a block that leaves it out.
- **Text inside the block is not prose.** The fixed patterns skip fenced blocks, so `proved: npm test` is read once, as
  a declared command, not again as a sentence.
- With `ORUNMILA_CLAIMS_BLOCK=1` the law gate checks each `proved:` line under the `no-green-without-command` law: a
  declared command with no passing run in the turn is that law's finding, with the same severity.
