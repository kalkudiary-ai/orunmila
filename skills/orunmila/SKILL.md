---
name: orunmila
description: Use when the user wants to know what an AI coding agent actually did versus what it claimed - "audit this session", "did you really do that", "show me what changed vs what you said", "stain map", "dye trace my agent", "verify my agent's work", "catch phantom completions", "find undisclosed changes", "did it silently drop anything". Installs orunmila, captures the session, and opens a claim-vs-reality report.
license: MIT
---

# Audit what an agent actually did

Orunmila captures every file write (with a real diff), every command (with its
exit code), and every tool call — then reconciles the agent's own account of
what it did against that evidence. Free, MIT, runs entirely locally, no API key.

## What the user gets

A report sorting every claim into one of these, each backed by evidence:

| Outcome | Meaning |
|---|---|
| `verified` | claimed, and the diff or command backs it up |
| `partial` | touched, but the diff is scaffolding only — stub, no real logic |
| `phantom` | claimed, zero matching tool call anywhere in the turn |
| `phantom_verification` | claimed "tested/works/passes" with no passing command behind it |
| `unverifiable` | too vague to check ("added some basic validation") |
| `undisclosed` | a file changed that no claim and no part of the ask covers |
| `silently_dropped` | part of the original ask has no evidence and was never mentioned again |
| `untracked_write` | a real disk change no tool call accounts for |

It reconciles against **two** sources: the agent's claim (catches confabulation)
and the original prompt, independently (catches what the agent just stopped
mentioning — the more common and harder-to-spot failure).

## Steps

1. Check Node: `node --version` — needs >= 18.
2. Install the Stain Map into the current project:
   ```bash
   npx orunmila install
   ```
   Add `--global` for every project instead of just this one. For a non-Claude
   agent, add `--agent <id>` — run `npx orunmila agents` to list them.
3. **Tell the user to start a new session.** Hooks load at session start, so a
   running session will not pick this up. Skipping this is the single most
   common reason someone reports "it isn't working".
4. Have them work normally for a few turns.
5. Open the report:
   ```bash
   npx orunmila trail
   ```
   Writes a self-contained HTML file: the complete trail of everything touched,
   the read→write lineage, and the claim-vs-reality stains, in one page. The
   Report tab carries a copy-paste prompt that sends the agent back to fix every
   flagged item.
6. Optional but worth it — run the independent disk observer alongside, which
   catches writes that never went through a tool call:
   ```bash
   npx orunmila watch
   ```
   It is worth a measured +5.3 points of detection accuracy.

## Want to show them before installing?

```bash
npx orunmila demo
```
Renders a sample report from a scripted session — one of everything, no setup,
nothing touched in their real log.

## What to tell the user

- **It reports evidence, never intent.** A red stain means the receipt is
  missing, not that the agent lied. A green stain means the receipt checks out,
  not that the code is correct. It narrows where to look; it does not replace
  looking.
- **Nothing leaves their machine, with one exception to name out loud.** No
  telemetry, no account; the event log is a local append-only
  `~/.orunmila/events.jsonl`, and no session content is ever transmitted. The
  one outbound request in the whole product is the HTML report's **3D Graph**
  tab, which fetches a rendering library from a CDN when a viewer opens that
  tab — so opening it reveals their IP to unpkg/jsdelivr. Every other tab is
  self-contained. Tell a privacy-sensitive user this before they open a report
  in front of someone.
- **Detection accuracy is 100% on a labelled set of 17 turns / 38 assertions**
  (`npm run accuracy` in a clone reproduces it). Say "100% on our labelled set",
  not "100% accurate" — the set is small, and saying so is the point.
- **Sharing a report is safe by default.** The rendered copy collapses their home
  directory to `~` so their OS username doesn't ride along, and a
  `.orunmila/redact` file hides any path they list.
- If they want the agent **stopped** rather than reported on, that is the second
  lens — the Closeout Gate. See the `closeout-gate-setup` skill, or
  `npx orunmila install --with-gate`.

## Limits — say these if asked

- `exit 0` means a command ran and passed, not that it tested the right thing.
- Lineage (read→write) is a turn-scoped heuristic, stamped `inferred`, not proven
  data flow.
- Claim extraction is regex and keyword heuristics, not NLP.
- The disk observer's writes carry no session id, so with two concurrent sessions
  on one tree each adopts the other's writes. Read a touch list as "what changed
  on this machine while I worked", never as authorship.
- Every known issue, open and closed, with status: `review/ISSUES.md` in the repo.
