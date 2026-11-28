# skills/

Four packaged skills, one per folder, each with its own `SKILL.md`. They are
plain text instructions for an agent — no code, no install scripts, nothing that
needs a security review beyond reading the file. All four are free, under the
Apache License 2.0 like the rest of this repository.

| Skill | What it does |
|---|---|
| [`orunmila`](orunmila/SKILL.md) | Installs orunmila, audits a session, opens the Stain Map. Start here. |
| [`closeout-gate-setup`](closeout-gate-setup/SKILL.md) | Installs the Closeout Gate, walks the six laws, sets block vs advise for the user's risk tolerance. |
| [`agent-review-workflow`](agent-review-workflow/SKILL.md) | Turns a finished session into a reviewer checklist, with the fix-it prompt. |
| [`custom-laws`](custom-laws/SKILL.md) | Writes laws for a team's own codebase rules. |

Each skill names the others where they help. All four use `npx orunmila`, so
they work without a clone.

**Testing a skill:** copy its folder into `~/.claude/skills/`, start a new
Claude Code session, and use one of its trigger phrases. Confirm it loads and
runs end to end before listing it anywhere.
