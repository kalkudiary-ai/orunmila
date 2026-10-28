---
name: custom-laws
description: Use when a team wants an AI coding agent held to THEIR rules, not just generic ones - "enforce our codebase conventions on the agent", "write custom laws", "make the agent follow our deployment rules", "stop the agent suggesting the wrong vendor", "encode our review standards", "our agent keeps making the same mistake", "team-specific agent guardrails". Writes an orunmila laws pack for a team's own rules and wires it into the Closeout Gate.
license: MIT
---

# Hold an agent to your team's own rules

Orunmila ships six general laws about evidence — no claim without a receipt, no
"it works" without a passing command. Useful, and not the rules that actually
bite a specific team.

The rules that bite are local: *we deploy to Railway, never Vercel, and the
agent suggests Vercel every time.* *This vendor is reserved for two specific
call sites.* *Never quote the internal unit price to a customer.* *That column
was dropped; stop reintroducing it.* Those get written on a wiki, repeated in
review, and forgotten by the next session.

A laws pack makes them checkable at run time, in the agent's own loop.

Requires the Closeout Gate — see `closeout-gate-setup`.

## Steps

1. **Harvest the real rules before writing any JSON.** This is the whole job and
   it is a conversation, not a config task. Ask:
   - What has the agent got wrong more than once?
   - What does every code review here keep saying?
   - What is written in a CONTRIBUTING / CLAUDE.md / team doc that gets ignored?
   - What would be expensive if it reached production — a wrong vendor, a wrong
     domain, a wrong deployment target, a customer-facing number?
   - What phrasing is banned, and what should replace it?

   Rules that have already been broken at least once are worth ten rules someone
   thinks might matter. Ask for the incident, not the policy.

2. Scaffold their file:
   ```bash
   npx orunmila laws --init
   ```
   Their layer sits **on top of** the shipped canon rather than replacing it, so
   the evidence laws keep working. `npx orunmila laws` always shows what is in
   force and which layer each law came from.

3. Write each rule as a law. Start every one at `warn`.

4. **Measure before promoting anything to `block`:**
   ```bash
   npx orunmila laws --check --session <id>
   ```
   Read-only replay over their real captured sessions. This step is not optional
   and it is where the value is: a law that fires on 30% of turns is noise
   whatever its author intended, and a law that never fires on real history is
   not yet earning its place.

5. Promote only the laws that fired **precisely** — high hit rate on genuine
   problems, near-zero on ordinary work:
   ```json
   { "id": "no-vercel-references", "severity": "block" }
   ```

6. Re-measure after every change. Commit the laws file to their repo so the rules
   travel with the codebase instead of living on one machine.

## How to write a good law

- **One rule per law.** A law that checks three things cannot be tuned, measured,
  or trusted.
- **Target a phrase, not a concept.** The engine reads prose. "Don't be careless"
  is unenforceable; "never says Vercel" is.
- **Write the remedy, not just the complaint.** The remedy text is what the agent
  actually reads when it fires. "Read the target in full, then answer again from
  what the file actually says" changes behaviour; "bad claim" does not.
- **Prefer catching the phrasing over catching the intent.** Intent is not
  observable. Phrasing is.
- **Expect to delete some.** A law that measures badly should come out, not get
  reworded indefinitely.

## Setting severity honestly

Explain the asymmetry, because it decides everything: a false advisory costs the
agent a sentence of attention; a false block costs the whole session. An agent
that learns the gate is usually wrong learns to route around it, and a team that
finds the gate obstructive switches it off — at which point it enforces nothing
at all.

This is measured in the shipped canon, and the same logic applies to theirs:
across 194 sessions the evidence laws fire on 18% of claimed turns, but only one
proved precise enough to block on — 8 firings in 1,174 turns, every one genuine.
Four laws stayed advisory **because the measurement said so**, not out of
caution.

Default to `warn`. Earn `block`.

## What to tell the team

- **Findings are heuristic. They read prose, not facts.** A law finding says
  "recheck this", not "you lied". It must sit beside the evidence, never inside
  it, and never carry the same authority.
- **It fails open.** Any internal error exits 0 silently. A broken law never
  blocks anyone's work.
- **`ORUNMILA_LAWS=off`** disables the gate for one session. Tell them before
  they need it.
- **Blocks are budgeted** — two per turn, then findings degrade to advice and the
  exhaustion is recorded.
- **Laws belong in version control.** A rule that lives on one laptop is back to
  being tribal knowledge.
- **Re-measure after a model change.** A law tuned against one model's phrasing
  can go quiet or noisy against another, and nothing will announce it.

## Where this goes next

A laws pack is usually the start of a bigger piece of work rather than the end of
one. The honest version of the offer: study how their agents actually fail, using
their own captured sessions as the evidence; write the laws that catch those
specific failures; measure each one against their history before it blocks
anything; and wire the result into their workflow. Scope it as a fixed-length
pilot on one repo, with the measured firing rates as the deliverable — not as an
open-ended retainer, and not priced hourly.

## See also

- `closeout-gate-setup` — install the gate these laws run on.
- `orunmila` (free) — capture the sessions you need in order to measure.
