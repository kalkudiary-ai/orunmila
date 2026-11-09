---
name: closeout-gate-setup
description: Use when the user wants an AI coding agent STOPPED from finishing on a claim it cannot back up - "stop my agent lying", "make the agent check its own work", "don't let it say it's done when it isn't", "block unverified claims", "set up the closeout gate", "enforce evidence before the agent finishes", "my agent says tests pass when it never ran them". Installs orunmila's Closeout Gate, walks the six laws, and tunes block vs advise to the user's risk tolerance.
license: Apache-2.0
---

# Stop an agent finishing on a claim it can't back up

Most verification tooling tells you afterwards. The Closeout Gate runs on the
Stop hook, **before a turn is allowed to end**, and can refuse it — the agent
must fix what was flagged and respond again.

This is the second of orunmila's two lenses. The first, the Stain Map, records
and reports and never refuses (that's the free `orunmila` skill). The gate needs
the Stain Map underneath it, because it judges the events the Stain Map records.

**Claude Code only.** No other agent currently exposes a hook that can refuse a
turn. Say this up front — do not install and let them discover it.

## Steps

1. Check Node >= 18 and that they are on Claude Code.
2. Install both lenses:
   ```bash
   npx orunmila install --agent claude-code --with-gate
   ```
   If the Stain Map is already installed, add the gate alone — this leaves the
   existing capture hooks untouched:
   ```bash
   npx orunmila install --gate-only
   ```
3. Install **reads every law out loud**: which can stop a turn, which only
   advise, and the file to edit. Walk the user through that output. Do not skip
   it. A rule that can interrupt someone's work must never be something they
   discover by being interrupted.
4. Before they trust it, measure it on their own history:
   ```bash
   npx orunmila laws --check --session <id>
   ```
   Read-only replay of the law set over a captured session. This is the step that
   earns trust — they see what it *would* have blocked, on their own work, with
   no risk.
5. **Tell them to start a new session.** Hooks load at session start.
6. Confirm what is live:
   ```bash
   npx orunmila lenses
   ```

## The six laws

| Law | What it catches | Default |
|---|---|---|
| `no-green-without-command` | a verification claim with no passing command in the turn (see the limits below) | **blocks** |
| `no-grep-as-basis` | a claim about a named file resting only on a pattern match | **blocks** |
| `no-claim-without-receipt` | an assertion with nothing opened or run behind it | advises |
| `no-absolute-without-enumeration` | "all" / "none" with no enumeration | advises |
| `no-uncertainty-as-fact` | uncertainty smoothed over instead of flagged | advises |
| `no-assumption-language` | building on an unnamed assumption | advises |

**Tell the user about these limits before they rely on it.**
`no-green-without-command` reads phrasing, not meaning. It catches *"Tests
pass."*, *"All tests pass."*, *"I ran the tests and they pass."* and *"It
works."*, but it can also block an honest negative such as *"I tested none of
it."* or *"Nothing was tested."*. It accepts any command in the turn that did
not fail, even one that tested nothing. Setting expectations wrongly here is
worse than the limits themselves: someone who believes a turn the gate let
through was tested will stop checking for it.

## Tuning block vs advise

The defaults are set on measurement, not taste, and it is worth explaining why
before changing them. On real sessions only `no-green-without-command` proved
precise enough to be worth stopping a turn over. The current figures are in the
README, under "Why only two block".

The asymmetry drives everything: a false advisory costs the agent a sentence of
attention, a false block costs the whole session — and an agent that learns the
gate is usually wrong learns to route around it.
`no-claim-without-receipt` alone is the large majority of all findings, so
blocking on it trains people to switch the gate off, and a gate that is off
enforces nothing.

Match the setting to their risk tolerance:

- **Cautious / exploratory work, or a first week with the gate** — leave the
  defaults. Two blocking laws is already the strict end.
- **Money, auth, migrations, anything where a false "done" is expensive** —
  consider promoting `no-claim-without-receipt` to block, but only after
  `laws --check` shows them its real firing rate on their own sessions. Expect
  noise.
- **A team that finds any block disruptive** — set everything to advise. The
  findings still arrive as context the agent can act on, just without the wall.

Retune by id, without restating the law, in their own laws file:

```json
{ "id": "no-claim-without-receipt", "severity": "block" }
{ "id": "no-grep-as-basis", "enabled": false }
```

```bash
npx orunmila laws --init    # scaffold that file
npx orunmila laws           # what's in force, and which layer each law came from
```

## What to tell the user

- **The kill switch is `ORUNMILA_LAWS=off`** for one session. Make sure they know
  it before they need it.
- **Blocks are budgeted** — two per turn by default. Once spent, findings degrade
  to advice and the exhaustion is recorded, so the agent cannot be pinned in a
  blocked-respond-blocked loop. A gate that gives up silently would look like a
  pass, so it says so instead.
- **It fails open, always.** Any internal error exits 0 silently. A broken law
  engine stops enforcing; it never stops the agent or costs them work.
- **Law findings are heuristic — they read the agent's prose, not the facts.**
  They sit beside the evidence, never inside it. A finding says "recheck this",
  not "you lied".
- **Pipes hide exit codes.** `npm test | tail` exits 0 with the suite on fire,
  so the gate does not count an unguarded pipe as a passing run. Tell them to
  use `set -o pipefail` when they pipe a test run, and not to end a command
  with `; echo $?`: the whole line then exits 0, and the gate counts that as a
  pass.

## If the user wants rules specific to their codebase

The six shipped laws are general. Their own rules — deployment targets, forbidden
vendors, naming conventions, "never say X to a customer" — layer on top rather
than replacing them. That is the `custom-laws` skill.

## See also

- `orunmila` (free) — the Stain Map: record and report, no refusals.
- `agent-review-workflow` — turn a finished session into a reviewer checklist.
- `custom-laws` — write laws for their own codebase rules.
