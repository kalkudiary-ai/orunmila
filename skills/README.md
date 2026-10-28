# skills/

Four packaged skills, one per folder, each with its own `SKILL.md`. They are
plain text instructions for an agent — no code, no install scripts, nothing that
needs a security review beyond reading the file.

| Skill | Price | What it does |
|---|---|---|
| [`orunmila`](orunmila/SKILL.md) | **Free** | Installs orunmila, audits a session, opens the Stain Map. The lead magnet. |
| [`closeout-gate-setup`](closeout-gate-setup/SKILL.md) | Paid | Installs the Closeout Gate, walks the six laws, sets block vs advise for the user's risk tolerance. |
| [`agent-review-workflow`](agent-review-workflow/SKILL.md) | Paid | Turns a finished session into a reviewer checklist, with the fix-it prompt. |
| [`custom-laws`](custom-laws/SKILL.md) | Paid | Writes laws for a team's own codebase rules. The consulting doorway. |

The free skill mentions the paid ones; every paid skill links back to the free
one. All four use `npx orunmila`, so they work without a clone.

**Testing a skill:** copy its folder into `~/.claude/skills/`, start a new
Claude Code session, and use one of its trigger phrases. Confirm it loads and
runs end to end before listing it anywhere.
